<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Working in this repo

README.md explains the design. The rules that keep it sound:

- A scene only changes through ops (`src/scene/ops.ts`). Don't edit `scene.nodes` directly; add or extend an op, with its inverse, and test the round trip.
- The scene conventions (Y up, meters, degrees, unit-sized primitives) are relied on by the viewport, the planner prompt and all three exporters. A change to one is a change to all of them.
- A new basic primitive needs four things: `PRIMITIVES` and `PRIMITIVE_INFO` in `src/scene/types.ts`, viewport geometry in `src/three/geometry.ts`, polygon data in `src/export/meshdata.ts`, and a case in the USD writer. The export tests check that the last two agree with the viewport. To be fusable it also needs a distance function in `src/shapes/blend.ts`.
- A mesh node's shape can depend on the node (a beveled box depends on its size). Draw and export through `nodeGeometry` / `nodeMesh`, not the bare primitive (`shapeKey` says whether a node has a shape of its own, from its bevel and taper), and through `arrayCopies` for a node's `array`, or bevels and copies go missing in one place.
- Only groups are animated, and everything that plays or exports the clip samples it with `sampleTrack` (`src/scene/animate.ts`). Don't interpolate keys anywhere else: the exporters bake one sample per frame precisely so that Blender, USD and glTF move exactly like the viewport.
- The worn and rusty finish exists twice, as GLSL in `src/three/wear.ts` and as shader nodes in the Blender script (`add_wear`). Their shared numbers live in `src/scene/finish.ts`; change the look in both or they drift apart. Both need to know where an object's edges are: the viewport reads the size from the model matrix and the edge kind from `edgesOf`, Blender reads the `ab_half` and `ab_round` properties the script sets on each object.
- A lathe or an extrude is drawn from the node's `outline` (`src/shapes/profile.ts`), stored fitted to the unit box by `fitOutline` so that scale stays the size. Nothing else needs to know about outlines: they reach the viewport and every exporter through `shapeKey` / `nodeMesh`.
- A generated shape (pine, canopy, rock) is one mesh in `src/shapes/natural.ts`, registered in `meshdata.ts`. The viewport and every exporter draw that same mesh, so there is nothing to keep in sync. It must fit the unit cube and be deterministic.
- A group with `blend` above zero replaces its solid children with one fused mesh. Anything that draws or exports meshes has to ask `isFused` before drawing a mesh node and `fusedMesh` for the group, or parts will appear twice.
- Planner tools (`src/planner/tools.ts`) are the model-facing surface. Their descriptions are prompt text. `SYSTEM_PROMPT` must stay free of anything request-specific, because it is cached.
- The Blender script embeds scene data as a JSON string literal so that names can never execute. Keep it that way: no string-building of Python from scene content.
- The Blender script has to run on more than one Blender version. Anything version-specific (compositor, Geometry Nodes, operators) goes through `attempt`, so a failure costs that stage and not the scene. It was last checked against Blender 5.2 with the `bpy` module: build the scene, compare every object's world matrix with the data on several frames, and render a frame.

The Blender studio (`src/blender/`, `blender/engine.py`, `app/b`, `app/api/blender`, `app/api/engine`) is a second way to build, separate from the scene graph:

- Its scene is a .blend file in a running Blender, not a `Scene`. Nothing in `src/scene`, `src/export` or the editor store applies to it; don't try to mirror one into the other.
- The hub (`src/blender/hub.ts`) owns a project's state and every write to project.json. Pages and Blender's sidebar only read state (`GET /api/blender/<id>?after=<rev>`) and post prompts or actions. A turn runs in the hub, not in the request that started it, which is what lets both places watch the same turn.
- Blender asks for work (`POST /api/engine`, held open); the hub never calls into Blender. Jobs run on Blender's main thread: in a window through a timer, never from the network thread.
- The co-pilot's Python runs in Blender unsandboxed. That is the point of the studio, and why every studio route goes through `respond` (local requests only) and why an engine must present the token the hub gave it. Keep both.
- `blender/engine.py` uses only the standard library and what ships with Blender, and must work with and without a window. A look has to leave the scene's render settings as it found them (`Keep`).
- `src/blender/tools.ts` and `prompt.ts` are model-facing, like the planner's. `BLENDER_PROMPT` must stay free of anything request-specific or subject-specific.

Checks: `npm test`, `npm run typecheck`, `npm run lint`.
