package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// suggestion: level and tags proposed by the user's own AI (MCP tool suggest_labels), as
// {"level": "...", "tags": [...]}. They wait there until the user accepts or dismisses them in the
// web app; level and tags change only on accept.
func init() {
	m.Register(func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		c.Fields.Add(&core.JSONField{Name: "suggestion", MaxSize: 5000})
		return app.Save(c)
	}, func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		c.Fields.RemoveByName("suggestion")
		return app.Save(c)
	})
}
