# Moodboard design

Mode: **Operate** (a tool architects use daily). Calm, architectural, fast. Paper, concrete, warm wood, one accent.
Reference mockup (approved): `docs/mockup/moodboard-ideal.html` (layout and tone; where it differs from this file, this file wins).

## Tokens

Defined in `web/src/lib/app.css`. Use only these; no raw hex in components except the zone palette below.

- Surfaces: `--bg` (paper), `--surface`, `--raised` (cards, dock, popovers), `--sunk`.
- Text: `--text`, `--muted`, `--faint`. Lines: `--line`, `--line-strong`. Accent: `--accent` (terracotta, the only accent).
- Type: system sans for UI; `--font-serif` for project names and page titles. Scale 11 (uppercase labels, +0.06em tracking) / 12.5 / 14 base / 16 / 18 / 22 / 28.
- Radius: `--r-img` 4, `--r-ctl` 8, `--r-panel` 14, `--r-pill` 999. Spacing 4-based.
- Primitives: `.btn` `.btn.primary` `.btn.ghost`, `.chip` `.chip.on`, `.seg`, `.kbd`.
- Shadows: card `0 1px 2px rgb(0 0 0 / .06), 0 8px 24px -12px rgb(0 0 0 / .25)`; floating (dock, popover) `0 12px 32px -12px rgb(0 0 0 / .3), 0 0 0 1px var(--line)`.
- Motion: 150–200ms, `cubic-bezier(.2,.8,.2,1)`; respect `prefers-reduced-motion`.
- Touch targets ≥ 32px (≥ 40px on touch screens), even when the visible mark is smaller.

## Zone palette (tags on the board)

8 muted hues, chosen in order of first appearance of the tag (stable per tag via a hash of the tag text):
terracotta `#b4532a`, olive `#6b7a3a`, slate `#4e6a85`, ochre `#b08a2e`, plum `#7a4e6e`, sage `#5f8a74`, clay `#a0674b`, stone `#7d7a72`.
Dark mode: same hue, +18% lightness. Zone fill = hue at 7% alpha, border = hue at 28% alpha, label = hue.

## Project board (`/map`)

Layout, top to bottom:
1. **Header** 56px, `--surface`, hairline bottom. Left: breadcrumb `Moodboard` (link `/`) › project switcher (serif name + chevron → popover: «Όλα τα projects», each project with count, «Χωρίς project»). Right: search field (fades non-matching cards to 0.15), level `.seg` (Όλα · Αστικό · Κτίριο · Εσωτερικό · Λεπτομέρεια · Υλικό; a select under 900px).
2. **Tag row** 40px: chips of the tags in view with a zone-colour dot and count; click = highlight that zone (others fade), click again = clear. Horizontal scroll, no wrap.
3. **Canvas**: `--bg` with a dot grid (1px dots, 24px × zoom, moves with pan). Images grouped in **zones**: an image's zone = its first tag. Each zone is a rounded rect (radius 20, 28px padding) around its cards, labelled top-left «ξύλο · 4». Untagged images float outside zones. No edge lines.
4. **Dock**: floating pill, bottom centre, 48px: `＋ Εικόνα` (primary) · Σημειώσεις toggle · size slider · Κεντράρισμα · Αυτόματη διάταξη. Tooltips show shortcuts. With < 3 images, a hint beside it: «⌘V επικόλληση · σύρε εικόνες εδώ».
5. **Panel** (right, 400px, below header+tag row, slides in 180ms; dock shifts left to stay visible). Mobile: bottom sheet 75vh.

Cards: "print" look: `--raised` frame with 6px padding, radius 6, card shadow; image whole (natural aspect ratio); note under it when Σημειώσεις is on (12.5px, 3 lines). Hover lifts 2px. Selected = 2px accent ring. Regions: count dot top-right when small; boxes when rendered width ≥ 200px; box notes when ≥ 360px.

Interactions (all must be discoverable: tooltip, hint, or context menu):
- **Add**: `＋ Εικόνα`/`N` → file picker (multi). Drop files on the canvas → created where dropped. `⌘V` image → created at the last pointer position. Right-click canvas → «Νέα εικόνα εδώ…», «Επικόλληση εδώ», «Κεντράρισμα». New images are saved immediately (capture first), get the current project and, if dropped inside a zone, that zone's tag; then the panel opens with the note focused.
- **Organise**: drag a card into another zone → that tag becomes its first tag (toast «+ #ξύλο» with «Αναίρεση», 5s). Dragged positions persist per map.
- **Navigate**: `F` fit, `L` auto layout, `Esc` close panel/menu, `←/→` previous/next image while the panel is open. Shortcuts are ignored while typing.
- Right-click card → «Άνοιγμα», «Αντιγραφή σε…», «Διαγραφή» (confirm).

## Inspiration panel (inline editing, autosave)

Header: level label (11px uppercase) · ‹ › · ×. Then the image with region boxes (draw a box by dragging on the image), note (auto-growing textarea, «Τι σου αρέσει εδώ;»), tags (TagInput + past tags), level chips (click again clears), region list (number, note, 5 rating squares with 28px hit areas, delete), source link, footer: «Αντιγραφή σε…», «Πλήρης σελίδα», «Διαγραφή». Autosave 700ms after the last edit; status «Αποθήκευση…» / «Αποθηκεύτηκε ✓» / error with retry. Flush on close and on item change.
