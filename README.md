# AI Blender

Describe a 3D scene, watch it get built in the browser, then edit it by hand. Ask for a change and the co-pilot edits the scene you have, so what you moved or restyled stays the way you left it.

There are two places to build. The built-in editor is a scene made of simple shapes that lives in the browser. The [Blender studio](#blender-studio) drives a real Blender, for models with real geometry and materials.

```bash
npm install
npm run dev
```

Open http://localhost:3000. That is the whole setup: one Next.js app, no database, no containers.

## The co-pilot

With no configuration the editor runs on a small built-in planner. It understands a handful of objects (table, chair, tree, house, car, lamp, …), colors, counts, sizes, "on", and moods such as night or sunset. It is there so everything works out of the box.

To describe anything in plain language, give it Claude:

```bash
cp .env.example .env.local   # then set ANTHROPIC_API_KEY
```

Restart the dev server and the co-pilot header shows the model in use. `.env.example` lists the other settings (model, reasoning effort, forcing a planner, data folder).

### Without an API key: let a Claude Code session answer

If you use Claude Code but have no API key, set `PLANNER=bridge` in `.env.local`. The app then hands each prompt to a Claude Code session open in this project, as files, and applies what the session writes back. It goes through the same tools and validation as the API route, so the result is the same kind of edit.

In the session, ask Claude to answer scene requests. It runs `npm run bridge`, which waits for a prompt and prints it, writes its answer into `.data/bridge/<request>/reply-1.json`, and listens again. `.data/bridge/GUIDE.md`, written by the app, has the protocol and the tool schemas.

This only works while that session is open and listening, and a reply takes as long as one of its turns. The chat tells you whether anyone is listening.

## Blender studio

The editor above builds scenes from its own kit of shapes. The Blender studio (the button in the top bar, or http://localhost:3000/b) builds in a real Blender instead, so the co-pilot has everything Blender has: booleans, bevels, subdivision, curves, modifiers, shader nodes, armatures, the render engines.

It needs Blender installed (found automatically in its usual place, or set `BLENDER_PATH`) and a model: an API key, or `PLANNER=bridge`.

- You type a prompt. The app starts Blender without a window and the co-pilot works in it by running Python and by looking at renders of what it made, stage by stage.
- The web page shows the model in 3D (exported from Blender after each stage, playing its animation if it has one) and the latest picture Blender rendered.
- **Render** makes a picture of the current frame, or an MP4 of the whole frame range: a draft at half size with few samples to judge the motion, or at the scene's full settings. A video is rendered frame by frame, so the page shows which frame it is on and Stop ends it after that frame.
- **Open in Blender** opens the same project in a Blender window. From then on the work happens there, in front of you, and each step is one undo. The **AI Blender** tab in the 3D viewport's sidebar holds the same conversation as the web page: type in either, read in both.
- Close Blender and the next prompt carries on without a window, from the saved file. A Blender without a window leaves by itself after 15 idle minutes and comes back with the next prompt.

The co-pilot also has [Poly Haven](https://polyhaven.com)'s free CC0 library at hand: photographed surfaces (colour, roughness, metalness, relief) and HDRI skies. It searches by words, downloads what it uses once into `.data/blender/assets/`, and builds the materials and the lighting from them, including paint that is chipped through to scanned metal along edges. It can also bring in Poly Haven's ready-made props (barrels, tyres, crates, rocks, furniture) to dress a set. This is the one thing in the studio that uses the internet; without a connection it falls back to Blender's own nodes.

Two effects ship with it and need nothing downloaded: haze, which fades a landscape toward a colour with distance, and soft puffs for dust, smoke or steam that are animated like any other object.

A project is a folder in `.data/blender/<id>/`: `scene.blend` is the scene, and it is yours to open, edit and keep.

Two things to know. The co-pilot's code runs in Blender with your user's rights, like any Blender script, so the studio's routes only answer requests from this computer. And the built-in editor and the studio are separate: a studio project is a .blend file, not a scene graph, so the outliner, inspector and timeline of the built-in editor don't apply to it. Edit by hand in Blender.

## How it works

**The scene is a tree of nodes, stored as JSON.** A node is a group, a mesh or a light. A mesh is one of thirteen unit-sized shapes: eight basic ones (box, sphere, cylinder, cone, pyramid, torus, plane, wedge), two drawn from an outline (lathe, extrude) and three generated ones (pine needles, a leafy canopy, a rock). Things like a table are a group with meshes as parts. The conventions are fixed everywhere: Y up, meters, rotation in degrees, and shapes are unit-sized so a mesh's scale is its size.

**Outlines make the shapes primitives can't.** A `lathe` spins an outline of [radius, height] points around its axis: bottles, bowls, wheels, domes. An `extrude` gives a flat polygon thickness: brackets, gears, beams, tool heads. The outline can be drawn in any units; it is fitted to the unit box, so the node's scale is still its size. Sharp corners in the outline stay crisp and gentle ones shade as a curve.

**Hard surfaces get a few extras.** A box can have a `bevel`, a radius in meters that rounds its edges and corners. A box or cylinder can have a `taper`, which narrows its top into a trapezoid, a chamfered block or a nozzle. A mesh can have an `array`, which repeats it in a row or a ring (vent slats, bolts, fan blades).

**Finishes are procedural.** A material's `wear` turns its color into old paint: chipped down to stained metal in patches, first along the object's edges, with scratches and a little relief so the paint reads as a layer. `rust` adds rough brown blooms that start at the chips and edges. Both are worked out from where each point sits on the object, in meters, so they need no textures or UVs and stay put when the object moves.

**Organic things are fused, not stacked.** A group with `blend` above zero doesn't draw its solid parts one by one. They are joined into a single smooth surface, with the seams rounded over about that many meters, and each part's color carried into the result. A bear is then a ribcage, belly, limbs and skull that become one body. Small crisp details (eyes, claws) live in a separate, non-blending child. The fused mesh is rebuilt whenever a part changes, so parts stay editable.

**A group is a joint.** Only groups move, and a group turns about its own origin. A rig is therefore nested groups with each origin at the joint it stands for: a hip holding an upper leg holding a lower leg. The clip is a set of tracks, each the keys of one group's position, rotation or scale over time. The viewport, the recorder and all three exporters sample the clip through the same function, so they agree on every frame.

**Every change is an operation.** Add, update, remove, set environment, set camera, set clip, animate. `applyOp` is a pure function that returns the new scene and the operations that undo it. The planner runs it on the server to validate what the model asks for; the browser runs the same code to apply it. Undo and redo fall out of this, and work the same for your edits and the co-pilot's.

**The co-pilot edits; it does not regenerate.** Each request sends Claude the current scene and your prompt. Claude answers with tool calls (`add_object`, `update_object`, `remove_objects`, `add_light`, `set_environment`, `animate`, `set_clip`, `set_camera`). Each call is validated, applied and streamed to the browser as soon as it arrives, so objects appear while the model is still working. A bad call goes back to the model as an error so it can correct itself.

**Your edits are remembered.** When you change a property by hand it is pinned on that node. Pins are included in what Claude sees, with the instruction to leave them alone unless you ask otherwise. The outliner marks pinned and hand-made objects with an amber dot, and the inspector lets you release a pin.

**The browser owns the open scene.** It autosaves the whole document (scene, chat, undo history) to `.data/scenes/<id>.json`. The server is stateless apart from those files.

## Editing

| | |
|---|---|
| Select | Click an object. Click again to reach a part inside it. |
| Move / rotate / resize | `G` / `R` / `S`, then drag the handles |
| Frame everything | `F` |
| Duplicate | `Ctrl+D` |
| Delete | `Delete` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Deselect | `Esc` |
| Play / pause | `Space` |
| Key the selected group here | `K` |

With nothing selected, the inspector shows the environment: sky, ambient light, sun, ground, fog, and the grade (bloom, vignette, saturation, contrast). With a group selected it shows the Blend slider; with a mesh, its bevel, wear and array. The viewport toolbar can hide the grid.

The viewport renders with ambient occlusion, bloom on anything that glows, a sky gradient with a sun glow, soft reflections from that sky, and then the scene's grade.

## Animation and video

The bar under the viewport is the timeline. Drag the playhead to scrub; diamonds mark the keys of whatever is selected. Select a group and press `K` to key its position and rotation where the playhead is. After that, moving or rotating it at another time sets a key there instead of changing its resting pose. The number is the clip's length in seconds, and the loop button chooses between repeating and playing once.

The scene has one camera, drawn as a yellow wire frame. The camera button looks through it, the one next to it makes the current view the camera, and **Record** plays the clip once through the camera and saves it as a `.webm` video. That is the viewport's picture, at the viewport's size.

For a rendered video, export the Blender script and let Blender do it:

```bash
blender -b --python Spider_mech.py -- --video out.mp4
```

`--still out.png --frame 120` renders one frame instead. `--engine cycles|eevee`, `--samples 32` and `--percent 50` are optional. A render started this way shows only the exported scene, not the startup cube. The saved scene is also served at `/api/scenes/<id>/export?format=blender` (or `usd`), so a script can fetch and render it without the browser.

## Export

- **Blender script** (`.py`): rebuilds the scene with native Blender data. Run it from the Scripting workspace or with `blender --python scene.py`. It adds a collection with its own camera, and sets the world, the frame range and the compositor; it deletes nothing, so run it in an empty file. What it makes:
  - **Meshes** at their real size (scale applied), each with a **UV map** from Smart UV Project.
  - **Materials**: Principled BSDF, plus a procedural node setup for `wear` and `rust`: noise picks where the paint has chipped, each object tells the material where its edges are, and a bump gives the layers relief. One material per finish, shared by every object that uses it.
  - **World**: a sky to be lit by and to reflect (lighter at the horizon, a glow around the sun), while the camera sees the plain background color like a studio backdrop. Animated scenes render with motion blur.
  - **Geometry Nodes**: each array is a modifier using one shared node group, so the count, step and turn stay editable.
  - **Rig**: anything animated becomes an armature with one bone per group, the parts parented to their bones, and the clip baked onto the bones as keyframes. Rigid parts are bone-parented, not skinned.
  - **Compositor**: bloom, saturation, contrast and vignette from the grade, and fog as distance haze from the mist pass.
- **OpenUSD** (`.usda`): Y-up stage with the hierarchy under `/World/Geometry`, `UsdPreviewSurface` materials, the camera, and the sun, sky and ground under `/World/Environment`. Animation is written as time samples.
- **glTF** (`.glb`): meshes, materials, lights, the camera and the animation.

Fused bodies and generated shapes are exported as real meshes with their colors per point, so they look the same elsewhere. They are detailed, which makes files large: a scene with a few trees and figures is several megabytes as `.usda`.

Light brightness is approximate in all three, because renderers disagree on light units. The worn finish and the grade exist only in the viewport and in Blender; USD and glTF get the plain color. Arrays are written out copy by copy in USD and glTF.

The Blender script is checked against Blender 5.2. The rig, meshes and materials use long-standing API; the compositor, the Geometry Nodes modifier and the UV unwrap are each attempted separately, so an older Blender that lacks one of them prints a line saying so and still builds the rest (arrays then become one linked object per copy).

## Code

```
app/                 pages and API routes
  api/plan           POST: runs the planner, streams its events (SSE)
  api/scenes         list, create, load, save, delete, export
  api/blender        studio projects: state, prompts, actions, files
  api/engine         where a running Blender asks for work
  s/[id]             the editor
  b/[id]             the Blender studio
blender/engine.py    runs inside Blender: does the app's jobs, adds the sidebar tab
blender/polyhaven.py the co-pilot's asset library: scanned surfaces, HDRI skies, props
blender/effects.py   haze and puffs of dust or smoke
src/
  blender/           the hub between app and Blender, project files, tools and prompt for Blender
  scene/             scene model, operations, undo inverses, animation sampling
  planner/           tools, Claude loop, session bridge, offline planner, system prompt
  shapes/            fused surfaces, generated shapes (pine, canopy, rock), rounded boxes
  export/            Blender, USD and glTF writers
  client/            editor store, autosave, planner stream reader, camera and recording
  components/        viewport, timeline, outliner, inspector, chat, the studio page
  server/            scene files on disk
  three/             shared geometry, the worn-finish shader
scripts/bridge.mjs   the session's side of the bridge planner
```

```bash
npm test            # vitest
npm run typecheck
npm run lint
npm run build
```

## Not built yet

In the built-in editor (the Blender studio has all of Blender, so these limits don't apply there):

- Scanned or model-generated meshes. Everything is built from the shapes above, so people and animals come out as smooth sculpted figures, not photoreal ones; there is no text-to-mesh model behind an object.
- Cuts and holes (booleans), subdivision and sculpting. Shapes are primitives, outlines and fused blobs.
- Image textures. Finishes are a color with roughness, metalness, wear and rust; there is no fur, bark or fabric detail, and the UV maps the Blender export makes are there for your own texturing.
- Rendering in Blender from the app. Export the script and render there, or record the viewport.

In the Blender studio:

- Moving an editor scene into a studio project, other than by running its exported script in Blender yourself.
- Selecting and editing objects on the web page. The page shows the model and the conversation; hands-on editing is done in Blender.
- Procedural materials in the web preview: the preview shows what glTF can carry, the Picture tab shows the real thing.
- Keeping Blender usable during a render started from the page: a Blender with a window is busy until the render ends.
- Scanned textures in the web preview: surfaces projected without a UV map show there as their overall colour.
- Simulated smoke, fluid or cloth. Dust and smoke are puffs animated by hand, which is cheap and controllable but not physics.

In both:

- Skinning. Rigs move rigid parts; a fused body can be rigged joint by joint but its skin doesn't stretch across a bending joint.
- A moving camera, and editing a key's easing by hand (the co-pilot can set it).
- Accounts or simultaneous editing. It is a single-user, local app.
