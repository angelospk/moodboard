package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// users.ai_enabled: the user agreed that new images are sent to Google Gemini to suggest a level and
// tags (off by default). The user can change only their own row (PocketBase's default users rule).
func init() {
	m.Register(func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		c.Fields.Add(&core.BoolField{Name: "ai_enabled"})
		return app.Save(c)
	}, func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		c.Fields.RemoveByName("ai_enabled")
		return app.Save(c)
	})
}
