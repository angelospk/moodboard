package mb

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"regexp"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Read-only share links. The owner makes one link per project (a new one replaces the old) and can
// revoke it. Anyone with the link reads that one project: name, description, its inspirations
// (without owner or source fields), the saved layout, and the images through a token-scoped route.
// The raw token (32 random bytes, base64url) is shown once; only its SHA-256 is stored.

const shareThumb = "480x0"

var shareTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func bindShare(se *core.ServeEvent) {
	own := se.Router.Group("/api/mb/projects/{id}/share")
	own.Bind(apis.RequireAuth("users"))
	own.GET("", handleShareStatus)
	own.POST("", handleShareCreate)
	own.DELETE("", handleShareRevoke)

	se.Router.GET(sharedPrefix+"{token}", handleSharedBoard)
	se.Router.GET(sharedPrefix+"{token}/files/{id}", handleSharedFile)
	// Just inside the activity logger, so every outcome (429, 404, 405) is logged without the token.
	se.Router.Bind(&hook.Handler[*core.RequestEvent]{
		Id:       "mbRedactShareToken",
		Priority: apis.DefaultActivityLoggerMiddlewarePriority + 1,
		Func:     redactShareToken,
	})
}

const sharedPrefix = "/api/mb/shared/"

// redactShareToken hides the raw token from the request log, which reads the URL after the handler.
func redactShareToken(e *core.RequestEvent) error {
	err := e.Next()
	if rest, ok := strings.CutPrefix(e.Request.URL.Path, sharedPrefix); ok {
		u := *e.Request.URL
		u.Path = sharedPrefix + "(token)"
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			u.Path += rest[i:]
		}
		u.RawPath = ""
		e.Request.URL = &u
	}
	return err
}

func hashShareToken(tok string) string {
	h := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(h[:])
}

// ownedProject returns the project when userId owns it.
func ownedProject(app core.App, userId, id string) (*core.Record, error) {
	p, err := app.FindRecordById("projects", id)
	if err != nil || p.GetString("user_id") != userId {
		return nil, errNotFound
	}
	return p, nil
}

func projectShare(app core.App, projectId string) *core.Record {
	r, err := app.FindFirstRecordByData("shares", "project_id", projectId)
	if err != nil {
		return nil
	}
	return r
}

// CreateShare makes a new link for the user's project, replacing any old one, and returns the token.
func CreateShare(app core.App, userId, projectId string) (string, error) {
	if _, err := ownedProject(app, userId, projectId); err != nil {
		return "", err
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tok := base64.RawURLEncoding.EncodeToString(b)
	err := app.RunInTransaction(func(tx core.App) error {
		r := projectShare(tx, projectId)
		if r == nil {
			c, err := tx.FindCollectionByNameOrId("shares")
			if err != nil {
				return err
			}
			r = core.NewRecord(c)
			r.Set("user_id", userId)
			r.Set("project_id", projectId)
		}
		r.Set("token_hash", hashShareToken(tok))
		r.Set("created_at", types.NowDateTime())
		return tx.Save(r)
	})
	return tok, err
}

func handleShareCreate(e *core.RequestEvent) error {
	tok, err := CreateShare(e.App, e.Auth.Id, e.Request.PathValue("id"))
	if err == errNotFound {
		return e.NotFoundError("Το project δεν βρέθηκε.", nil)
	}
	if err != nil {
		return e.BadRequestError("Ο σύνδεσμος δεν δημιουργήθηκε.", err)
	}
	return e.JSON(http.StatusOK, map[string]string{"token": tok})
}

func handleShareStatus(e *core.RequestEvent) error {
	pid := e.Request.PathValue("id")
	if _, err := ownedProject(e.App, e.Auth.Id, pid); err != nil {
		return e.NotFoundError("Το project δεν βρέθηκε.", nil)
	}
	out := map[string]any{"active": false}
	if r := projectShare(e.App, pid); r != nil {
		out["active"] = true
		out["created_at"] = r.GetDateTime("created_at")
	}
	return e.JSON(http.StatusOK, out)
}

func handleShareRevoke(e *core.RequestEvent) error {
	pid := e.Request.PathValue("id")
	if _, err := ownedProject(e.App, e.Auth.Id, pid); err != nil {
		return e.NotFoundError("Το project δεν βρέθηκε.", nil)
	}
	if r := projectShare(e.App, pid); r != nil {
		if err := e.App.Delete(r); err != nil {
			return e.BadRequestError("Ο σύνδεσμος δεν ανακλήθηκε.", err)
		}
	}
	return e.NoContent(http.StatusNoContent)
}

// sharedProject resolves a token to its live share and project; nil when the link is unknown.
func sharedProject(app core.App, tok string) (share, project *core.Record) {
	if !shareTokenRe.MatchString(tok) {
		return nil, nil
	}
	s, err := app.FindFirstRecordByData("shares", "token_hash", hashShareToken(tok))
	if err != nil {
		return nil, nil
	}
	p, err := ownedProject(app, s.GetString("user_id"), s.GetString("project_id"))
	if err != nil {
		return nil, nil
	}
	return s, p
}

func sharedNotFound(e *core.RequestEvent) error {
	return e.NotFoundError("Ο σύνδεσμος δεν ισχύει.", nil)
}

func handleSharedBoard(e *core.RequestEvent) error {
	s, p := sharedProject(e.App, e.Request.PathValue("token"))
	if s == nil {
		return sharedNotFound(e)
	}
	owner := s.GetString("user_id")
	rows, err := e.App.FindRecordsByFilter("inspirations", "project_id = {:p} && user_id = {:u}", "-created_at", 0, 0,
		dbx.Params{"p": p.Id, "u": owner})
	if err != nil {
		return e.InternalServerError("", err)
	}
	items := make([]map[string]any, 0, len(rows))
	nodes := map[string]bool{} // position keys of what is on this board now
	for _, r := range rows {
		nodes["i:"+r.Id] = true
		for _, t := range stringList(r.Get("tags")) {
			nodes["t:"+t] = true
		}
		items = append(items, map[string]any{
			"id":         r.Id,
			"image":      r.GetString("image"),
			"note":       r.GetString("note"),
			"tags":       r.Get("tags"),
			"level":      r.GetString("level"),
			"regions":    r.Get("regions"),
			"crop":       r.Get("crop"),
			"created_at": r.GetDateTime("created_at"),
			"updated_at": r.GetDateTime("updated_at"),
		})
	}
	pos, err := e.App.FindRecordsByFilter("map_positions", "user_id = {:u} && scope = {:s}", "", 0, 0,
		dbx.Params{"u": owner, "s": p.Id})
	if err != nil {
		return e.InternalServerError("", err)
	}
	positions := make(map[string]map[string]float64, len(pos))
	for _, r := range pos {
		if !nodes[r.GetString("node_key")] {
			continue // a card that moved away or an old tag: not part of this board
		}
		positions[r.GetString("node_key")] = map[string]float64{"x": r.GetFloat("x"), "y": r.GetFloat("y")}
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(http.StatusOK, map[string]any{
		"project":      map[string]string{"name": p.GetString("name"), "description": p.GetString("description")},
		"inspirations": items,
		"positions":    positions,
	})
}

// handleSharedFile serves one image of the shared project (?thumb=480x0 for the card thumbnail).
func handleSharedFile(e *core.RequestEvent) error {
	s, p := sharedProject(e.App, e.Request.PathValue("token"))
	if s == nil {
		return sharedNotFound(e)
	}
	r, err := e.App.FindRecordById("inspirations", e.Request.PathValue("id"))
	if err != nil || r.GetString("project_id") != p.Id || r.GetString("user_id") != s.GetString("user_id") || r.GetString("image") == "" {
		return sharedNotFound(e)
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
	// Browsers may keep the file but must ask again on each use (a cheap 304), so a revoked link stops at once.
	e.Response.Header().Set("Cache-Control", "private, no-cache")
	e.Response.Header().Del("X-Frame-Options")
	if err := fsys.Serve(e.Response, e.Request, key, name); err != nil {
		return sharedNotFound(e)
	}
	return nil
}
