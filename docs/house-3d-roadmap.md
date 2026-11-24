# 3D house editor: next steps

The MVP (route `/house?project=<id>`) draws walls, windows, doors, floors, pools and volumes, paints
them from a material library, autosaves a draft per project, keeps named versions, and exports `.glb`
and a semantic JSON (`docs/house-3d-schema.md`). These are the next steps, roughly in order of value.

## Editing gaps in the MVP

- Move and reshape on the canvas: drag wall corners, drag openings along a wall, move/rotate a pool
  or volume by hand (today: numbers in the inspector).
- Several storeys: a `level` on each element, a level switcher, slabs as floors between levels.
- Roofs: a pitched-roof element (outline + pitch + overhang) instead of a flat volume.
- Measured input while drawing: type a length or angle for the next wall segment.
- Snap to the wall face or axis of an existing wall, not only to its corners.

## AI suggestions (dashed lines, variants)

- An agent reads the semantic JSON plus the board's images and notes (the MCP server already has
  them) and returns a changed model.
- The editor shows the change as dashed "ghost" elements (the viewport already has a ghost layer);
  the user accepts or rejects each one.
- Variants: the agent returns 2-3 models; they open as unsaved versions to compare side by side.
- Needed: an MCP tool `get_house_model` / `propose_house_model`, and a diff of two models by element id.

## Preview renders with an image model

- Export the current view as a PNG (`HouseViewport.snapshot()` exists) plus the element/material list.
- Send both to an image model (ChatGPT Images, or a separate ChatGPT through MCP) with the board's
  mood images as style references; show the render next to the model and keep it with the version.
- Keep it opt-in, like «Έξυπνη αναζήτηση»: the images leave the server.

## Choices and comments with engineers and the client

- Share a version read-only through the public board link (`/s/<project>`), with the 3D view.
- Comments pinned to an element id; a status per comment (open/resolved).
- Option sets: "kitchen A / kitchen B" as alternatives on the same model, picked by the client.
- Real-time multi-user editing (PocketBase realtime on `house_models`, element-level merge).

## Exports for CAD and BIM

- IFC 4 export (`IfcWall` with `IfcOpeningElement` + `IfcRelVoidsElement`, `IfcSlab`, proxies), for
  example through IfcOpenShell in a small server job, or web-ifc in the browser.
- DXF plan export (walls as double lines, openings as gaps, layers per type) for ZWCAD/AutoCAD.
- Until then, the semantic JSON is the bridge: an agent turns it into Revit/ArchiCAD API calls.

## Templates

- Start from a template: rectangle house, L-shape, house with courtyard and pool.
- Save my own model as a template for later projects.
