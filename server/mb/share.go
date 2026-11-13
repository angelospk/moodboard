package mb

import (
	"bytes"
	"crypto/subtle"
	"io"
	"net/http"
	"path"
	"strconv"
	"sync/atomic"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

// Public boards. When a project has "public" on, anyone with /s/<project id> reads that one project:
// name, description, its inspirations (without owner fields; notes, regions, tags/level and sources as
// the owner chose), the saved layout, and the images through a project-scoped route. The owner sets
// the flags through the normal projects API. Nothing here writes.

const shareThumb = "480x0"

func bindShare(se *core.ServeEvent) {
	se.Router.GET("/api/mb/public/{project}", handlePublicBoard)
	se.Router.GET("/api/mb/public/{project}/files/{id}", handlePublicFile)
	se.Router.GET("/api/mb/public/{project}/files/{id}/src", handlePublicSrc)
}

// publicProject returns the project when it exists and is public; nil otherwise.
func publicProject(app core.App, id string) *core.Record {
	p, err := app.FindRecordById("projects", id)
	if err != nil || !p.GetBool("public") {
		return nil
	}
	return p
}

func publicNotFound(e *core.RequestEvent) error {
	return e.NotFoundError(tr(e.Request, "Το board δεν είναι δημόσιο.", "The board is not public."), nil)
}

func handlePublicBoard(e *core.RequestEvent) error {
	p := publicProject(e.App, e.Request.PathValue("project"))
	if p == nil {
		return publicNotFound(e)
	}
	owner := p.GetString("user_id")
	hideNotes, hideRegions, hideTags, showSources := p.GetBool("share_hide_notes"), p.GetBool("share_hide_regions"),
		p.GetBool("share_hide_tags"), p.GetBool("share_show_sources")

	rows, err := e.App.FindRecordsByFilter("inspirations", "project_id = {:p} && user_id = {:u}", "-created_at", 0, 0,
		dbx.Params{"p": p.Id, "u": owner})
	if err != nil {
		return e.InternalServerError("", err)
	}
	items := make([]map[string]any, 0, len(rows))
	lv := levelNames(e.App, owner)
	nodes := map[string]bool{} // layout keys that may show: this board's cards and shown tags
	for _, r := range rows {
		item := map[string]any{
			"id": r.Id,
			// Not the stored file name: with the public image bucket it is the key to the original.
			"image":      r.Id,
			"crop":       r.Get("crop"),
			"note":       "",
			"tags":       []string{},
			"level":      "",
			"regions":    []any{},
			"created_at": r.GetDateTime("created_at"),
			"updated_at": r.GetDateTime("updated_at"),
		}
		nodes["i:"+r.Id] = true
		if !hideNotes {
			item["note"] = r.GetString("note")
		}
		if !hideRegions {
			item["regions"] = r.Get("regions")
		}
		if !hideTags {
			tags := stringList(r.Get("tags"))
			item["tags"], item["level"] = tags, lv[r.GetString("level")]
			for _, t := range tags {
				nodes["t:"+t] = true
			}
		}
		if showSources {
			item["source_url"], item["source_title"] = r.GetString("source_url"), r.GetString("source_title")
		}
		items = append(items, item)
	}
	pos, err := e.App.FindRecordsByFilter("map_positions", "user_id = {:u} && scope = {:s}", "", 0, 0,
		dbx.Params{"u": owner, "s": p.Id})
	if err != nil {
		return e.InternalServerError("", err)
	}
	positions := make(map[string]map[string]float64, len(pos))
	for _, r := range pos {
		if nodes[r.GetString("node_key")] {
			positions[r.GetString("node_key")] = map[string]float64{"x": r.GetFloat("x"), "y": r.GetFloat("y")}
		}
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(http.StatusOK, map[string]any{
		"project":      map[string]any{"name": p.GetString("name"), "description": p.GetString("description")},
		"inspirations": items,
		"positions":    positions,
	})
}

// publicImage returns the inspiration of the request's public board that has an image; nil otherwise.
func publicImage(e *core.RequestEvent) *core.Record {
	p := publicProject(e.App, e.Request.PathValue("project"))
	if p == nil {
		return nil
	}
	r, err := e.App.FindRecordById("inspirations", e.Request.PathValue("id"))
	if err != nil || r.GetString("project_id") != p.Id || r.GetString("user_id") != p.GetString("user_id") || r.GetString("image") == "" {
		return nil
	}
	return r
}

// resolveSecret is the shared secret of the Cloudflare Worker (env MB_RESOLVE_SECRET); empty = off.
var resolveSecret atomic.Value

// EnableResolver turns the storage-key route on with this secret ("" turns it off).
func EnableResolver(secret string) { resolveSecret.Store(secret) }

// handlePublicSrc tells the Cloudflare Worker where an image of a public board is stored, so the Worker
// can resize it from the image bucket and the bytes never cross the home connection. The key is the way
// to the original (it still holds GPS and camera data), so only a caller with the shared secret gets it:
// a visitor, a wrong secret, a secret in the URL and a server without a secret all get the plain 404.
// The board check runs on every call, so a board turned private stops here at once.
func handlePublicSrc(e *core.RequestEvent) error {
	secret, _ := resolveSecret.Load().(string)
	got := e.Request.Header.Get("X-MB-Resolve")
	if secret == "" || subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 {
		return publicNotFound(e)
	}
	r := publicImage(e)
	if r == nil {
		return publicNotFound(e)
	}
	fsys, err := e.App.NewFilesystem()
	if err != nil {
		return e.InternalServerError("", err)
	}
	defer fsys.Close()
	// The thumbnail only if it exists: making one here would wait for the decode slot.
	thumb := thumbKeyOf(r)
	if ok, _ := fsys.Exists(thumb); !ok {
		thumb = ""
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(http.StatusOK, map[string]string{"key": r.BaseFilesPath() + "/" + r.GetString("image"), "thumb": thumb})
}

// handlePublicFile serves one image of a public board (?thumb=480x0 for the card thumbnail).
func handlePublicFile(e *core.RequestEvent) error {
	r := publicImage(e)
	if r == nil {
		return publicNotFound(e)
	}
	fsys, err := e.App.NewFilesystem()
	if err != nil {
		return e.InternalServerError("", err)
	}
	defer fsys.Close()
	name := r.GetString("image")
	key := r.BaseFilesPath() + "/" + name
	// The download name is neutral: the stored name is the key to the original in the image bucket.
	download := "image" + path.Ext(name)
	if e.Request.URL.Query().Get("thumb") == shareThumb {
		thumb := thumbKeyOf(r)
		_, _ = ensureThumb(e.App, r, e.Request.Context().Done())
		if ok, _ := fsys.Exists(thumb); ok {
			key = thumb
		}
	}
	// Browsers may reuse the file for 1 minute without asking, so turning the board private stops
	// it within a minute (the Cloudflare Worker in worker/ keeps the same 1 minute). The board JSON stays no-store and stops at once.
	e.Response.Header().Set("Cache-Control", "private, max-age=60")
	e.Response.Header().Del("X-Frame-Options")
	// An original image (not the re-encoded thumbnail) may hold GPS, camera data or a second picture:
	// serve JPEG, PNG and WebP without it. The format comes from the file's first bytes, not its name.
	if key == r.BaseFilesPath()+"/"+r.GetString("image") {
		if served, err := serveClean(e, fsys, key); served {
			return err
		}
	}
	if err := fsys.Serve(e.Response, e.Request, key, download); err != nil {
		return publicNotFound(e)
	}
	return nil
}

// cleanSlots limits how many originals are read into memory to be cleaned at once (up to 10 MB each).
var cleanSlots = make(chan struct{}, 2)

// serveClean writes the file at key without its metadata. It reports false, and writes nothing,
// when the file is not a format StripImageMeta cleans, so the caller serves it the normal way.
func serveClean(e *core.RequestEvent, fsys *filesystem.System, key string) (bool, error) {
	rd, err := fsys.GetReader(key)
	if err != nil {
		return true, publicNotFound(e) // fail closed: never fall back to serving the file unfiltered
	}
	defer rd.Close()
	head := make([]byte, 12)
	n, err := io.ReadFull(rd, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return true, publicNotFound(e)
	}
	if !IsStrippable(head[:n]) {
		return false, nil
	}
	select {
	case cleanSlots <- struct{}{}:
		defer func() { <-cleanSlots }()
	case <-e.Request.Context().Done():
		return true, publicNotFound(e)
	}
	clean, err := StripImageMeta(io.MultiReader(bytes.NewReader(head[:n]), rd))
	if err != nil {
		return true, publicNotFound(e) // never serve a half-cleaned original
	}
	body, _ := io.ReadAll(clean)
	e.Response.Header().Set("Content-Type", http.DetectContentType(body))
	e.Response.Header().Set("Content-Length", strconv.Itoa(len(body)))
	e.Response.WriteHeader(http.StatusOK)
	_, _ = e.Response.Write(body)
	return true, nil
}
