package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// OAuth grants (review round 1):
//   - access tokens are opaque and work only on /mcp (not the whole PocketBase API);
//   - a refresh token is marked used, not deleted, so a second use is seen as theft and revokes
//     its whole family (every token from the same sign-in);
//   - every token stores a hash of the user's tokenKey: a password change makes them all invalid.
func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		clients, err := app.FindCollectionByNameOrId("oauth_clients")
		if err != nil {
			return err
		}

		// Rows from before this change have no family; drop them (clients sign in again).
		if _, err := app.DB().NewQuery("DELETE FROM oauth_refresh_tokens").Execute(); err != nil {
			return err
		}
		refresh, err := app.FindCollectionByNameOrId("oauth_refresh_tokens")
		if err != nil {
			return err
		}
		refresh.Fields.Add(
			&core.TextField{Name: "family", Required: true, Max: 64},
			&core.BoolField{Name: "used"},
			&core.TextField{Name: "key_hash", Required: true, Max: 64},
		)
		refresh.AddIndex("idx_oauth_refresh_family", false, "family", "")
		if err := app.Save(refresh); err != nil {
			return err
		}

		access := core.NewBaseCollection("oauth_access_tokens", "mboauthaccess")
		access.Fields.Add(
			&core.TextField{Name: "token_hash", Required: true, Max: 64},
			&core.TextField{Name: "family", Required: true, Max: 64},
			&core.RelationField{Name: "client", CollectionId: clients.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1, CascadeDelete: true},
			&core.TextField{Name: "key_hash", Required: true, Max: 64},
			&core.DateField{Name: "expires", Required: true},
		)
		access.AddIndex("idx_oauth_access_hash", true, "token_hash", "")
		access.AddIndex("idx_oauth_access_family", false, "family", "")
		return app.Save(access)
	}, nil)
}
