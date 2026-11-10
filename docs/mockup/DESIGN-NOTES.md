# Moodboard: design notes

Mockup: `moodboard-ideal.html`. Screens 6 and 7 are "later".

## Tokens (light / dark)

- `--bg` paper `#f4f1eb` / `#161513`
- `--surface` `#fbfaf7` / `#1d1c19`; `--raised` `#ffffff` / `#262420`; `--sunk` `#ebe7df` / `#0f0e0d`
- `--text` `#1e1c19` / `#ece8e1`; `--muted` `#6d675e` / `#a39d92`; `--faint` `#9a9388` / `#716b62`
- `--line` `#e0dacf` / `#33302b`; `--line-strong` `#c9c1b2` / `#4c473f`
- `--accent` terracotta, only accent: `#b4532a` / `#e07a4c`
- `--wood` `#a9825a`, `--concrete` `#8d8a84`: data bars only
- Type: system sans for UI; system serif (Iowan, Palatino, Georgia) for project names and headings. Scale 11 (uppercase labels) / 12.5 / 14 base / 16 / 18 / 22 / 28.
- Radius: 4 images, 8 controls, 14 panels and modals, 999 pills.
- Spacing: 4-based (4, 8, 12, 16, 24, 32; 56 page gutter). App bar 56px. Side panel 380px.
- States: accent ring = selected. Dark filled chip = on. Dashed border = optional, suggested, or later.

## Five UX decisions

1. Home leads with one "Συνέχισε εδώ" card: one obvious next step, no choosing.
2. Map images are whole and anchored at their centre: resizing never moves the links, nothing is cropped.
3. Quick-add has every field optional and Enter saves: capture first, organise later.
4. Tags and level are one-click chips everywhere (extension, modal, editor): no typing, no dropdowns.
5. Region rating is five squares on the region row, 1 = "not this", 5 = "exactly this": low scores feed the later taste profile too.

## Build order

One phase = one worker task.

UI only:

1. Tokens and primitives (chip, btn, seg, kbd) in `app.css`. Done: existing pages render in light and dark.
2. Home project cards with collage, `routes/+page.svelte`. Done: each project shows 3 images and a count.
3. "Συνέχισε εδώ" card (localStorage). Done: reload shows the last opened project first.
4. Map card with centre anchor, size slider, notes toggle (map page, `MapCard.svelte`). Done: slider resizes cards and links stay attached.
5. Regions on map cards at size ≥ 120% and on the selected card. Done: boxes show and hide at the threshold.
6. Side panel `MapPanel.svelte` (note, regions, copy to project; copy inserts a row). Done: click opens the panel, copy creates a row.
7. Tag hover "+" and `QuickAdd.svelte`. Done: paste, Enter, image appears on the map with the tag.
8. Extension popup chips and saved toast. Done: save works with two clicks and Enter.
9. Mobile map bottom sheet (CSS). Done: at 390px a tap opens the sheet.

Needs backend or schema:

10. Persisted map positions: migration (`map_x`, `map_y` on inspirations; tag positions per project) plus map page. Done: drag, reload, same position.
11. Region rating: `rating` (1–5 or null) in the region JSON, `types.ts`, editor page. Done: rating survives reload.

Later (schema plus model API):

- L1. AI image analysis with accept/reject tags: suggestion table, vision model job.
- L2. Taste profile and similar references: needs L1 and phase 11 data.
- L3. Live direction concept: image model API, version table.
