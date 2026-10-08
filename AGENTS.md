<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Working in this repo

README.md explains the design. The rules that keep it sound:

- A scene only changes through ops (`src/scene/ops.ts`). Don't edit `scene.nodes` directly; add or extend an op, with its inverse, and test the round trip.
- The scene conventions (Y up, meters, degrees, unit-sized primitives) are relied on by the viewport, the planner prompt and all three exporters. A change to one is a change to all of them.
- A new basic primitive needs four things: `PRIMITIVES` and `PRIMITIVE_INFO` in `src/scene/types.ts`, viewport geometry in `src/three/geometry.ts`, polygon data in `src/export/meshdata.ts`, and a case in the USD writer. The export tests check that the last two agree with the viewport. To be fusable it also needs a distance function in `src/shapes/blend.ts`.
- A mesh node's shape can depend on the node (a beveled box depends on its size). Draw and export through `nodeGeometry` / `nodeMesh`, not the bare primitive, and through `arrayCopies` for a node's `array`, or bevels and copies go missing in one place.
- Only groups are animated, and everything that plays or exports the clip samples it with `sampleTrack` (`src/scene/animate.ts`). Don't interpolate keys anywhere else: the exporters bake one sample per frame precisely so that Blender, USD and glTF move exactly like the viewport.
- The worn finish exists twice, as GLSL in `src/three/wear.ts` and as shader nodes in the Blender script. Their shared numbers live in `src/scene/finish.ts`; change the look in both or they drift apart.
- A generated shape (pine, canopy, rock) is one mesh in `src/shapes/natural.ts`, registered in `meshdata.ts`. The viewport and every exporter draw that same mesh, so there is nothing to keep in sync. It must fit the unit cube and be deterministic.
- A group with `blend` above zero replaces its solid children with one fused mesh. Anything that draws or exports meshes has to ask `isFused` before drawing a mesh node and `fusedMesh` for the group, or parts will appear twice.
- Planner tools (`src/planner/tools.ts`) are the model-facing surface. Their descriptions are prompt text. `SYSTEM_PROMPT` must stay free of anything request-specific, because it is cached.
- The Blender script embeds scene data as a JSON string literal so that names can never execute. Keep it that way: no string-building of Python from scene content.
- The Blender script has to run on more than one Blender version. Anything version-specific (compositor, Geometry Nodes, operators) goes through `attempt`, so a failure costs that stage and not the scene. It was last checked against Blender 5.2 with the `bpy` module: build the scene, compare every object's world matrix with the data on several frames, and render a frame.

Checks: `npm test`, `npm run typecheck`, `npm run lint`.
