// Package mb adds the Moodboard rules that API rules cannot express (invite codes, project
// ownership, defaults) and the custom routes (tags, atomic note append, bulk map positions, copy,
// MCP). Register binds all of it to an app; main and the tests both call it.
package mb

import (
	"errors"
	"net/http"
	"strings"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// Register binds the hooks and routes to app.
func Register(app core.App) {
	app.OnRecordCreateRequest("users").BindFunc(checkInvite)
	app.OnRecordAfterCreateSuccess("users").BindFunc(seedLevels)
	app.OnRecordCreateRequest("levels").BindFunc(checkLevel)
	app.OnRecordUpdateRequest("levels").BindFunc(checkLevel)
	app.OnRecordCreateRequest("inspirations").BindFunc(checkProjectOwner)
	app.OnRecordUpdateRequest("inspirations").BindFunc(checkProjectOwner)
	app.OnRecordCreateRequest("inspirations").BindFunc(checkLevelOwner)
	app.OnRecordUpdateRequest("inspirations").BindFunc(checkLevelOwner)
	app.OnRecordCreate("inspirations").BindFunc(checkStoreRoom)
	app.OnRecordCreate("inspirations").BindFunc(func(e *core.RecordEvent) error {
		defaultsForInspiration(e.Record)
		return e.Next()
	})
	app.OnRecordValidate("inspirations").BindFunc(func(e *core.RecordEvent) error {
		e.Record.Set("tags", CleanTags(stringList(e.Record.Get("tags"))))
		if !validCrop(e.Record.GetString("crop")) {
			return validation.Errors{"crop": validation.NewError("invalid_crop", "crop must be null or {x, y, w, h} inside 0..1.")}
		}
		return e.Next()
	})
	bindThumbs(app)
	bindSemantic(app)

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		se.Router.BindFunc(thumbOnDemand)
		g := se.Router.Group("/api/mb")
		g.Bind(apis.RequireAuth("users"))
		g.GET("/tags", handleTags)
		g.POST("/suggest", handleSuggest)
		g.POST("/inspirations/{id}/note", handleAppendNote)
		g.POST("/inspirations/{id}/copy", handleCopy)
		g.POST("/positions", handleSavePositions)
		g.POST("/positions/delete", handleDeletePositions)
		bindSemanticRoutes(g)
		bindSummaryRoutes(g)
		bindShare(se)
		bindMCP(se)
		bindOAuth(se)
		return se.Next()
	})

	app.Cron().MustAdd("mbOAuthCleanup", "17 * * * *", func() { cleanupOAuth(app) })
}

// checkInvite lets a user sign up only with a valid invite code ("invite" in the body).
// Superusers (admin UI) create users without one.
func checkInvite(e *core.RecordRequestEvent) error {
	if e.HasSuperuserAuth() {
		return e.Next()
	}
	info, err := e.RequestInfo()
	if err != nil {
		return err
	}
	code, _ := info.Body["invite"].(string)
	code = strings.TrimSpace(code)
	if code == "" {
		return e.BadRequestError(tr(e.Request, "Χρειάζεται κωδικός πρόσκλησης.", "An invite code is required."), nil)
	}
	return e.App.RunInTransaction(func(tx core.App) error {
		inv, err := tx.FindFirstRecordByData("invites", "code", code)
		if err != nil || inv.GetInt("uses_left") <= 0 {
			return e.BadRequestError(tr(e.Request, "Ο κωδικός πρόσκλησης δεν ισχύει.", "The invite code is not valid."), nil)
		}
		inv.Set("uses_left", inv.GetInt("uses_left")-1)
		if err := tx.Save(inv); err != nil {
			return err
		}
		e.App = tx
		return e.Next()
	})
}

// checkProjectOwner rejects an inspiration whose project_id belongs to another user.
func checkProjectOwner(e *core.RecordRequestEvent) error {
	if e.HasSuperuserAuth() || e.Auth == nil {
		return e.Next()
	}
	if pid := e.Record.GetString("project_id"); pid != "" {
		if !ownsProject(e.App, e.Auth.Id, pid) {
			return e.BadRequestError(tr(e.Request, "Το project δεν ανήκει στον χρήστη.", "The project does not belong to the user."), nil)
		}
	}
	return e.Next()
}

func ownsProject(app core.App, userId, projectId string) bool {
	p, err := app.FindRecordById("projects", projectId)
	return err == nil && p.GetString("user_id") == userId
}

func defaultsForInspiration(r *core.Record) {
	if r.Get("tags") == nil || r.GetString("tags") == "null" || r.GetString("tags") == "" {
		r.Set("tags", []string{})
	}
	if r.Get("regions") == nil || r.GetString("regions") == "null" || r.GetString("regions") == "" {
		r.Set("regions", []any{})
	}
}

// CleanTags trims, lowercases and dedupes tags and keeps at most 30 (same as the web client).
func CleanTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range tags {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) == 30 {
			break
		}
	}
	return out
}

// stringList reads a JSON field value (types.JSONRaw, []any, []string) as strings.
func stringList(v any) []string {
	var raw []any
	switch x := v.(type) {
	case []string:
		return x
	case []any:
		raw = x
	default:
		var out []any
		if s, ok := v.(interface{ String() string }); ok && s.String() != "" && s.String() != "null" {
			_ = jsonUnmarshal([]byte(s.String()), &out)
		}
		raw = out
	}
	res := make([]string, 0, len(raw))
	for _, a := range raw {
		if s, ok := a.(string); ok {
			res = append(res, s)
		}
	}
	return res
}

var errNotFound = errors.New("not found")

// validCrop accepts no crop, or a rectangle of fractions inside the image, at least 2% each way.
func validCrop(raw string) bool {
	if raw == "" || raw == "null" {
		return true
	}
	var c struct{ X, Y, W, H *float64 }
	if jsonUnmarshal([]byte(raw), &c) != nil || c.X == nil || c.Y == nil || c.W == nil || c.H == nil {
		return false
	}
	const eps = 1e-6
	return *c.X >= 0 && *c.Y >= 0 && *c.W >= 0.02 && *c.H >= 0.02 && *c.X+*c.W <= 1+eps && *c.Y+*c.H <= 1+eps
}

func notFound(e *core.RequestEvent) error {
	return e.Error(http.StatusNotFound, tr(e.Request, "Η εικόνα δεν βρέθηκε.", "Image not found."), nil)
}
