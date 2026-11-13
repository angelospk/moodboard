package mb

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Public boards. When a project has "public" on, anyone with /s/<project id> reads that one project:
// name, description, its inspirations (without owner fields; notes, regions, tags/level and sources as
// the owner chose), the saved layout, and the images through a project-scoped route. The owner sets
// the flags through the normal projects API. Nothing here writes.

const shareThumb = "480x0"

func bindShare(se *core.ServeEvent) {
	se.Router.GET("/api/mb/public/{project}", handlePublicBoard)
	se.Router.GET("/api/mb/public/{project}/files/{id}", handlePublicFile)
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
			"id":         r.Id,
			"image":      r.GetString("image"),
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

// handlePublicFile serves one image of a public board (?thumb=480x0 for the card thumbnail).
func handlePublicFile(e *core.RequestEvent) error {
	p := publicProject(e.App, e.Request.PathValue("project"))
	if p == nil {
		return publicNotFound(e)
	}
	r, err := e.App.FindRecordById("inspirations", e.Request.PathValue("id"))
	if err != nil || r.GetString("project_id") != p.Id || r.GetString("user_id") != p.GetString("user_id") || r.GetString("image") == "" {
		return publicNotFound(e)
	}
	fsys, err := e.App.NewFilesystem()
	if err != nil {
		return e.InternalServerError("", err)
	}
	defer fsys.Close()
	name := r.GetString("image")
	key := r.BaseFilesPath() + "/" + name
	if e.Request.URL.Query().Get("thumb") == shareThumb {
		thumb := r.BaseFilesPath() + "/thumbs_" + name + "/" + shareThumb + "_" + name
		if ok, _ := fsys.Exists(thumb); ok || fsys.CreateThumb(key, thumb, shareThumb) == nil {
			key, name = thumb, shareThumb+"_"+name
		}
	}
	// Browsers may reuse the file for 5 minutes without asking, so turning the board private stops
	// it within 5 minutes. The board JSON stays no-store and stops at once.
	e.Response.Header().Set("Cache-Control", "private, max-age=300")
	e.Response.Header().Del("X-Frame-Options")
	if err := fsys.Serve(e.Response, e.Request, key, name); err != nil {
		return publicNotFound(e)
	}
	return nil
}
