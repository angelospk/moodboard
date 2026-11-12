package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// Archive: a project the owner put away. It keeps its images; the app hides it from the project
// list and the pickers until it is restored. The owner sets it through the normal projects API.
func init() {
	m.Register(func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("projects")
		if err != nil {
			return err
		}
		c.Fields.Add(&core.BoolField{Name: "archived"})
		return app.Save(c)
	}, nil)
}
