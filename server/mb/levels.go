package mb

import (
	"fmt"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"moodboard/server/migrations"
)

// Levels are per user (collection "levels"); inspirations.level holds a level id. The MCP tools and
// the public board speak in level names, so these helpers translate.

// seedLevels gives a new user the default levels.
func seedLevels(e *core.RecordEvent) error {
	if _, err := migrations.SeedLevels(e.App, e.Record.Id); err != nil {
		return err
	}
	return e.Next()
}

// checkLevel runs on create and update of a level, in one transaction so two quick requests cannot
// both pass: names are unique per user ignoring case (the database index folds only ASCII, and the
// AI finds a level by name), and a user has at most MaxLevels levels.
func checkLevel(e *core.RecordRequestEvent) error {
	name := strings.TrimSpace(e.Record.GetString("name"))
	e.Record.Set("name", name)
	if e.HasSuperuserAuth() || e.Auth == nil {
		return e.Next()
	}
	return e.App.RunInTransaction(func(tx core.App) error {
		rs, err := tx.FindRecordsByFilter("levels", "user_id = {:u}", "", 0, 0, dbx.Params{"u": e.Auth.Id})
		if err != nil {
			return err
		}
		if e.Record.IsNew() && len(rs) >= migrations.MaxLevels {
			return e.BadRequestError(fmt.Sprintf(tr(e.Request, "Το πολύ %d επίπεδα.", "At most %d levels."), migrations.MaxLevels), nil)
		}
		for _, r := range rs {
			if r.Id != e.Record.Id && strings.EqualFold(r.GetString("name"), name) {
				return e.BadRequestError(tr(e.Request, "Υπάρχει ήδη επίπεδο με αυτό το όνομα.", "A level with this name already exists."), nil)
			}
		}
		e.App = tx
		return e.Next()
	})
}

// checkLevelOwner rejects an inspiration whose level belongs to another user.
func checkLevelOwner(e *core.RecordRequestEvent) error {
	if e.HasSuperuserAuth() || e.Auth == nil {
		return e.Next()
	}
	if lid := e.Record.GetString("level"); lid != "" {
		l, err := e.App.FindRecordById("levels", lid)
		if err != nil || l.GetString("user_id") != e.Auth.Id {
			return e.BadRequestError(tr(e.Request, "Το επίπεδο δεν ανήκει στον χρήστη.", "The level does not belong to the user."), nil)
		}
	}
	return e.Next()
}

// levelNames maps the user's level ids to their names.
func levelNames(app core.App, uid string) map[string]string {
	out := map[string]string{}
	rs, err := app.FindRecordsByFilter("levels", "user_id = {:u}", "position", 0, 0, dbx.Params{"u": uid})
	if err == nil {
		for _, r := range rs {
			out[r.Id] = r.GetString("name")
		}
	}
	return out
}

// resolveLevel finds the user's level by id or case-insensitive name.
func resolveLevel(app core.App, uid, ref string) (*core.Record, error) {
	ref = strings.TrimSpace(ref)
	if r, err := app.FindRecordById("levels", ref); err == nil && r.GetString("user_id") == uid {
		return r, nil
	}
	rs, err := app.FindRecordsByFilter("levels", "user_id = {:u}", "position", 0, 0, dbx.Params{"u": uid})
	if err == nil {
		for _, r := range rs {
			if strings.EqualFold(r.GetString("name"), ref) {
				return r, nil
			}
		}
	}
	return nil, fmt.Errorf("unknown level: %q (see list_levels)", ref)
}

// listLevels is the MCP view of the user's levels, in order.
func listLevels(app core.App, uid string) []map[string]any {
	rs, _ := app.FindRecordsByFilter("levels", "user_id = {:u}", "position", 0, 0, dbx.Params{"u": uid})
	out := make([]map[string]any, 0, len(rs))
	for _, r := range rs {
		out = append(out, map[string]any{"id": r.Id, "name": r.GetString("name")})
	}
	return out
}
