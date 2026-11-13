package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// image_features: what the server computes from each image. It has no API rules, so only the
// server (and a superuser) can read it: the vectors stay out of list, realtime and export
// responses. One row per inspiration (deleted with it).
//
//	image  the file name the numbers describe (a replaced file makes the row stale)
//	phash  64-bit difference hash as 16 hex digits (near-duplicates)
//	vec    embedding as base64 of little-endian float32
//	model, dim  what made vec (a different config makes it stale)
//
// inspirations.colors: up to 5 dominant colors as "#rrggbb", most common first.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		ins, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		ins.Fields.Add(&core.JSONField{Name: "colors", MaxSize: 500})
		if err := app.Save(ins); err != nil {
			return err
		}
		// users.embed_enabled: the user agreed that ALL their images, old ones too, are sent once to
		// Google Gemini to compute an embedding (search by meaning, similar images). It is separate
		// from ai_enabled, whose consent covers only the labels of new images.
		users.Fields.Add(&core.BoolField{Name: "embed_enabled"})
		if err := app.Save(users); err != nil {
			return err
		}
		f := core.NewBaseCollection("image_features", "mbimagefeatures")
		f.Fields.Add(
			owner(users.Id),
			&core.RelationField{Name: "inspiration_id", CollectionId: ins.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.TextField{Name: "image", Max: 300},
			&core.TextField{Name: "phash", Max: 16},
			&core.TextField{Name: "vec", Max: 40000},
			&core.TextField{Name: "model", Max: 100},
			&core.NumberField{Name: "dim", OnlyInt: true},
		)
		f.AddIndex("idx_image_features_inspiration", true, "inspiration_id", "")
		f.AddIndex("idx_image_features_user", false, "user_id", "")
		return app.Save(f)
	}, func(app core.App) error {
		if f, err := app.FindCollectionByNameOrId("image_features"); err == nil {
			if err := app.Delete(f); err != nil {
				return err
			}
		}
		if users, err := app.FindCollectionByNameOrId("users"); err == nil {
			users.Fields.RemoveByName("embed_enabled")
			if err := app.Save(users); err != nil {
				return err
			}
		}
		ins, err := app.FindCollectionByNameOrId("inspirations")
		if err != nil {
			return err
		}
		ins.Fields.RemoveByName("colors")
		return app.Save(ins)
	})
}
