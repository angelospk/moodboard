package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// house_models: the 3D house of a project, as one JSON document. Each project has at most one
// "draft" (autosaved, overwritten) and any number of named "version" rows (kept). The unique index
// on drafts lets the client save concurrently: the second create fails and it updates instead.
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

		c := core.NewBaseCollection("house_models", "mbhouse")
		c.ListRule, c.ViewRule = types.Pointer(own), types.Pointer(own)
		c.CreateRule, c.UpdateRule = types.Pointer(own), types.Pointer(own+" && @request.body.user_id:isset = false")
		c.DeleteRule = types.Pointer(own)
		c.Fields.Add(
			owner(users.Id),
			&core.RelationField{Name: "project_id", CollectionId: projects.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.SelectField{Name: "kind", Values: []string{"draft", "version"}, Required: true, MaxSelect: 1},
			&core.TextField{Name: "name", Max: 120},
			&core.JSONField{Name: "model", MaxSize: 2 << 20},
			&core.AutodateField{Name: "created_at", OnCreate: true},
			&core.AutodateField{Name: "updated_at", OnCreate: true, OnUpdate: true},
		)
		c.AddIndex("idx_house_project", false, "project_id, kind, created_at", "")
		c.AddIndex("idx_house_draft", true, "project_id", "kind = 'draft'")
		return app.Save(c)
	}, func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("house_models")
		if err != nil {
			return err
		}
		return app.Delete(c)
	})
}
