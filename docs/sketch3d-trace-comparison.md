# Image to sketch: comparison (2026-11-26)

Question: what turns a render into a usable sketch best: (a) classic line
extraction, (b) a vision model that looks at the image and writes sketch
elements, or a mix?

Inputs: 7 renders from the Moodboard inspirations (4 exterior, 3 interior),
scaled to 1600 px long side. The images are private: they are not in this repo.
Scripts, overlays and JSON: `~/mockups/sketch3d/trace-compare/` (mini PC).

## Method

- (a) Classic: OpenCV LSD segments (min 2% of diagonal), Manhattan vanishing
  points by RANSAC (vertical + 2 horizontal), junction graph, closed 4-cycles.
  "Classic+" adds texture suppression (>= 3 close parallel neighbours), collinear
  merge, endpoint extension to junctions.
- (b) Vision model, same prompt and JSON schema for every model: labelled
  polygons (0-1000 image coords), kind (volume face, wall, slab, roof, floor,
  ceiling, opening), size guesses in metres.
  - `gemma3:4b` (local, ollama), `qwen3-vl:8b-instruct` (local, ollama, CPU only:
    this mini PC has no GPU), Claude Sonnet (Anthropic; Angelos approved these 7
    images for it).
- Mix: snap each model polygon edge to the best LSD segment (angle < 6°,
  offset < 2.5% diagonal).
- Score "align": share of polygon edge points within 0.6% of the diagonal
  (~11 px) of a Canny edge. "null" = the same polygons shifted by 3% of the
  diagonal: chance level on that image. A score only means something well
  above its null. I also looked at every overlay.

## Results

| # | type | LSD segs | texture share | closed quads (classic / +) | classic ms | Sonnet elements | align Sonnet / null | after snap | Sonnet s |
|---|---|---|---|---|---|---|---|---|---|
| 11 | exterior | 93 | 10% | 0 / 0 | 556 | 12 | 84% / 68% | 86% | 20 |
| 13 | exterior | 588 | 64% | 2 / 0 | 2043 | 11 | 87% / 48% | 87% | 24 |
| 19 | exterior | 216 | 31% | 0 / 0 | 894 | 11 | 77% / 41% | 74% | 26 |
| 20 | exterior | 224 | 48% | 0 / 0 | 705 | 10 | 70% / 62% | 67% | 19 |
| 05 | interior | 259 | 54% | 3 / 0 | 872 | 9 | 58% / 32% | 60% | 23 |
| 09 | interior | 352 | 43% | 1 / 0 | 1323 | 13 | 86% / 29% | 81% | 25 |
| 22 | interior | 713 | 93% | 0 / 0 | 2481 | 8 | 65% / 33% | 61% | 17 |

Local models:
- `gemma3:4b`, image 11: 14 polygons, median 342 px from any edge, sizes
  nonsense (6.5 m tall, 40 m deep cube). Unusable.
- `qwen3-vl:8b` (thinking variant): spent the whole token budget thinking; no
  answer after 6 min.
- `qwen3-vl:8b-instruct`, image 11: 382 s, 14 polygons, align 70% / null 48%,
  but in the overlay the boxes sit in the wrong places, overlap, and the guessed
  height is 28 m for a 2-storey house. Unusable as a sketch start.
  Image 22 (interior): 349 s, called it "exterior", 15 elements, all polygons
  empty. I stopped the run after 2 images: the result was clear and each image
  cost ~6 min of CPU.

Claude Opus (same prompt, same 7 images, Angelos approved):

| # | null | Sonnet align / median px / elements | Opus align / median px / elements |
|---|---|---|---|
| 11 | 68% | 84% / 1.9 / 12 | 89% / 1.9 / 14 |
| 13 | 48% | 87% / 2.3 / 11 | 80% / 2.9 / 12 |
| 19 | 41% | 77% / 1.9 / 11 | 74% / 2.3 / 13 |
| 20 | 62% | 70% / 3.8 / 10 | 79% / 2.9 / 11 |
| 05 | 32% | 58% / 4.8 / 9 | 62% / 4.8 / 10 |
| 09 | 29% | 86% / 1.4 / 13 | 86% / 1.9 / 14 |
| 22 | 33% | 65% / 2.7 / 8 | 63% / 4.8 / 10 |

Mean align: Sonnet 75.4%, Opus 76.3% (no real difference). Opus: 29-42 s per
image (Sonnet 17-26 s), 1-2 more elements per image (e.g. splits the
two-storey module, adds the pool basin and ground), same structure. Opus costs
more per call. Default: Sonnet. Opus only if a real draft shows Sonnet missing
parts.

## What I saw

- Classic lines are exact where they exist, and the vanishing points are right
  (vertical vs. the two horizontal directions). But: 10-93% of the line length
  is texture (wood ribs, curtains, stone), white-on-white room corners are
  missed, and almost no outline closes (0-3 quads per image). Classic+ removes
  the texture but also most true edges. No semantics: it cannot tell a wall
  from a curtain. Alone it cannot produce volumes.
- Sonnet gave the right structure on all 7: room box (floor, ceiling, side
  walls, back wall) on the interiors, volumes, slabs, roof and openings on the
  exteriors, every element closed by construction, plausible sizes (wall 0.2-0.3
  m, ceiling 2.7-3 m). Corners land within a few px on clean edges; loose on
  stone and vegetation edges (image 11 stone base, image 20). About 20 s per
  image.
- Automatic snapping to LSD lines helped on 3/7 and hurt on 4/7 (texture lines
  pull edges away). Snapping must be a user-guided pen snap, not automatic.
- Neither method gives depth. The model guesses sizes; the vanishing points from
  the classic lines give the camera (horizon, focal length), which is what
  lifts image polygons onto 3D planes.

## Decision

Mix, model-led: a vision model writes the draft sketch as ops into a new
`AI` variant; classic lines are local helpers only (vanishing points for the
camera, snap guides for the pen while the user corrects). The draft comes in
through the same `apply_ops` path as the MCP server, so the AI trace is the
first MCP client, not a separate pipeline.

Open product decision for Angelos: the only model good enough is a cloud model
(Claude). Every auto-trace then sends that image to Anthropic. Local models on
this mini PC (no GPU) are too slow and too wrong. Without approval, auto-trace
stays off and manual trace + snap still works fully offline.
