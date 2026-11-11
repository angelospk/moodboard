package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// The backend moved from pb.haroldpoi.dev to moodboard-api.haroldpoi.dev (file URLs in MCP use it).
func init() {
	m.Register(func(app core.App) error {
		s := app.Settings()
		s.Meta.AppURL = "https://moodboard-api.haroldpoi.dev"
		return app.Save(s)
	}, nil)
}
