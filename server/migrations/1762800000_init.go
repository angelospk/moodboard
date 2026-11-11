// Package migrations holds the Moodboard schema. Ownership is enforced by API rules (user_id =
// @request.auth.id) plus the hooks in package mb (project ownership, invite codes).
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// Levels of an inspiration ("επίπεδο έμπνευσης").
var Levels = []string{"urban", "building", "interior", "detail", "material"}

// ImageMimeTypes the inspirations.image field accepts.
var ImageMimeTypes = []string{"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"}

const own = "@request.auth.id != '' && user_id = @request.auth.id"

// allowUUIDs lets imported rows keep their Supabase uuid; new rows still get 15-char ids.
func allowUUIDs(c *core.Collection) {
	id := c.Fields.GetByName("id").(*core.TextField)
	id.Max = 36
	id.Pattern = `^[a-z0-9-]+$`
}

func owner(usersId string) *core.RelationField {
	return &core.RelationField{Name: "user_id", CollectionId: usersId, Required: true, MaxSelect: 1, CascadeDelete: true}
}

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		users.AuthToken.Duration = 30 * 24 * 3600 // remembered for a month; the SDK refreshes it on use
		users.FileToken.Duration = 3600           // like the old 1h signed image URLs
		users.OAuth2.Enabled = false
		if err := app.Save(users); err != nil {
			return err
		}

		// Invite codes: no API rules, so only superusers (admin UI) can read or change them.
		invites := core.NewBaseCollection("invites", "mbinvites")
		invites.Fields.Add(
			&core.TextField{Name: "code", Required: true, Min: 6, Max: 64},
			&core.NumberField{Name: "uses_left", OnlyInt: true, Min: types.Pointer(0.0)},
			&core.TextField{Name: "note", Max: 200},
			&core.AutodateField{Name: "created_at", OnCreate: true},
		)
		invites.AddIndex("idx_invites_code", true, "code", "")
		if err := app.Save(invites); err != nil {
			return err
		}

		projects := core.NewBaseCollection("projects", "mbprojects")
		allowUUIDs(projects)
		projects.ListRule, projects.ViewRule = types.Pointer(own), types.Pointer(own)
		projects.CreateRule, projects.UpdateRule = types.Pointer(own), types.Pointer(own+" && @request.body.user_id:isset = false")
		projects.DeleteRule = types.Pointer(own)
		projects.Fields.Add(
			owner(users.Id),
			&core.TextField{Name: "name", Required: true, Max: 120},
			&core.TextField{Name: "description", Max: 5000},
			&core.AutodateField{Name: "created_at", OnCreate: true},
		)
		projects.AddIndex("idx_projects_user_name", true, "user_id, name COLLATE NOCASE", "")
		if err := app.Save(projects); err != nil {
			return err
		}

		ins := core.NewBaseCollection("inspirations", "mbinspirations")
		allowUUIDs(ins)
		ins.ListRule, ins.ViewRule = types.Pointer(own), types.Pointer(own)
		ins.CreateRule, ins.UpdateRule = types.Pointer(own), types.Pointer(own+" && @request.body.user_id:isset = false")
		ins.DeleteRule = types.Pointer(own)
		ins.Fields.Add(
			owner(users.Id),
			&core.RelationField{Name: "project_id", CollectionId: projects.Id, MaxSelect: 1},
			&core.FileField{Name: "image", Required: true, MaxSelect: 1, MaxSize: 10 << 20, MimeTypes: ImageMimeTypes, Protected: true},
			&core.TextField{Name: "source_url", Max: 2000},
			&core.TextField{Name: "source_title", Max: 500},
			&core.TextField{Name: "note", Max: 100000},
			&core.JSONField{Name: "tags", MaxSize: 20000},
			&core.SelectField{Name: "level", Values: Levels, MaxSelect: 1},
			&core.JSONField{Name: "regions", MaxSize: 200000},
			&core.AutodateField{Name: "created_at", OnCreate: true},
			&core.AutodateField{Name: "updated_at", OnCreate: true, OnUpdate: true},
		)
		ins.AddIndex("idx_inspirations_user_created", false, "user_id, created_at", "")
		ins.AddIndex("idx_inspirations_project", false, "project_id", "")
		if err := app.Save(ins); err != nil {
			return err
		}

		// Where the user placed each node on a map. scope: a project id, 'all' or 'none'.
		// node_key: 'i:<inspiration id>', 't:<tag>', 'p:<project id>'.
		pos := core.NewBaseCollection("map_positions", "mbpositions")
		pos.ListRule, pos.ViewRule = types.Pointer(own), types.Pointer(own)
		pos.CreateRule, pos.UpdateRule = types.Pointer(own), types.Pointer(own+" && @request.body.user_id:isset = false")
		pos.DeleteRule = types.Pointer(own)
		pos.Fields.Add(
			owner(users.Id),
			&core.TextField{Name: "scope", Required: true, Max: 64},
			&core.TextField{Name: "node_key", Required: true, Min: 3, Max: 200},
			&core.NumberField{Name: "x"},
			&core.NumberField{Name: "y"},
			&core.AutodateField{Name: "updated_at", OnCreate: true, OnUpdate: true},
		)
		pos.AddIndex("idx_positions_key", true, "user_id, scope, node_key", "")
		if err := app.Save(pos); err != nil {
			return err
		}

		s := app.Settings()
		s.Meta.AppName = "Moodboard"
		s.Meta.AppURL = "https://pb.haroldpoi.dev"
		s.RateLimits.Enabled = true
		// Only cloudflared (loopback) reaches the server, so Cloudflare's client-IP header is trusted.
		s.TrustedProxy.Headers = []string{"CF-Connecting-IP"}
		s.Backups.Cron = "30 3 * * *"
		s.Backups.CronMaxKeep = 7
		return app.Save(s)
	}, nil)
}
