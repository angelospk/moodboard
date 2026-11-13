# Moodboard

Save inspiration images from anywhere on the web, tag them, mark the details you like, and lay
them out on a live map. Built for architecture work: every image has a level (your own list of
scales; new accounts start with Αστικό, Κτίριο, Εσωτερικό, Λεπτομέρεια, Υλικό and can add, rename,
reorder or remove them), free tags, a note, and marked regions with their own notes.

- **App:** https://moodboard.haroldpoi.dev (sign-up needs an invite code)
- **API:** https://moodboard-api.haroldpoi.dev

## Languages

The app, the extension and the server messages come in Greek and English. The web app and the
extension pick the saved choice, then the browser language, then Greek; a selector switches it
(it reloads the page). Texts live in `web/src/lib/messages/{el,en}.ts` and
`extension/src/lib/messages/{el,en}.ts`: `el` is the source and `en` has the same keys, which the
type checker enforces (`web/tests/i18n.test.ts` also checks placeholders). To add a language, add
a catalog and a name in `LOCALES`/`LOCALE_NAMES` (web and extension), and a case in
`server/mb/lang.go`. No i18n library: `web/src/lib/i18n.ts` is about 100 lines.

The icon is drawn by `python3 extension/scripts/icons.py` (it writes `favicon.svg` and the PNG sizes).

## Οδηγίες για χρήστες

**Σελίδα:** άνοιξε το https://moodboard.haroldpoi.dev → «Νέος λογαριασμός» με email, κωδικό και
τον κωδικό πρόσκλησης που σου έδωσαν. Η σύνδεση μένει αποθηκευμένη στον browser.

**Επέκταση Chrome (Windows):**

1. Από τη σελίδα [Releases](https://github.com/angelospk/moodboard/releases/latest) κατέβασε τα
   `install.cmd`, `install.ps1` και `update.ps1` στον ίδιο φάκελο.
2. Διπλό κλικ στο `install.cmd`.
3. Στο Chrome: `chrome://extensions` → ενεργοποίησε το «Developer mode» → «Load unpacked» →
   διάλεξε τον φάκελο που σου δείχνει το παράθυρο.
4. Δεξί κλικ σε μια εικόνα → «Αποθήκευση εικόνας στο Moodboard».

Οι ενημερώσεις κατεβαίνουν μόνες τους κάθε ώρα. Όταν το παράθυρο της επέκτασης δείξει «Νέα
έκδοση διαθέσιμη», πάτα «Επανεκκίνηση».

## Architecture

```
browser ── https ──> moodboard.haroldpoi.dev        static SvelteKit SPA (GitHub Pages)
   │
   └──── https + SSE ─> moodboard-api.haroldpoi.dev  Cloudflare tunnel ─> mini PC 127.0.0.1:8190
Chrome extension ──────┘                             one Go binary: PocketBase + /api/mb + /mcp
```

| Part | Folder | Stack |
|---|---|---|
| Backend | `server/` | Go, [PocketBase](https://pocketbase.io) used as a library (SQLite, auth, files, realtime) |
| Web app | `web/` | SvelteKit 3 (static, `adapter-static`), Svelte 5, PocketBase JS SDK |
| Extension | `extension/` | Chrome MV3, WXT, Svelte 5 |

**Data and rules.** Collections `projects`, `inspirations` (protected image file), `map_positions`
and `invites` are defined in `server/migrations/`. Every row has a `user_id`; the API rules allow
access only to the owner, and hooks in `server/mb/mb.go` check what rules cannot: project
ownership of an inspiration and the invite code on sign-up. Image URLs need a file token that
lasts one hour.

**Custom routes** (`server/mb/routes.go`, signed-in users only):

| Route | Purpose |
|---|---|
| `GET /api/mb/tags` | the user's tags, most used first |
| `POST /api/mb/inspirations/{id}/note` | append to a note in one transaction |
| `POST /api/mb/inspirations/{id}/copy` | duplicate an inspiration and its file into a project |
| `POST /api/mb/positions` | upsert node positions of one map |
| `POST /api/mb/positions/delete` | forget positions (one scope or all) |

**Public boards** (`server/mb/share.go`, no account): when a project has `public` on, anyone with
`/s/<project id>` sees it. `GET /api/mb/public/{project}` returns the board (name, description,
images, saved layout) and `GET /api/mb/public/{project}/files/{id}` serves its images; both answer
404 for a private board. The owner picks what shows in «Κοινοποίηση» (fields `share_hide_notes`,
`share_hide_regions`, `share_hide_tags`, `share_show_sources` on `projects`; default: notes, region
notes, tags and level shown, sources hidden).

**Live map.** The map page subscribes to `inspirations` and `projects` over PocketBase realtime
(SSE). A change from another tab or device shows at once; an update replaces the shown row only
when its `updated_at` is newer, so a late echo of an older save cannot undo a newer one
(`web/src/lib/realtime.ts`).

**MCP.** `POST https://moodboard-api.haroldpoi.dev/mcp` (streamable HTTP, stateless) with
`Authorization: Bearer <token>`. Tools: `list_projects`, `list_levels`, `search_inspirations`,
`get_inspiration`, `save_inspiration`, `suggest_labels`, `add_note`. Levels are passed by name.

- **claude.ai:** Settings → Connectors → «Add custom connector» → URL
  `https://moodboard-api.haroldpoi.dev/mcp`. Claude opens our sign-in page; use your Moodboard
  email and password. This is OAuth 2.1 (`server/mb/oauth.go`): dynamic client registration,
  PKCE S256, 1-hour access tokens, 30-day refresh tokens that rotate on every use.
- **Other clients:** make a long-lived token on the server:
  `~/.local/share/moodboard/moodboard mcp-token <email> [days] --dir ~/.local/share/moodboard/pb_data`.

`save_inspiration` downloads only public https images and checks the address it actually
connects to (no private hosts, no redirects).

## Public images Worker

`worker/` is a Cloudflare Worker on `moodboard-api.haroldpoi.dev/api/mb/public/*`. For a public board
image (`/files/{id}`, optionally `?thumb=480x0`) it asks the VPS once, lets Cloudflare resize the image
to 1600 px (480 px for a thumbnail), convert it to AVIF/WebP and drop all metadata (`cf.image`,
`metadata: none`), and keeps the result at the edge for 60 seconds (a browser gets only the time that is left, and the VPS sends the same `max-age=60`, so a board turned private disappears within about a minute; measured on the live route: 404 after 51 s. The VPS answer is `private`, which keeps Cloudflare from keeping its own copy for the documented one-hour minimum). A 404 from the VPS (private or
unknown board) is never cached. If resizing fails, the Worker serves the plain VPS file, which strips
metadata too (`server/mb/stripmeta.go`). Everything else on that path passes through unchanged. The
Worker is not CI-deployed: `cd worker && npm ci && npm test && npx wrangler deploy`. To switch it off,
delete the `routes` entry in `worker/wrangler.jsonc` and deploy again. Free plan limits (Cloudflare docs,
Nov 2026): 100,000 Worker requests a day, 5,000 unique image transformations a month (no charge above it;
new sizes then fall back to the plain file).

Images live in the R2 bucket `moodboard-images` (`images.haroldpoi.dev/mbinspirations/<id>/<file>`),
readable by anyone who knows the path. A public board never shows the stored file name (JSON field
and download name are neutral), because that name is the key to the original there.

## Develop

Requirements: Go 1.27+, Node 22.

```bash
# backend on http://127.0.0.1:8090 (admin UI at /_/)
cd server
go run . superuser upsert admin@example.com <password>
go run . serve

# web app, against the local backend
cd web
npm ci
VITE_PB_URL=http://127.0.0.1:8090 npm run dev

# extension (load extension/.output/chrome-mv3 with "Load unpacked")
cd extension
npm ci
WXT_PB_URL=http://127.0.0.1:8090 npm run dev
```

Create an invite code in the admin UI (collection `invites`, `uses_left` ≥ 1) to sign up.

## Tests

```bash
cd server && go test ./...          # rules, invites, routes, MCP, import
cd web && npx vitest run            # builds ../server and runs it: data helpers and realtime
cd web && npm run check             # svelte-check
cd extension && npm run check
```

## Deploy

| What | How |
|---|---|
| Web app | push to `main` under `web/` → `.github/workflows/pages.yml` → GitHub Pages |
| Extension | push to `main` under `extension/` → `.github/workflows/extension.yml` → release `ext-v1.0.N` with the zip and the Windows installer |
| Backend | `server/deploy.sh` (tests, build, install on the mini PC, restart the systemd user unit `moodboard`) |

PocketBase backs up its data every night at 03:30 UTC (`pb_data/backups`, last 7 kept). On the
mini PC, the systemd user timer `moodboard-backup.timer` (05:15) runs `server/backup-pull.sh`,
which copies those zips to `~/backups/moodboard`.

`web/scripts/export-supabase.mjs` and `moodboard import <dir>` moved the data from the earlier
Supabase version; they are kept for reference.
