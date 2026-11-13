// Moodboard backend: PocketBase with the Moodboard schema, hooks, custom routes and an MCP endpoint
// in one binary. `moodboard serve --http 127.0.0.1:8190` runs it.
package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/spf13/cobra"

	"moodboard/server/mb"
	_ "moodboard/server/migrations"
)

func main() {
	app := pocketbase.New()
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{Automigrate: false})
	mb.Register(app)
	// The Cloudflare Worker's secret for the storage-key route of public images (empty = route off).
	mb.EnableResolver(os.Getenv("MB_RESOLVE_SECRET"))
	// Automatic labels need GEMINI_API_KEY (from the systemd EnvironmentFile) and run only under `serve`.
	if key := os.Getenv("GEMINI_API_KEY"); key != "" && len(os.Args) > 1 && os.Args[1] == "serve" {
		limit, _ := strconv.Atoi(os.Getenv("MB_AI_DAILY_LIMIT"))
		mb.EnableAI(app, mb.AIConfig{Key: key, Model: os.Getenv("MB_AI_MODEL"), DailyLimit: limit})
		// Search by meaning and similar images: one embedding per image, only for users who agreed.
		dim, _ := strconv.Atoi(os.Getenv("MB_EMBED_DIM"))
		elimit, _ := strconv.Atoi(os.Getenv("MB_EMBED_DAILY_LIMIT"))
		mb.EnableEmbeddings(app, mb.EmbedConfig{Key: key, Model: os.Getenv("MB_EMBED_MODEL"), Dim: dim, DailyLimit: elimit})
	}

	app.RootCmd.AddCommand(&cobra.Command{
		Use:   "mcp-token <email> [days]",
		Short: "Print a long-lived MCP bearer token for a user (default 365 days)",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(_ *cobra.Command, args []string) error {
			if err := app.Bootstrap(); err != nil {
				return err
			}
			days := 365
			if len(args) == 2 {
				d, err := strconv.Atoi(args[1])
				if err != nil || d < 1 {
					return fmt.Errorf("days must be a positive number")
				}
				days = d
			}
			u, err := app.FindAuthRecordByEmail("users", args[0])
			if err != nil {
				return fmt.Errorf("user not found: %s", args[0])
			}
			tok, err := u.NewStaticAuthToken(time.Duration(days) * 24 * time.Hour)
			if err != nil {
				return err
			}
			fmt.Println(tok)
			return nil
		},
	})
	app.RootCmd.AddCommand(mb.ImportCommand(app))

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
