# Moodboard

Save inspiration images from anywhere on the web, tag them, mark the details you like, and lay
them out on a live map. Built for architecture work: every image has a level (urban, building,
interior, detail, material), free tags, a note, and marked regions with their own notes.

- **App:** https://moodboard.haroldpoi.dev (sign-up needs an invite code)
- **API:** https://moodboard-api.haroldpoi.dev

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
   └──── https + SSE ─> moodboard-api.haroldpoi.dev  Cloudflare tunnel ─> VPS 127.0.0.1:8190
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

**Live map.** The map page subscribes to `inspirations` and `projects` over PocketBase realtime
(SSE). A change from another tab or device shows at once; an update replaces the shown row only
when its `updated_at` is newer, so a late echo of an older save cannot undo a newer one
(`web/src/lib/realtime.ts`).

**MCP.** `POST https://moodboard-api.haroldpoi.dev/mcp` (streamable HTTP, stateless) with
`Authorization: Bearer <token>`. Tools: `list_projects`, `search_inspirations`,
`get_inspiration`, `save_inspiration`, `add_note`. Make a token on the server:
`/opt/moodboard/moodboard mcp-token <email> [days] --dir /opt/moodboard/pb_data`.
`save_inspiration` downloads only public https images and checks the address it actually
connects to (no private hosts, no redirects).

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
| Backend | `server/deploy.sh` (tests, build, copy to the VPS, restart the systemd unit `moodboard`) |

PocketBase backs up its data every night (`pb_data/backups`, last 7 kept).

`web/scripts/export-supabase.mjs` and `moodboard import <dir>` moved the data from the earlier
Supabase version; they are kept for reference.
