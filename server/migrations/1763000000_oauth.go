package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// OAuth 2.1 for MCP clients (claude.ai connectors). No API rules on these collections: only the Go
// routes in mb/oauth.go and superusers touch them. Codes and refresh tokens are stored as SHA-256
// hashes, never in clear.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		clients := core.NewBaseCollection("oauth_clients", "mboauthclients")
		clients.Fields.Add(
			&core.TextField{Name: "client_name", Max: 200},
			&core.JSONField{Name: "redirect_uris", Required: true, MaxSize: 10000},
			&core.AutodateField{Name: "created_at", OnCreate: true},
		)
		if err := app.Save(clients); err != nil {
			return err
		}

		codes := core.NewBaseCollection("oauth_codes", "mboauthcodes")
		codes.Fields.Add(
			&core.TextField{Name: "code_hash", Required: true, Max: 64},
			&core.RelationField{Name: "client", CollectionId: clients.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.TextField{Name: "redirect_uri", Required: true, Max: 2000},
			&core.TextField{Name: "code_challenge", Required: true, Max: 128},
			&core.DateField{Name: "expires", Required: true},
		)
		codes.AddIndex("idx_oauth_codes_hash", true, "code_hash", "")
		if err := app.Save(codes); err != nil {
			return err
		}

		refresh := core.NewBaseCollection("oauth_refresh_tokens", "mboauthrefresh")
		refresh.Fields.Add(
			&core.TextField{Name: "token_hash", Required: true, Max: 64},
			&core.RelationField{Name: "client", CollectionId: clients.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.DateField{Name: "expires", Required: true},
			&core.AutodateField{Name: "created_at", OnCreate: true},
		)
		refresh.AddIndex("idx_oauth_refresh_hash", true, "token_hash", "")
		if err := app.Save(refresh); err != nil {
			return err
		}

		// Password guessing on the consent page and client spam on registration.
		s := app.Settings()
		s.RateLimits.Rules = append(s.RateLimits.Rules,
			core.RateLimitRule{Label: "POST /oauth/authorize", MaxRequests: 5, Duration: 60},
			core.RateLimitRule{Label: "/oauth/register", MaxRequests: 10, Duration: 3600},
			core.RateLimitRule{Label: "/oauth/token", MaxRequests: 30, Duration: 60},
		)
		return app.Save(s)
	}, nil)
}
