package migrations

import (
	"encoding/json"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// DefaultLevels are the levels a new account starts with, in order. The user edits them freely.
// They line up with Levels (the fixed keys the first schema used).
var DefaultLevels = []string{"Αστικό", "Κτίριο", "Εσωτερικό", "Λεπτομέρεια", "Υλικό"}

// MaxLevels is how many levels one user may have.
const MaxLevels = 50

// SeedLevels gives the user the default levels when they have none. It returns the new ids by
// default name.
func SeedLevels(app core.App, userId string) (map[string]string, error) {
	n, err := app.CountRecords("levels", dbx.HashExp{"user_id": userId})
	if err != nil || n > 0 {
		return nil, err
	}
	coll, err := app.FindCollectionByNameOrId("levels")
	if err != nil {
		return nil, err
	}
	ids := map[string]string{}
	for i, name := range DefaultLevels {
		r := core.NewRecord(coll)
		r.Set("user_id", userId)
		r.Set("name", name)
		r.Set("position", i)
		if err := app.Save(r); err != nil {
			return nil, err
		}
		ids[name] = r.Id
	}
	return ids, nil
}

// Levels per user ("επίπεδα"): a user-defined, ordered list. inspirations.level points at one of
// them; deleting a level clears it on the images. Existing users get the default levels and their
// images keep their level.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		levels := core.NewBaseCollection("levels", "mblevels")
		levels.ListRule, levels.ViewRule = types.Pointer(own), types.Pointer(own)
		levels.CreateRule, levels.UpdateRule = types.Pointer(own), types.Pointer(own+" && @request.body.user_id:isset = false")
		levels.DeleteRule = types.Pointer(own)
		levels.Fields.Add(
			owner(users.Id),
			&core.TextField{Name: "name", Required: true, Max: 40},
			&core.NumberField{Name: "position", OnlyInt: true},
			&core.AutodateField{Name: "created_at", OnCreate: true},
		)
		levels.AddIndex("idx_levels_user_name", true, "user_id, name COLLATE NOCASE", "")
		if err := app.Save(levels); err != nil {
			return err
		}

		// Seed every existing user and remember which id replaces which old key.
		all, err := app.FindAllRecords("users")
		if err != nil {
			return err
		}
		byUser := map[string]map[string]string{} // user id -> old key -> level id
		for _, u := range all {
			ids, err := SeedLevels(app, u.Id)
			if err != nil {
				return err
			}
			keys := map[string]string{}
			for i, key := range Levels {
				keys[key] = ids[DefaultLevels[i]]
			}
			byUser[u.Id] = keys
		}

		// Swap the select for a relation: add it under a temporary name, copy, drop the old one, rename.
		ins, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		ins.Fields.Add(&core.RelationField{Name: "level_new", CollectionId: levels.Id, MaxSelect: 1})
		if err := app.Save(ins); err != nil {
			return err
		}
		// Plain SQL: it keeps updated_at, which the app shows as "last changed".
		rows, err := app.FindAllRecords("inspirations")
		if err != nil {
			return err
		}
		for _, r := range rows {
			keys := byUser[r.GetString("user_id")]
			set := dbx.Params{}
			if id := keys[r.GetString("level")]; id != "" {
				set["level_new"] = id
			}
			// A pending AI suggestion holds the old key too.
			var sg struct {
				Level string   `json:"level"`
				Tags  []string `json:"tags"`
			}
			if r.UnmarshalJSONField("suggestion", &sg) == nil && sg.Level != "" {
				if id := keys[sg.Level]; id != "" {
					sg.Level = id
				} else {
					sg.Level = ""
				}
				b, _ := json.Marshal(map[string]any{"level": nilIfEmpty(sg.Level), "tags": sg.Tags})
				set["suggestion"] = string(b)
			}
			if len(set) > 0 {
				if _, err := app.DB().Update("inspirations", set, dbx.HashExp{"id": r.Id}).Execute(); err != nil {
					return err
				}
			}
		}
		ins, err = app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		ins.Fields.RemoveByName("level")
		if err := app.Save(ins); err != nil {
			return err
		}
		ins, err = app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		ins.Fields.GetByName("level_new").SetName("level")
		return app.Save(ins)
	}, nil)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
