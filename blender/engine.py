"""
AI Blender engine: lets the AI Blender app drive this Blender.

The app starts Blender with this script, with or without a window:

    blender [-b] [scene.blend] --python engine.py -- \
        --server http://localhost:3000 --project <id> --blend <path> [--fresh]

The script asks the app for jobs (run this Python, render a look, save and
export), does each on Blender's main thread and reports back. With a window it
also adds an "AI Blender" tab to the 3D viewport's sidebar, showing the same
conversation as the web page.

Only the standard library and what ships with Blender are used.
"""

import contextlib
import io
import json
import linecache
import math
import os
import queue
import sys
import textwrap
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

import bmesh
import bpy
import mathutils
from mathutils import Euler, Matrix, Quaternion, Vector


def option(name, default=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if name in argv and argv.index(name) + 1 < len(argv):
        return argv[argv.index(name) + 1]
    return default


def flag(name):
    return "--" in sys.argv and name in sys.argv[sys.argv.index("--") + 1:]


SERVER = (option("--server") or "http://localhost:3000").rstrip("/")
PROJECT = option("--project") or ""
BLEND = option("--blend") or ""
TOKEN = os.environ.get("AI_BLENDER_TOKEN", "")
ENGINE = uuid.uuid4().hex[:12]
HEADLESS = bpy.app.background
# A Blender without a window leaves when nobody has needed it for this long.
IDLE_SECONDS = float(option("--idle") or 900)

# The app is on this machine, so a system proxy must not get in the way.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, body=None, timeout=45):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-AI-Blender": TOKEN}
    call = urllib.request.Request(SERVER + path, data=data, headers=headers)
    with OPENER.open(call, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


# ─── Jobs ───────────────────────────────────────────────────────────

# What the co-pilot's code starts with. It persists between calls, so helpers
# defined in one call can be used in the next.
NAMESPACE = {
    "__name__": "__ai__",
    "bpy": bpy,
    "bmesh": bmesh,
    "mathutils": mathutils,
    "math": math,
    "Vector": Vector,
    "Matrix": Matrix,
    "Euler": Euler,
    "Quaternion": Quaternion,
}

OUTPUT_LIMIT = 6000
LISTED_OBJECTS = 150
# Object types that take up room, for framing a look.
SOLID = {"MESH", "CURVE", "SURFACE", "FONT", "META", "VOLUME", "POINTCLOUD", "CURVES"}


def rounded(values, digits=3):
    return [round(v, digits) for v in values]


def summary():
    """What is in the scene, compactly: the co-pilot reads this instead of guessing."""
    scene = bpy.context.scene
    objects = []
    for ob in list(scene.objects)[:LISTED_OBJECTS]:
        item = {"name": ob.name, "type": ob.type, "at": rounded(ob.matrix_world.translation)}
        if ob.type in SOLID:
            item["size"] = rounded(ob.dimensions)
        if ob.parent:
            item["parent"] = ob.parent.name
        if ob.type == "MESH":
            item["polys"] = len(ob.data.polygons)
        if ob.modifiers:
            item["modifiers"] = [m.type for m in ob.modifiers]
        materials = [slot.material.name for slot in ob.material_slots if slot.material]
        if materials:
            item["materials"] = materials
        if ob.users_collection and ob.users_collection[0] != scene.collection:
            item["collection"] = ob.users_collection[0].name
        if ob.hide_render:
            item["hidden"] = True
        if ob.animation_data and ob.animation_data.action:
            item["animated"] = True
        objects.append(item)
    result = {
        "objects": objects,
        "camera": scene.camera.name if scene.camera else None,
        "render": {
            "engine": scene.render.engine,
            "size": [scene.render.resolution_x, scene.render.resolution_y],
        },
        "frames": {"start": scene.frame_start, "end": scene.frame_end, "fps": scene.render.fps, "current": scene.frame_current},
    }
    if len(scene.objects) > LISTED_OBJECTS:
        result["more"] = len(scene.objects) - LISTED_OBJECTS
    return result


def ui_context():
    """A 3D viewport to run in, so operators that need one work from a timer."""
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                return {"window": window, "screen": window.screen, "area": area, "region": region}
    return {}


def run_python(job):
    code = job["code"]
    # Lets a traceback show the line of the co-pilot's code that failed.
    linecache.cache["<ai>"] = (len(code), None, code.splitlines(True), "<ai>")
    out = io.StringIO()
    error = None
    try:
        if not HEADLESS and bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        with contextlib.redirect_stdout(out):
            exec(compile(code, "<ai>", "exec"), NAMESPACE)
    except BaseException as err:  # includes SystemExit: the code must not end Blender
        if isinstance(err, KeyboardInterrupt):
            raise
        lines = traceback.format_exc().splitlines()
        # Drop this file's own frames; keep the co-pilot's and the error.
        start = next((i for i, line in enumerate(lines) if line.lstrip().startswith('File "<ai>"')), 1)
        error = "\n".join(lines[start:])[-OUTPUT_LIMIT:]
    if not HEADLESS:
        with contextlib.suppress(Exception):
            bpy.ops.ed.undo_push(message="AI Blender")
    return {"ok": error is None, "output": out.getvalue()[-OUTPUT_LIMIT:], "error": error}


# View directions: where the camera stands, seen from the subject. "front" is
# Blender's Front view, so a subject should face -Y.
VIEWS = {
    "front": (0, -1, 0.12),
    "back": (0, 1, 0.12),
    "right": (1, 0, 0.12),
    "left": (-1, 0, 0.12),
    "top": (0, -0.02, 1),
    "bottom": (0, -0.02, -1),
    "three-quarter": (0.8, -1, 0.55),
    "rear-quarter": (-0.8, 1, 0.55),
}


def framed(names):
    """The center and radius of what a look should show, and a note about it."""
    scene = bpy.context.scene
    bpy.context.view_layer.update()
    notes = []
    if names:
        picked = []
        for name in names:
            ob = scene.objects.get(name)
            if ob:
                picked += [ob, *ob.children_recursive]
            else:
                notes.append('no object named "%s"' % name)
    else:
        picked = [ob for ob in scene.objects if not ob.hide_render and ob.visible_get()]

    boxes = []
    for ob in picked:
        if ob.type not in SOLID:
            continue
        corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        extent = [max(c[i] for c in corners) - min(c[i] for c in corners) for i in range(3)]
        boxes.append((ob, corners, min(extent) < 0.02 * max(extent), max(extent)))

    def sphere(group):
        points = [c for _, corners, _, _ in group for c in corners]
        low = Vector([min(p[i] for p in points) for i in range(3)])
        high = Vector([max(p[i] for p in points) for i in range(3)])
        center = (low + high) / 2
        return center, max((p - center).length for p in points)

    kept = boxes
    solids = [b for b in boxes if not b[2]]
    if not names and solids and len(solids) < len(boxes):
        # A ground or backdrop far larger than the subject would shrink it to a dot.
        _, radius = sphere(solids)
        kept = [b for b in boxes if not (b[2] and b[3] > 4 * radius)]
        dropped = [b[0].name for b in boxes if b not in kept]
        if dropped:
            notes.append("framed without " + ", ".join(dropped))
    if not kept:
        return Vector((0, 0, 0)), 1.0, notes + ["nothing to frame"]
    center, radius = sphere(kept)
    return center, max(radius, 1e-4), notes


def contact_sheet(paths, out, width, height):
    """Tiles the views into one picture, two across, in the order given."""
    import numpy

    columns = 2
    rows = math.ceil(len(paths) / columns)
    canvas = numpy.zeros((rows * height, columns * width, 4), numpy.float32)
    canvas[..., 3] = 1
    for index, path in enumerate(paths):
        image = bpy.data.images.load(path)
        pixels = numpy.empty(width * height * 4, numpy.float32)
        image.pixels.foreach_get(pixels)
        bpy.data.images.remove(image)
        row, column = divmod(index, columns)
        top = (rows - 1 - row) * height  # pixel rows run bottom to top
        canvas[top:top + height, column * width:(column + 1) * width] = pixels.reshape(height, width, 4)
    sheet = bpy.data.images.new("__ab_sheet", columns * width, rows * height)
    sheet.pixels.foreach_set(canvas.ravel())
    sheet.filepath_raw = out
    sheet.file_format = "PNG"
    sheet.save()
    bpy.data.images.remove(sheet)


class Keep:
    """Remembers attributes so a look leaves the scene's settings as it found them."""

    def __init__(self):
        self.saved = []

    def set(self, owner, name, value):
        if not hasattr(owner, name):
            return
        self.saved.append((owner, name, getattr(owner, name)))
        with contextlib.suppress(Exception):
            setattr(owner, name, value)

    def restore(self):
        for owner, name, value in reversed(self.saved):
            with contextlib.suppress(Exception):
                setattr(owner, name, value)


def look(job):
    scene = bpy.context.scene
    render = scene.render
    width, height = job.get("size") or (800, 600)
    views = job.get("views") or ["three-quarter"]
    shading = job.get("shading") or "clay"
    if views == ["camera"] and scene.camera:
        # The scene's own shot, in its own proportions.
        height = max(2, round(width * render.resolution_y / render.resolution_x / 2) * 2)
    center, radius, notes = framed(job.get("objects") or [])

    keep = Keep()
    own_camera = scene.camera
    frame = scene.frame_current
    data = bpy.data.cameras.new("__ab_look")
    camera = bpy.data.objects.new("__ab_look", data)
    scene.collection.objects.link(camera)
    data.lens = 50
    vertical = 2 * math.atan(math.tan(data.angle / 2) * min(1, height / width))
    distance = radius / math.sin(min(vertical, data.angle) / 2) * 1.04
    data.clip_start = max(distance / 2000, 0.0005)
    data.clip_end = distance + radius * 8

    paths = []
    try:
        if job.get("frame") is not None:
            scene.frame_set(int(job["frame"]))
        keep.set(render, "resolution_x", width)
        keep.set(render, "resolution_y", height)
        keep.set(render, "resolution_percentage", 100)
        keep.set(render, "filepath", "")
        keep.set(render, "use_file_extension", True)
        keep.set(render.image_settings, "media_type", "IMAGE")
        keep.set(render.image_settings, "file_format", "PNG")
        keep.set(render.image_settings, "color_mode", "RGB")
        if shading == "render":
            if render.engine == "CYCLES":
                keep.set(scene.cycles, "samples", min(scene.cycles.samples, 48))
            elif hasattr(scene, "eevee"):
                keep.set(scene.eevee, "taa_render_samples", min(scene.eevee.taa_render_samples, 24))
        else:
            keep.set(render, "engine", "BLENDER_WORKBENCH")
            keep.set(render, "use_compositing", False)
            keep.set(render, "use_sequencer", False)
            keep.set(render, "film_transparent", False)
            look_shading = scene.display.shading
            keep.set(look_shading, "light", "STUDIO")
            keep.set(look_shading, "color_type", "RANDOM" if shading == "parts" else "SINGLE")
            keep.set(look_shading, "single_color", (0.72, 0.72, 0.72))
            keep.set(look_shading, "show_cavity", True)
            keep.set(look_shading, "cavity_type", "BOTH")
            keep.set(look_shading, "show_shadows", True)
            keep.set(look_shading, "show_object_outline", True)

        for index, view in enumerate(views):
            if view == "camera" and own_camera:
                scene.camera = own_camera
            else:
                if view == "camera":
                    notes.append("the scene has no camera, so this is a three-quarter view")
                direction = Vector(VIEWS.get(view, VIEWS["three-quarter"])).normalized()
                camera.location = center + direction * distance
                camera.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
                scene.camera = camera
            path = "%s.%d.png" % (job["out"], index)
            render.filepath = path
            bpy.ops.render.render(write_still=True)
            paths.append(path)

        if len(paths) == 1:
            os.replace(paths[0], job["out"])
        else:
            contact_sheet(paths, job["out"], width, height)
    finally:
        keep.restore()
        scene.camera = own_camera
        bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.cameras.remove(data)
        if job.get("frame") is not None:
            scene.frame_set(frame)
        for path in paths:
            with contextlib.suppress(OSError):
                os.remove(path)

    shown = ", ".join(views) if len(views) == 1 else "a grid, left to right and top to bottom: " + ", ".join(views)
    return {"ok": True, "output": "; ".join(["shows " + shown] + notes), "files": [job["out"]]}


def save_blend():
    """Saves the project file. Returns a note when it can't."""
    if not BLEND:
        return "This Blender has no project file."
    here = bpy.data.filepath
    same = os.path.normcase(os.path.abspath(here)) == os.path.normcase(os.path.abspath(BLEND))
    if here and not same:
        return "A different file is open in Blender, so the project file was not saved."
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, check_existing=False, compress=True)
    return None


def save(job):
    notes = []
    files = []
    try:
        note = save_blend()
        if note:
            notes.append(note)
    except Exception as err:
        notes.append("Could not save the project file: %s" % err)
    if job.get("glb"):
        try:
            bpy.ops.export_scene.gltf(
                filepath=job["glb"],
                export_format="GLB",
                export_apply=True,
                use_visible=True,
                export_cameras=False,
                export_lights=False,
            )
            files.append(job["glb"])
        except Exception as err:
            notes.append("Could not export the web preview: %s" % err)
    return {"ok": True, "output": "\n".join(notes), "files": files}


def render_still(job):
    render = bpy.context.scene.render
    keep = Keep()
    keep.set(render, "filepath", job["out"])
    keep.set(render.image_settings, "media_type", "IMAGE")
    keep.set(render.image_settings, "file_format", "PNG")
    try:
        if not bpy.context.scene.camera:
            return {"ok": False, "error": "The scene has no camera to render from. Ask the co-pilot to set one up."}
        bpy.ops.render.render(write_still=True)
    finally:
        keep.restore()
    return {"ok": True, "files": [job["out"]]}


JOBS = {"python": run_python, "look": look, "save": save, "render": render_still}


def execute(job):
    """Does one job. Never raises: whatever goes wrong is the job's result."""
    result = {"ok": False, "output": "", "error": None, "files": []}
    try:
        handler = JOBS.get(job.get("kind"))
        if not handler:
            result["error"] = "This engine does not know the job %r." % job.get("kind")
        elif HEADLESS:
            result.update(handler(job))
        else:
            with bpy.context.temp_override(**ui_context()):
                result.update(handler(job))
    except Exception:
        result["error"] = traceback.format_exc()[-OUTPUT_LIMIT:]
    try:
        result["summary"] = summary()
    except Exception:
        result["summary"] = None
    result["job"] = job.get("id")
    return result


def start_fresh():
    """A new project starts empty, not with the default cube."""
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for blocks in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.materials):
        for block in list(blocks):
            if block.users == 0:
                blocks.remove(block)
    with contextlib.suppress(Exception):
        save_blend()


# ─── Talking to the app ─────────────────────────────────────────────

STATE = {"chat": [], "busy": False, "status": "", "live": "", "rev": None, "note": "Connecting…", "dirty": False}
inbox = queue.Queue()
outbox = queue.Queue()


def note(text):
    STATE["note"] = text
    STATE["dirty"] = True


def hello(extra=None):
    body = {
        "project": PROJECT,
        "engine": ENGINE,
        "token": TOKEN,
        "mode": "headless" if HEADLESS else "ui",
        "version": bpy.app.version_string,
    }
    body.update(extra or {})
    return body


def serve():
    """Takes jobs from the app until told to stop. In a window this runs on a thread."""
    done = None
    failures = 0
    last_work = time.time()
    while True:
        try:
            reply = request("/api/engine", hello({"done": done} if done else None))
        except urllib.error.HTTPError as err:
            if err.code in (403, 404, 410):
                note("The app no longer knows this Blender. Open the project from the web page again.")
                return
            reply = None
        except Exception:
            reply = None
        if reply is None:
            failures += 1
            # Without a window nobody is watching, so don't outlive the app for long.
            if HEADLESS and failures > 40:
                return
            if failures == 3:
                note("Can't reach the app at %s." % SERVER)
            time.sleep(1.5)
            continue
        done = None
        failures = 0
        if reply.get("gone"):
            note("Another Blender has taken over this project.")
            return
        job = reply.get("job")
        if not job:
            if HEADLESS and time.time() - last_work > IDLE_SECONDS:
                # The file was saved after the last reply, and the app starts a new Blender when it needs one.
                with contextlib.suppress(Exception):
                    request("/api/engine", hello({"bye": True}), timeout=10)
                return
            continue
        last_work = time.time()
        if job.get("kind") == "quit":
            if HEADLESS:
                with contextlib.suppress(Exception):
                    save_blend()
                with contextlib.suppress(Exception):
                    request("/api/engine", hello({"bye": True, "done": {"job": job["id"], "ok": True, "output": "", "error": None, "files": [], "summary": None}}), timeout=10)
                return
            done = {"job": job["id"], "ok": True, "output": "", "error": None, "files": [], "summary": None}
        elif HEADLESS:
            done = execute(job)
        else:
            inbox.put(job)
            done = outbox.get()


def watch():
    """Keeps the sidebar's copy of the conversation up to date."""
    while True:
        try:
            after = "" if STATE["rev"] is None else "?after=%s" % STATE["rev"]
            state = request("/api/blender/%s%s" % (PROJECT, after))
            STATE.update(
                chat=state["project"]["chat"],
                busy=state["busy"],
                status=state["status"],
                live=state["live"],
                rev=state["rev"],
                dirty=True,
            )
            if STATE["note"].startswith(("Connecting", "Can't reach")):
                STATE["note"] = ""
        except Exception:
            time.sleep(2)


def send(path, body):
    def go():
        try:
            request(path, body, timeout=20)
        except urllib.error.HTTPError as err:
            with contextlib.suppress(Exception):
                note(json.loads(err.read().decode("utf-8")).get("error") or "The app refused that.")
        except Exception:
            note("Can't reach the app at %s." % SERVER)

    threading.Thread(target=go, daemon=True).start()


# ─── The sidebar tab ────────────────────────────────────────────────

SHOWN_MESSAGES = 6
SHOWN_LINES = 12


class AI_BLENDER_OT_send(bpy.types.Operator):
    bl_idname = "ai_blender.send"
    bl_label = "Send"
    bl_description = "Ask the co-pilot to build or change something in this scene"

    def execute(self, context):
        text = context.window_manager.ai_blender_prompt.strip()
        if text:
            send("/api/blender/%s/chat" % PROJECT, {"text": text, "from": "blender"})
            context.window_manager.ai_blender_prompt = ""
        return {"FINISHED"}


class AI_BLENDER_OT_stop(bpy.types.Operator):
    bl_idname = "ai_blender.stop"
    bl_label = "Stop"
    bl_description = "Stop the co-pilot. What it has built so far stays"

    def execute(self, context):
        send("/api/blender/%s/action" % PROJECT, {"do": "stop"})
        return {"FINISHED"}


class AI_BLENDER_OT_web(bpy.types.Operator):
    bl_idname = "ai_blender.web"
    bl_label = "Open the web page"
    bl_description = "Open this project in the browser"

    def execute(self, context):
        bpy.ops.wm.url_open(url="%s/b/%s" % (SERVER, PROJECT))
        return {"FINISHED"}


class AI_BLENDER_PT_chat(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "AI Blender"
    bl_label = "Co-pilot"

    def draw(self, context):
        layout = self.layout
        width = max(24, int(context.region.width / (7.0 * context.preferences.system.ui_scale)))

        def paragraph(column, text, limit=SHOWN_LINES):
            lines = [line for part in text.splitlines() for line in (textwrap.wrap(part, width) or [""])]
            if len(lines) > limit:
                lines = lines[:limit - 1] + ["…"]
            for line in lines:
                column.label(text=line)

        if STATE["note"]:
            paragraph(layout.column(align=True), STATE["note"])
        if not STATE["chat"] and not STATE["busy"]:
            paragraph(layout.column(align=True), "Describe what to build. The same conversation is on the web page.")
        for message in STATE["chat"][-SHOWN_MESSAGES:]:
            box = layout.box().column(align=True)
            box.scale_y = 0.8
            mine = message.get("role") == "user"
            box.label(text="You" if mine else "Co-pilot", icon="USER" if mine else "OUTLINER_OB_LIGHT")
            if message.get("text"):
                paragraph(box, message["text"])
            if message.get("error"):
                paragraph(box, message["error"], 4)
        if STATE["busy"]:
            working = layout.column(align=True)
            working.scale_y = 0.8
            working.label(text=STATE["status"] or "Working…", icon="SORTTIME")
            if STATE["live"]:
                paragraph(working, STATE["live"], 6)
            layout.operator("ai_blender.stop", icon="CANCEL")
        else:
            layout.prop(context.window_manager, "ai_blender_prompt", text="")
            layout.operator("ai_blender.send", icon="PLAY")
        layout.operator("ai_blender.web", icon="URL")


CLASSES = (AI_BLENDER_OT_send, AI_BLENDER_OT_stop, AI_BLENDER_OT_web, AI_BLENDER_PT_chat)
started = {"fresh": flag("--fresh"), "sidebar": False}


def pump():
    """Runs on Blender's main thread: does queued jobs and redraws the tab."""
    if started["fresh"]:
        started["fresh"] = False
        start_fresh()
    if not started["sidebar"]:
        # Open the sidebar once so the tab is found.
        started["sidebar"] = True
        with contextlib.suppress(Exception):
            ui_context()["area"].spaces.active.show_region_ui = True
    with contextlib.suppress(queue.Empty):
        outbox.put(execute(inbox.get_nowait()))
    if STATE["dirty"]:
        STATE["dirty"] = False
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
    return 0.1


def main():
    if not PROJECT:
        print("AI Blender engine: start it from the app, or pass --project <id>.")
        return
    if HEADLESS:
        if started["fresh"]:
            start_fresh()
        serve()
        return
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.WindowManager.ai_blender_prompt = bpy.props.StringProperty(
        name="Prompt",
        description="What to build or change",
        options={"SKIP_SAVE"},
    )
    bpy.app.timers.register(pump, first_interval=0.5, persistent=True)
    threading.Thread(target=serve, daemon=True).start()
    threading.Thread(target=watch, daemon=True).start()


main()
