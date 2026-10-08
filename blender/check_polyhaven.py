"""
Checks, in a real Blender and without the network, that `assets.hdri` knows
where an HDRI's sun ends up: it lights a scene with a black sky that has one
bright spot, asks for the sun in a given direction, and looks there.

    blender -b --factory-startup --python blender/check_polyhaven.py

Run it when moving to a new Blender version: the answer depends on how Blender
maps a sky picture onto the world and on which way a Mapping node turns it.
"""

import json
import math
import os
import sys
import tempfile

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from polyhaven import Library  # noqa: E402

folder = tempfile.mkdtemp(prefix="ai-blender-check-")
WIDTH, HEIGHT = 128, 64

# A sky with nothing in it but a sun, off-center so a mirrored convention can't pass.
sky = bpy.data.images.new("check sky", WIDTH, HEIGHT, float_buffer=True)
pixels = [0.0, 0.0, 0.0, 1.0] * (WIDTH * HEIGHT)
for row in (40, 41):
    for column in (23, 24):
        start = (row * WIDTH + column) * 4
        pixels[start:start + 3] = [5000.0, 5000.0, 5000.0]
sky.pixels[:] = pixels
os.makedirs(os.path.join(folder, "hdris"))
os.makedirs(os.path.join(folder, "files"))
sky.filepath_raw = os.path.join(folder, "hdris", "check_sky_2k.hdr")
sky.file_format = "HDR"
sky.save()
with open(os.path.join(folder, "files", "checksky.json"), "w", encoding="utf-8") as out:
    json.dump({"hdri": {"2k": {"hdr": {"url": "https://example.invalid/check_sky_2k.hdr"}}}}, out)

scene = bpy.context.scene
for ob in list(scene.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
camera = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.lens = 400  # a narrow view: only what is straight ahead
scene.render.engine = "CYCLES"
scene.cycles.samples = 8
scene.cycles.use_denoising = False
scene.render.resolution_x = scene.render.resolution_y = 8
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "OPEN_EXR"
scene.view_settings.view_transform = "Raw"


def seen(direction):
    """How bright the sky is, looking that way."""
    camera.rotation_euler = Vector(direction).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(folder, "look.exr")
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(scene.render.filepath, check_existing=False)
    values = list(image.pixels)
    bpy.data.images.remove(image)
    return sum(values[0::4]) / (len(values) / 4)


library = Library(folder)
failures = []
for label, arguments in (("as shot", {}), ("turned 70 degrees", {"rotation": 70}), ("sun asked for at front-left", {"sun": (-1, -1)}), ("sun asked for at right", {"sun": (1, 0.2)})):
    told = library.hdri("checksky", **arguments)
    toward = Vector(told["sun"])
    lit, dark = seen(toward), seen(-toward)
    ok = lit > 100 and dark < 1
    if "sun" in arguments:
        asked = Vector((*arguments["sun"], 0)).normalized()
        flat = Vector((toward.x, toward.y, 0)).normalized()
        ok = ok and (asked - flat).length < 0.02
    print("%-28s sun %s elevation %s: toward it %.0f, away %.2f  %s" % (label, told["sun"], told["elevation"], lit, dark, "ok" if ok else "WRONG"))
    if not ok:
        failures.append(label)

print("CHECK FAILED: " + ", ".join(failures) if failures else "CHECK PASSED")
sys.exit(1 if failures else 0)
