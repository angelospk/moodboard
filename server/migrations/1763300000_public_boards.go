package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// Public boards: anyone with /s/<project id> sees the board when "public" is on. The owner picks what
// shows; every flag is false by default, so the default view has notes, region notes, tags and level,
// and no sources. The owner changes them through the normal projects API (owner-only rules).
func init() {
	m.Register(func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("projects")
		if err != nil {
			return err
		}
		c.Fields.Add(
			&core.BoolField{Name: "public"},
			&core.BoolField{Name: "share_hide_notes"},
			&core.BoolField{Name: "share_hide_regions"},
			&core.BoolField{Name: "share_hide_tags"},
			&core.BoolField{Name: "share_show_sources"},
		)
		return app.Save(c)
	}, nil)
}
