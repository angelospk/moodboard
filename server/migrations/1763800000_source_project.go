package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// inspirations.source_project: the work an image was taken from (a case study, a portfolio piece),
// as free text the user types, e.g. "Villa Savoye". Different from project_id, which is one of the
// user's own moodboard projects, and from source_url, which is the web page. Empty = not set.
func init() {
	m.Register(func(app core.App) error {
		ins, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		ins.Fields.Add(&core.TextField{Name: "source_project", Max: 200})
		return app.Save(ins)
	}, func(app core.App) error {
		ins, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		ins.Fields.RemoveByName("source_project")
		return app.Save(ins)
	})
}
