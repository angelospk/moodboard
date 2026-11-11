package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// Faster images and two new inspiration fields:
//   - a 480px-wide thumbnail (made on first request, then kept) for the map and the grid;
//   - file tokens last 7 days, so image URLs stay the same and the browser cache works;
//   - image_url: the image's own address (the extension knows it), next to the page in source_url;
//   - crop: the part of the image to show on cards, as fractions {x, y, w, h}; the file is not changed.
func init() {
	m.Register(func(app core.App) error {
		c, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		img, ok := c.Fields.GetByName("image").(*core.FileField)
		if !ok {
			return nil
		}
		img.Thumbs = []string{"480x0"}
		c.Fields.Add(
			&core.URLField{Name: "image_url", OnlyDomains: nil},
			&core.JSONField{Name: "crop", MaxSize: 1000},
		)
		if err := app.Save(c); err != nil {
			return err
		}

		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		users.FileToken.Duration = 7 * 24 * 3600
		return app.Save(users)
	}, nil)
}
