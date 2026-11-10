# Moodboard extension

Chrome MV3 extension (WXT + Svelte 5 + TypeScript) that saves inspiration images
from any web page into the Moodboard app (Supabase).

## Setup

```bash
npm install
cp .env.example .env   # already provided locally; local Supabase dev values
npm run dev            # or: npm run build
```

`.env` holds `WXT_SUPABASE_URL`, `WXT_SUPABASE_KEY`, `WXT_WEB_URL`. WXT inlines
`WXT_`-prefixed variables into the bundle at `import.meta.env`.

Load the unpacked build: `chrome://extensions` → Developer mode → *Load unpacked*
→ `.output/chrome-mv3`.

## Use

- Right-click an image → **Αποθήκευση εικόνας στο Moodboard**.
- Right-click a page → **Στιγμιότυπο σελίδας στο Moodboard**, or use the popup
  button **Στιγμιότυπο αυτής της σελίδας**.
- The popup opens with a preview. Sign in, pick (or create) a project, add a note,
  tags and a level, then **Αποθήκευση**. The image goes to the `inspirations`
  storage bucket at `<user_id>/<uuid>.<ext>`, then a row goes into
  `inspirations`; if the insert fails, the uploaded object is removed.

## Layout

- `src/lib/supabase.ts` — Supabase client with a `chrome.storage.local` auth adapter.
- `src/lib/pending.ts` — the pending capture record in `chrome.storage.session`
  (falls back to `chrome.storage.local`).
- `src/lib/types.ts` — copied schema types (`Project`, `Level`, `parseTags`, mime map).
- `src/entrypoints/background.ts` — context menus, image fetch, screenshot capture.
- `src/entrypoints/popup/` — the Svelte 5 popup (Greek UI, 360px wide).

## Checks

```bash
npm run build
npm run check      # svelte-check, 0 errors
npx tsc --noEmit -p .
```
