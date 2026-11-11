package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// Read-only share links: at most one per project. Only the SHA-256 of the token is stored. No API
// rules, so the generic API cannot list or change them; the routes in mb/share.go manage them.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		projects, err := app.FindCollectionByNameOrId("projects")
		if err != nil {
			return err
		}
		c := core.NewBaseCollection("shares", "mbshares")
		c.Fields.Add(
			owner(users.Id),
			&core.RelationField{Name: "project_id", CollectionId: projects.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.TextField{Name: "token_hash", Required: true, Min: 64, Max: 64},
			&core.AutodateField{Name: "created_at", OnCreate: true},
		)
		c.AddIndex("idx_shares_token", true, "token_hash", "")
		c.AddIndex("idx_shares_project", true, "project_id", "")
		return app.Save(c)
	}, func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("shares")
		if err != nil {
			return nil
		}
		return app.Delete(c)
	})
}
