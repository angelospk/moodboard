# Moodboard extension

Chrome MV3 extension (WXT + Svelte 5 + TypeScript) that saves inspiration images
from any web page into the Moodboard app (PocketBase at
`https://moodboard-api.haroldpoi.dev`).

## Setup

```bash
npm install
cp .env.example .env   # already provided locally
npm run dev            # or: npm run build
```

`.env` holds `WXT_PB_URL` and `WXT_WEB_URL`. WXT inlines `WXT_`-prefixed
variables into the bundle at `import.meta.env`.

Load the unpacked build: `chrome://extensions` → Developer mode → *Load unpacked*
→ `.output/chrome-mv3`.

## Use

- Right-click an image → **Αποθήκευση εικόνας στο Moodboard**.
- Right-click a page → **Στιγμιότυπο σελίδας στο Moodboard**, or use the popup
  button **Στιγμιότυπο αυτής της σελίδας**.
- The popup opens with a preview. Sign in (or sign up with an invite code), pick
  (or create) a project, add a note, tags and a level, then **Αποθήκευση**. One
  multipart request uploads the image file and creates the `inspirations` record.

## Εγκατάσταση σε Windows

1. Κατέβασε από το repo τα τρία αρχεία του φακέλου `updater/`: `install.cmd`,
   `install.ps1`, `update.ps1` (ίδιο φάκελο).
2. Διπλό κλικ στο `install.cmd`.
3. Ακολούθησε τις οδηγίες που θα δείξει: `chrome://extensions` → Developer mode
   → Load unpacked → διάλεξε τον φάκελο
   `%LOCALAPPDATA%\MoodboardExtension\app`.
4. Οι ενημερώσεις κατεβαίνουν αυτόματα κάθε ώρα. Όταν το παράθυρο της
   επέκτασης δείξει «Νέα έκδοση διαθέσιμη», πάτησε «Επανεκκίνηση».

## Layout

- `src/lib/pb.ts` — PocketBase client with an `AsyncAuthStore` backed by
  `browser.storage.local`, plus `ready()` and `msg()`.
- `src/lib/pending.ts` — the pending capture record in `browser.storage.session`
  (falls back to `browser.storage.local`).
- `src/lib/types.ts` — shared schema types (`Project`, `Level`, mime map).
- `src/entrypoints/background.ts` — context menus, image fetch, screenshot capture.
- `src/entrypoints/popup/` — the Svelte 5 popup (Greek UI, 360px wide).
- `updater/` — the Windows install and self-update scripts.

## Version and self-update

`wxt.config.ts` sets `manifest.version` from `EXT_VERSION` (default `0.0.0`) and
writes a matching `.output/chrome-mv3/version.json` at build time. The popup
compares that file with the running manifest version; when they differ it shows
«Νέα έκδοση διαθέσιμη» and a button that reloads the extension.

```bash
EXT_VERSION=1.0.7 npm run build
```

## Checks

```bash
npm run build
npm run check      # svelte-check, 0 errors
npx tsc --noEmit -p .
```
