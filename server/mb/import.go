package mb

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/types"
	"github.com/spf13/cobra"

	"moodboard/server/migrations"
)

// Export is the file `web/scripts/export-supabase.ts` writes (export.json + files/).
type Export struct {
	Users []struct {
		ID           string `json:"id"`
		Email        string `json:"email"`
		PasswordHash string `json:"password_hash"`
	} `json:"users"`
	Projects []struct {
		ID          string `json:"id"`
		UserID      string `json:"user_id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		CreatedAt   string `json:"created_at"`
	} `json:"projects"`
	Inspirations []struct {
		ID          string          `json:"id"`
		UserID      string          `json:"user_id"`
		ProjectID   *string         `json:"project_id"`
		File        string          `json:"file"` // path relative to the export dir
		SourceURL   *string         `json:"source_url"`
		SourceTitle *string         `json:"source_title"`
		Note        string          `json:"note"`
		Tags        []string        `json:"tags"`
		Level       *string         `json:"level"`
		Regions     json.RawMessage `json:"regions"`
		CreatedAt   string          `json:"created_at"`
	} `json:"inspirations"`
	Positions []struct {
		UserID  string  `json:"user_id"`
		Scope   string  `json:"scope"`
		NodeKey string  `json:"node_key"`
		X       float64 `json:"x"`
		Y       float64 `json:"y"`
	} `json:"map_positions"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Import loads an export into app in one transaction. Ids of projects and inspirations are kept, so
// map node keys stay valid; users are matched by email (created with the same bcrypt hash).
func Import(app core.App, dir string) error {
	raw, err := os.ReadFile(filepath.Join(dir, "export.json"))
	if err != nil {
		return err
	}
	var ex Export
	if err := json.Unmarshal(raw, &ex); err != nil {
		return err
	}
	return app.RunInTransaction(func(tx core.App) error {
		userMap := map[string]string{}
		users, err := tx.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		for _, u := range ex.Users {
			rec, err := tx.FindAuthRecordByEmail("users", u.Email)
			if err != nil {
				rec = core.NewRecord(users)
				rec.SetEmail(u.Email)
				rec.SetVerified(true)
				rec.SetRaw("password", &core.PasswordFieldValue{Hash: u.PasswordHash})
				if err := tx.Save(rec); err != nil {
					return fmt.Errorf("user %s: %w", u.Email, err)
				}
			}
			userMap[u.ID] = rec.Id
		}
		save := func(coll string, set func(r *core.Record) error) error {
			c, err := tx.FindCollectionByNameOrId(coll)
			if err != nil {
				return err
			}
			r := core.NewRecord(c)
			if err := set(r); err != nil {
				return err
			}
			return tx.SaveNoValidate(r)
		}
		// The export names levels by the old fixed keys; they become the user's default levels.
		levelIDs := map[string]map[string]string{} // new user id -> old key -> level id
		for _, uid := range userMap {
			if _, err := migrations.SeedLevels(tx, uid); err != nil {
				return err
			}
			names := levelNames(tx, uid)
			byName := map[string]string{}
			for id, n := range names {
				byName[n] = id
			}
			keys := map[string]string{}
			for i, key := range migrations.Levels {
				keys[key] = byName[migrations.DefaultLevels[i]]
			}
			levelIDs[uid] = keys
		}
		for _, p := range ex.Projects {
			if err := save("projects", func(r *core.Record) error {
				r.Id = p.ID
				r.Set("user_id", userMap[p.UserID])
				r.Set("name", p.Name)
				r.Set("description", p.Description)
				setDate(r, p.CreatedAt)
				return nil
			}); err != nil {
				return fmt.Errorf("project %s: %w", p.ID, err)
			}
		}
		for _, in := range ex.Inspirations {
			if err := save("inspirations", func(r *core.Record) error {
				f, err := filesystem.NewFileFromPath(filepath.Join(dir, in.File))
				if err != nil {
					return err
				}
				r.Id = in.ID
				r.Set("user_id", userMap[in.UserID])
				r.Set("project_id", deref(in.ProjectID))
				r.Set("image", f)
				r.Set("source_url", deref(in.SourceURL))
				r.Set("source_title", deref(in.SourceTitle))
				r.Set("note", in.Note)
				r.Set("tags", CleanTags(in.Tags))
				r.Set("level", levelIDs[userMap[in.UserID]][deref(in.Level)])
				r.Set("regions", in.Regions)
				setDate(r, in.CreatedAt)
				return nil
			}); err != nil {
				return fmt.Errorf("inspiration %s: %w", in.ID, err)
			}
		}
		for _, p := range ex.Positions {
			if err := save("map_positions", func(r *core.Record) error {
				r.Set("user_id", userMap[p.UserID])
				r.Set("scope", p.Scope)
				r.Set("node_key", p.NodeKey)
				r.Set("x", p.X)
				r.Set("y", p.Y)
				return nil
			}); err != nil {
				return fmt.Errorf("position %s/%s: %w", p.Scope, p.NodeKey, err)
			}
		}
		return nil
	})
}

// ImportCommand is `moodboard import <dir>`.
func ImportCommand(app core.App) *cobra.Command {
	return &cobra.Command{
		Use:   "import <dir>",
		Short: "Import a Supabase export (export.json + files/) into an empty Moodboard",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if err := app.Bootstrap(); err != nil {
				return err
			}
			if err := app.RunAllMigrations(); err != nil {
				return err
			}
			return Import(app, args[0])
		},
	}
}

// setDate keeps the original created_at (the autodate field leaves a manually set value alone).
func setDate(r *core.Record, s string) {
	if d, err := types.ParseDateTime(s); err == nil && !d.IsZero() {
		r.SetRaw("created_at", d)
	}
}
