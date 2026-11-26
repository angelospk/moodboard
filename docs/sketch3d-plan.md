# Sketch3D plan

Status: draft 1 (2026-11-26). Owner: Sketch3D thread. Branch `feat/sketch3d`.

## Goal

A simple pen-first 3D sketch tool for a Samsung tablet with S Pen, inside Moodboard
(SvelteKit web app, PWA later). Not CAD. Draw on a visible active plane, rotate,
push/pull closed outlines into volumes, walls as a property (0.25 m), materials,
planes as layers (ground, elevations, sections), Fork/Merge variants, reference
images to trace, notes on regions, and one JSON sketch document that AI agents
read and change through ops (MCP server).

## 1. Image to sketch: comparison result

Details: `docs/sketch3d-trace-comparison.md`. Decision: mix, model-led. A
vision model (Claude Sonnet: ~20 s/image, right structure on 7/7) writes a
draft as ops into an `AI` variant. Classic lines (LSD + vanishing points) stay
local helpers: camera for lifting polygons onto 3D planes, and pen snap guides.
Local models (gemma3:4b, qwen3-vl:8b on CPU) were too slow and wrong.

## 2. Data model (build first)

One document. State = replay of an op log. Carried over from prototype v2
(`~/mockups/sketch3d/v2/src/model.js`), which worked for fork/merge.

```ts
type Vec3 = [number, number, number];          // metres, world, y up
interface Plane { id; name; kind: 'ground'|'front'|'side'|'section'|'custom';
  o: Vec3; u: Vec3; v: Vec3;                   // n = u x v
  visible: boolean; locked: boolean }
type Element =
  | { id; type: 'stroke'; plane: PlaneId; pts: [number, number][]; closed: boolean;
      shape: 'line'|'rect'|'circle'|'ellipse'|'arc'|'free'; mat?: MatId }
  | { id; type: 'volume'; plane: PlaneId; base: [number, number][]; h: number;
      wall?: { t: number /* 0.25 */; side: 'in'|'out'|'center' }; mat?: MatId; name: string }
  | { id; type: 'cut'; host: ElementId; face: number; pts: [number, number][]; depth: number }
  | { id; type: 'image'; plane: PlaneId; src: FileRef; rect: [u0, v0, w, h]; opacity: number;
      calib?: { px: [[x, y], [x, y]]; metres: number }; vp?: VanishingSetup }
  | { id; type: 'note'; plane?: PlaneId; region: [number, number][]; text: string;
      author: 'user'|'ai'; status: 'open'|'done' }
interface Op { id: string /* ulid */; label: string; author: 'user'|'ai'|'import';
  t: number; ch: { id: ElementId; el: Element | null }[]; mergeOf?: VariantId }
interface Variant { id; name; from?: VariantId; ops: Op[] }
interface SketchDoc { schema: 'sketch3d/1'; id; title; planes: Plane[];
  materials: Record<MatId, Material>; variants: Variant[]; main: VariantId }
```

Rules:
- Points live in plane coordinates (u, v metres), not world. A plane move moves
  its drawing. World = `o + u*x + v*y`. Clamp ±30 m.
- Each op change is a full element snapshot (`el = null` deletes). Replay is a
  fold. Undo = pop op. This makes merge per element trivial.
- Merge = ops of source not in target; conflict = element touched on both sides
  since the fork; the user picks per element (v2 dialog).
- `parseSketch(json)` is the only gate for imported/AI data: schema version,
  ids, finite numbers, bounds, plane refs, max sizes. Reject, never repair.
- AI changes arrive as ops with `author: 'ai'` on a new variant `AI · <time>`,
  never on main. The user merges.

Pure modules (vitest, tests first): `doc.ts` (types + parseSketch), `ops.ts`
(replay, commit, undo), `merge.ts` (plan + apply), `plane.ts` (plane <-> world,
pick ray hit), `extrude.ts` (polygon + h -> mesh; wall offset), `recognize.ts`
(pen stroke -> line/rect/circle/ellipse/arc, auto-close).

## 3. Build order

1. Data model: pure modules above + tests. JSON export/import. No UI.
2. Pen/plane/volume core: route `/sketch`, three.js viewport (z-buffer, real
   section cut via clipping planes), pointer events (`pointerType`, `pressure`,
   palm rejection = ignore `touch` while a `pen` is down or near), plane chips,
   push/pull, wall mode, materials. Persist the doc in PocketBase
   (`sketches` collection, JSON field) + IndexedDB offline copy.
3. Import + manual trace: image from file or Moodboard inspiration,
   calibration, LSD lines as pen snap guides, vanishing points -> camera.
   Works offline, no image leaves the device.
4. MCP server: `get_sketch`, `apply_ops`, `add_note`, `list_notes`, `snapshot`,
   `render`. Uses the same `ops.ts` + `parseSketch`. Local/tailnet only.
5. AI auto-trace as the first MCP client: model gets the image + camera, writes
   ops to an `AI` variant, user merges. Off until Angelos approves sending
   images to the model provider.

Done so far: `web/src/lib/sketch3d/ops.ts` (replay, fork, mergePlan, merge)
with `web/tests/sketch3d-ops.test.ts`.

## 4. Reuse from `origin/feat/house-3d` (do not merge)

Candidates only, read before copying: `scene.ts` (three.js setup), `snap.ts`,
`gesture.ts` (pinch/orbit), `server/migrations/*_house_models.go` (collection
pattern), `scripts/house-e2e.mjs` (test stack recipe).

## 5. Open product questions (for Angelos)

- Tool list I/T/D/K/M/CO/O/TR/EX/F/CH/MI/DI/G/LK/Q: not judged yet.
- Tailscale on the tablet: not confirmed.
