package mb

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

var jsonUnmarshal = json.Unmarshal

// UserTags returns the user's distinct tags, most used first.
func UserTags(app core.App, userId string) ([]string, error) {
	var rows []struct {
		Tag string `db:"tag"`
	}
	err := app.DB().NewQuery(`
		SELECT j.value AS tag, count(*) AS uses
		FROM inspirations i, json_each(CASE WHEN json_valid(i.tags) THEN i.tags ELSE '[]' END) j
		WHERE i.user_id = {:uid} AND j.type = 'text'
		GROUP BY j.value ORDER BY uses DESC, tag`).Bind(dbx.Params{"uid": userId}).All(&rows)
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Tag
	}
	return out, err
}

func handleTags(e *core.RequestEvent) error {
	tags, err := UserTags(e.App, e.Auth.Id)
	if err != nil {
		return e.InternalServerError("", err)
	}
	return e.JSON(http.StatusOK, tags)
}

// AppendNote adds text to an inspiration's note in one transaction (no lost update).
func AppendNote(app core.App, userId, id, text string) (*core.Record, error) {
	text = strings.TrimSpace(text)
	var out *core.Record
	err := app.RunInTransaction(func(tx core.App) error {
		r, err := tx.FindRecordById("inspirations", id)
		if err != nil || r.GetString("user_id") != userId {
			return errNotFound
		}
		if note := r.GetString("note"); note == "" {
			r.Set("note", text)
		} else {
			r.Set("note", note+"\n\n"+text)
		}
		out = r
		return tx.Save(r)
	})
	return out, err
}

func handleAppendNote(e *core.RequestEvent) error {
	var body struct {
		Text string `json:"text"`
	}
	if err := e.BindBody(&body); err != nil || strings.TrimSpace(body.Text) == "" || utf8.RuneCountInString(body.Text) > 5000 {
		return e.BadRequestError(tr(e.Request, "Το κείμενο λείπει ή είναι πολύ μεγάλο.", "The text is missing or too long."), nil)
	}
	r, err := AppendNote(e.App, e.Auth.Id, e.Request.PathValue("id"), body.Text)
	if err == errNotFound {
		return notFound(e)
	}
	if err != nil {
		return e.BadRequestError(tr(e.Request, "Αποτυχία αποθήκευσης.", "Could not save."), err)
	}
	return e.JSON(http.StatusOK, map[string]string{"id": r.Id, "note": r.GetString("note")})
}

// CopyInspiration duplicates an inspiration (image file too) into projectId ("" = no project).
func CopyInspiration(app core.App, userId, id, projectId string) (*core.Record, error) {
	src, err := app.FindRecordById("inspirations", id)
	if err != nil || src.GetString("user_id") != userId {
		return nil, errNotFound
	}
	if projectId != "" && !ownsProject(app, userId, projectId) {
		return nil, errNotFound
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return nil, err
	}
	defer fsys.Close()
	file, err := fsys.GetReuploadableFile(src.BaseFilesPath()+"/"+src.GetString("image"), false)
	if err != nil {
		return nil, err
	}
	dst := core.NewRecord(src.Collection())
	for _, f := range []string{"user_id", "note", "tags", "level", "regions", "source_url", "source_title", "image_url", "crop"} {
		dst.Set(f, src.Get(f))
	}
	dst.Set("project_id", projectId)
	dst.Set("image", file)
	return dst, app.Save(dst)
}

func handleCopy(e *core.RequestEvent) error {
	var body struct {
		ProjectId *string `json:"project_id"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("", err)
	}
	pid := ""
	if body.ProjectId != nil {
		pid = *body.ProjectId
	}
	r, err := CopyInspiration(e.App, e.Auth.Id, e.Request.PathValue("id"), pid)
	if err == errNotFound {
		return notFound(e)
	}
	if err != nil {
		// Keep a refusal such as «storage full» (413) instead of turning it into a generic 400.
		var ae *router.ApiError
		if errors.As(err, &ae) {
			return ae
		}
		return e.BadRequestError(tr(e.Request, "Αποτυχία αντιγραφής.", "Could not copy."), err)
	}
	return e.JSON(http.StatusOK, map[string]string{"id": r.Id})
}

type position struct {
	Key string  `json:"key"`
	X   float64 `json:"x"`
	Y   float64 `json:"y"`
}

// SavePositions upserts node positions of one map scope for the user.
func SavePositions(app core.App, userId, scope string, ps []position) error {
	coll, err := app.FindCollectionByNameOrId("map_positions")
	if err != nil {
		return err
	}
	return app.RunInTransaction(func(tx core.App) error {
		for _, p := range ps {
			if math.IsNaN(p.X) || math.IsInf(p.X, 0) || math.IsNaN(p.Y) || math.IsInf(p.Y, 0) {
				continue
			}
			r, err := tx.FindFirstRecordByFilter(coll, "user_id = {:u} && scope = {:s} && node_key = {:k}",
				dbx.Params{"u": userId, "s": scope, "k": p.Key})
			if err != nil {
				r = core.NewRecord(coll)
				r.Set("user_id", userId)
				r.Set("scope", scope)
				r.Set("node_key", p.Key)
			} else if r.GetFloat("x") == p.X && r.GetFloat("y") == p.Y {
				continue // unchanged: no write, no realtime event
			}
			r.Set("x", p.X)
			r.Set("y", p.Y)
			if err := tx.Save(r); err != nil {
				return err
			}
		}
		return nil
	})
}

func handleSavePositions(e *core.RequestEvent) error {
	var body struct {
		Scope     string     `json:"scope"`
		Positions []position `json:"positions"`
	}
	if err := e.BindBody(&body); err != nil || body.Scope == "" || len(body.Scope) > 64 || len(body.Positions) > 5000 {
		return e.BadRequestError(tr(e.Request, "Λάθος δεδομένα θέσεων.", "Invalid positions."), nil)
	}
	if err := SavePositions(e.App, e.Auth.Id, body.Scope, body.Positions); err != nil {
		return e.BadRequestError(tr(e.Request, "Οι θέσεις δεν αποθηκεύτηκαν.", "The positions were not saved."), err)
	}
	return e.NoContent(http.StatusNoContent)
}

// DeletePositions removes node positions, in one scope or (scope "") in every scope.
func DeletePositions(app core.App, userId, scope string, keys []string) error {
	filter := "user_id = {:u} && node_key = {:k}"
	if scope != "" {
		filter += " && scope = {:s}"
	}
	return app.RunInTransaction(func(tx core.App) error {
		for _, key := range keys {
			rs, err := tx.FindRecordsByFilter("map_positions", filter, "", 0, 0, dbx.Params{"u": userId, "k": key, "s": scope})
			if err != nil {
				return err
			}
			for _, r := range rs {
				if err := tx.Delete(r); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func handleDeletePositions(e *core.RequestEvent) error {
	var body struct {
		Scope string   `json:"scope"`
		Key   string   `json:"key"`
		Keys  []string `json:"keys"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("", err)
	}
	keys := body.Keys
	if body.Key != "" {
		keys = append(keys, body.Key)
	}
	if len(keys) == 0 || len(keys) > 5000 {
		return e.BadRequestError(tr(e.Request, "Λείπει το key.", "The key is missing."), nil)
	}
	if err := DeletePositions(e.App, e.Auth.Id, body.Scope, keys); err != nil {
		return e.BadRequestError(tr(e.Request, "Η θέση δεν σβήστηκε.", "The position was not removed."), err)
	}
	return e.NoContent(http.StatusNoContent)
}
