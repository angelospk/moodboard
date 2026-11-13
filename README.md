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
| `GET /api/mb/search?q=&project=&limit=` | search by meaning (needs `embed_enabled`) |
| `GET /api/mb/embed/status` | consent, how many images have a vector, model, dimension |
| `GET /api/mb/inspirations/{id}/similar?scope=project\|all` | images most like this one |
| `GET /api/mb/inspirations/{id}/knn-suggest` | tags and level voted by the nearest labeled images (no LLM) |
| `GET /api/mb/duplicates?project=&id=` | near-duplicate pairs from a 64-bit image hash |
| `POST /api/mb/projects/{id}/summary-draft` | Gemini Flash drafts a project description (2-3 readings where unsure); the web app saves the picked text into `projects.description` |

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
`get_inspiration`, `save_inspiration`, `suggest_labels`, `add_note`, `semantic_search`,
`similar_inspirations`. Levels are passed by name.

- **claude.ai:** Settings → Connectors → «Add custom connector» → URL
  `https://moodboard-api.haroldpoi.dev/mcp`. Claude opens our sign-in page; use your Moodboard
  email and password. This is OAuth 2.1 (`server/mb/oauth.go`): dynamic client registration,
  PKCE S256, 1-hour access tokens, 30-day refresh tokens that rotate on every use.
- **Other clients:** make a long-lived token on the server:
  `~/.local/share/moodboard/moodboard mcp-token <email> [days] --dir ~/.local/share/moodboard/pb_data`.

`save_inspiration` downloads only public https images and checks the address it actually
connects to (no private hosts, no redirects).

## Search by meaning

A user who switches on «Έξυπνη αναζήτηση» (`users.embed_enabled`, separate from `ai_enabled`) lets the
server send every image, old ones too, once to Google Gemini (`gemini-embedding-2`, the 480 px
thumbnail). The vector (base64 float32) goes into the superuser-only collection `image_features`.
Search is a brute-force dot product over a per-user in-memory index (`server/mb/semantic.go`); the
index drops itself on any change. The same row keeps the local features (no API): dominant colors
(`inspirations.colors`) and a 64-bit dHash for near duplicates. Backfill runs on consent, on server
start and hourly; a changed model or dimension re-embeds by itself. With a free-tier key Google may
use the data: use a paid key before you switch it on for private images.

| Env | Default | Meaning |
|---|---|---|
| `MB_EMBED_DIM` | 768 | vector size (768 gave the best image-neighbour purity on a 24-image test) |
| `MB_EMBED_MODEL` | `gemini-embedding-2` | embedding model |
| `MB_EMBED_DAILY_LIMIT` | 5000 | image embeds per user per UTC day (300 search queries per day) |

## Public images Worker

`worker/` is a Cloudflare Worker on `moodboard-api.haroldpoi.dev/api/mb/public/*`. For a public board
image (`/files/{id}`, optionally `?thumb=480x0`) it makes a WebP at 1600 px (480 px for a thumbnail) with
`cf.image` (`metadata: none` drops GPS and camera data) and keeps it at the edge.

**Cold path (measured 0.4-0.9 s, was 1.6-14.8 s).** The Worker asks the backend only for the storage key
(`GET .../files/{id}/src`, header `X-MB-Resolve`; the backend checks public/private on every call and
answers 404 without the secret), then resizes the file straight from the image bucket
(`env.IMAGES`), so the 1-7 MB original never crosses the home connection. The key never reaches the
visitor, and the raw bucket file is never served: the answer must carry Cloudflare's `cf-resized`
header, else the old path runs (backend streams the cleaned file, then Cloudflare resizes it). The
same fallback covers a missing or different secret (the resolver's 404 is not trusted: the old route
decides), a resolver error or a 1.5 s timeout. Setup: the same random
value in `MB_RESOLVE_SECRET` (`~/.local/share/moodboard/ai.env`, read by the backend) and in the Worker
(`cd worker && npx wrangler secret put RESOLVE_SECRET`), then `server/deploy.sh` and `npx wrangler deploy`.

**Freshness and revocation.** A copy is fresh for 60 s (the browser gets only the time that is left).
A copy between 60 s and 1 hour old is served at once with `max-age=0` while one refresh runs in the
background: a 200 replaces it, a 404 deletes it, another error keeps it but marks it as served, so the
next request asks the backend itself. After a board is turned private, an edge location therefore shows it
only to the requests that arrive during that one refresh (about a second), and only when a copy younger
than 1 hour exists; measured on a temporary board: 200 at 61 s, 404 from 71 s. Older than 1 hour, the
backend is asked first. A 404 is never cached.
`server/warm-public.sh` (user timer `moodboard-warm.timer`, every 20 minutes) requests every public
board and image so the copy near the backend stays under an hour old and a first visitor finds it warm.
Everything else on that path passes through unchanged. The Worker is not CI-deployed:
`cd worker && npm ci && npm test && npx wrangler deploy`. To switch it off, delete the `routes` entry
in `worker/wrangler.jsonc` and deploy again. Free plan limits (Cloudflare docs, Nov 2026): 100,000
Worker requests a day, 5,000 unique image transformations a month (no charge above it; new sizes then
fall back to the plain file).

Images live in the R2 bucket `moodboard-images` (`images.haroldpoi.dev/mbinspirations/<id>/<file>`),
readable by anyone who knows the path. A public board never shows the stored file name (JSON field
and download name are neutral), because that name is the key to the original there.

The app asks for `?w=480` (cards) and `?w=2048` (panel, viewer). A second Worker,
`worker/src/images.js` (`npx wrangler deploy -c wrangler.images.jsonc`, route
`images.haroldpoi.dev/mbinspirations/*`), resizes the stored file with Cloudflare Image Transformations and
sends AVIF, WebP or JPEG by the Accept header, cached for a year. A 2.1 MB PNG became 8 KB (480 px) and
115 KB (2048 px) as AVIF. Past the 5,000 monthly transformations, or on any error, the stored file is served.
The VPS-made `thumbs_*` files are only used for the public board and for local servers.

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
