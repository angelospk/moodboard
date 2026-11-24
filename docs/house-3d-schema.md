# moodboard.house/v1 — semantic house export

Machine-readable description of a house designed in the moodboard 3D editor. Goal: an AI agent (or a person)
rebuilds the same design in Revit, ArchiCAD or ZWCAD without guessing. Validate a document against
[`house-3d-schema.json`](./house-3d-schema.json) (JSON Schema 2020-12; every property has a `description`).

## Units and axes

- Lengths in **metres**, angles in **degrees**, areas in m², volumes in m³. Numbers are rounded to 6 decimals.
- Right-handed, **z up**. Plan: **x east, y north**. Ground at **z = 0**. This is the IFC / CAD convention.
- Rotation is counter-clockwise seen from above.

## Elements

Every element has `id`, `type`, `ifcClass`, `name` (may be empty), `material`, plus the fields below.
`quantities` are precomputed: use them to check your model.

| type | ifcClass | key fields |
|---|---|---|
| `wall` | `IfcWall` | `geometry.points` (centreline polyline), `base`, `height`, `thickness`; `openingIds` |
| `window` | `IfcWindow` | `hostId`, `geometry` (`segment`, `offset`, `width`, `height`, `sill`), `placement` |
| `door` | `IfcDoor` | same as window, `sill` is 0 |
| `slab` | `IfcSlab` | `geometry.outline` (closed polygon, last point not repeated), `elevation` (top), `thickness` |
| `pool` | `IfcBuildingElementProxy`, `objectType: "SwimmingPool"` | `center`, `width` (x), `length` (y), `rotation`, `depth` below z = 0 |
| `box` | `IfcBuildingElementProxy`, `objectType: "Volume"` | `center`, `width`, `length`, `rotation`, `base`, `height` |

## How openings attach to walls

- A window or door has `hostId` = id of its wall. The wall lists them in `openingIds`.
- `geometry.segment` picks one straight segment of the wall polyline: `points[segment]` to `points[segment + 1]`.
- `geometry.offset` is the distance along that segment to the **centre** of the opening.
- `geometry.sill` is the height of the opening bottom above the wall `base`.
- `placement.point` is ready to use: bottom centre of the opening on the wall centreline, `z = base + sill`.
  `placement.direction` is the unit vector along the wall segment (the width axis).

## Materials

`material` is inlined in each element (`id`, English `name`, sRGB `color`, `category`, `description`).
Library:

| id | name | colour | category | description |
|---|---|---|---|---|
| `plaster_white` | White plaster | `#eeebe4` | plaster | Painted render on a wall, off-white. |
| `plaster_warm` | Ochre plaster | `#d8b98a` | plaster | Painted render in a warm earth tone. |
| `concrete` | Exposed concrete | `#a7a49d` | concrete | Cast-in-place reinforced concrete left exposed. |
| `glass` | Glass | `#9fc4d6` | glass | Clear double glazing in a window or glass door. |
| `wood_oak` | Oak wood | `#a8794a` | wood | Oak timber: doors, cladding, decking. |
| `wood_dark` | Dark wood | `#5e4330` | wood | Dark stained timber (walnut tone). |
| `pool_water` | Pool water | `#3fa7c9` | water | Water in a swimming pool with light tiles below. |
| `roof_tile` | Roof tile | `#b4532a` | ceramic | Terracotta roof tiles. |
| `brick` | Brick | `#9c5a43` | masonry | Exposed clay brick masonry. |
| `stone` | Stone | `#8f877a` | stone | Natural local stone masonry. |
| `marble` | Marble | `#e4e1da` | stone | White marble paving or cladding. |
| `steel_dark` | Dark steel | `#3b3d40` | metal | Dark painted steel or aluminium frames. |
| `grass` | Grass | `#6b8a4a` | vegetation | Lawn or planted ground. |

## Example

```json
{
  "$schema": "https://moodboard.haroldpoi.dev/schemas/house-3d-schema.json",
  "schema": "moodboard.house/v1",
  "name": "Small house",
  "units": { "length": "m", "angle": "deg" },
  "coordinateSystem": "right-handed, z up; plan x east, y north; elevations in z; ground at z = 0",
  "generator": "moodboard 3D editor",
  "elements": [
    { "id": "w1", "type": "wall", "ifcClass": "IfcWall", "name": "North wall",
      "material": { "id": "plaster_white", "name": "White plaster", "color": "#eeebe4", "category": "plaster", "description": "Painted render on a wall, off-white." },
      "geometry": { "points": [[0, 0], [6, 0]], "base": 0, "height": 3, "thickness": 0.25, "axis": "centerline" },
      "quantities": { "length": 6, "height": 3, "thickness": 0.25, "grossSideArea": 18, "volume": 4.5 },
      "openingIds": ["win1"] },
    { "id": "win1", "type": "window", "ifcClass": "IfcWindow", "name": "",
      "material": { "id": "glass", "name": "Glass", "color": "#9fc4d6", "category": "glass", "description": "Clear double glazing in a window or glass door." },
      "hostId": "w1",
      "geometry": { "segment": 0, "offset": 4, "width": 1.2, "height": 1.4, "sill": 0.9 },
      "placement": { "point": [4, 0, 0.9], "direction": [1, 0, 0] },
      "quantities": { "area": 1.68 } }
  ]
}
```

## Import hints

- **Revit**: walls by centreline with a wall type of the given `thickness` (location line = Wall Centerline),
  base constraint at `base`, unconnected height = `height`. Place windows/doors as hosted families at
  `placement.point`, then set the sill height. Slabs: Floor from the `outline` sketch at `elevation`
  (top), thickness `thickness`. Pool and box: mass or generic model, category noted by `objectType`.
- **ArchiCAD**: Wall tool with reference line = centre; Window/Door tools hosted in the wall at `placement.point`;
  Slab tool for slabs (top at `elevation`); Morph for pool and box.
- **ZWCAD / AutoCAD-like**: polyline offsets by `thickness / 2` for walls, extrude by `height`; slabs and boxes
  as extruded polylines; cut openings with boxes of `width` x wall `thickness` x `height`.
- **IFC**: use `ifcClass`; for `IfcBuildingElementProxy` set `ObjectType` from `objectType`.
- Check results against `quantities` (lengths, areas, volumes) before you finish.
