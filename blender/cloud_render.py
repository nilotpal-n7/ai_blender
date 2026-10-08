"""
Renders a scene on a machine that is not yours (Google Colab, a rented GPU), one
frame at a time, so that a run which is cut off loses one frame and not the night.

    blender -b scene.blend --python cloud_render.py -- --out FOLDER
        [--first N] [--last N] [--samples N] [--scale PERCENT] [--test FRAME]
        [--device gpu|cpu|optix|cuda|...]

Frames are written to FOLDER as 0001.png, 0002.png and so on, named by frame
number. A frame that is already there is skipped: start the same command again
and it carries on. `--test` renders one frame to FOLDER/test.png and says how
long the whole thing would take at that rate. `--device gpu` takes the best
card there is; name a kind to insist on it (cuda, when OptiX will not start).

The scene should come from `pack_for_cloud.py`, which puts every texture inside
the file. This script uses nothing but Blender, and every line it prints starts
with [render] so the rest of what Blender says can be filtered away.
"""

import json
import os
import sys
import time

import bpy


def option(name, default=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if name in argv and argv.index(name) + 1 < len(argv):
        return argv[argv.index(name) + 1]
    return default


def say(text):
    print("[render] " + text, flush=True)


def duration(seconds):
    if seconds < 90:
        return "%d s" % round(seconds)
    if seconds < 5400:
        return "%d min" % round(seconds / 60)
    return "%.1f h" % (seconds / 3600)


def pick_device(scene, wanted):
    """The fastest thing this machine has. Which cards to use is a preference, not part of a .blend, so it is chosen here."""
    if scene.render.engine != "CYCLES":
        return scene.render.engine
    if wanted != "cpu":
        prefs = bpy.context.preferences.addons["cycles"].preferences
        kinds = ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI")
        for kind in kinds if wanted == "gpu" else (wanted.upper(),):
            try:
                prefs.compute_device_type = kind
                prefs.refresh_devices()
            except Exception:
                continue  # this build, or this machine's driver, has no such thing
            cards = [device for device in prefs.devices if device.type == kind]
            if cards:
                for device in prefs.devices:
                    device.use = device.type == kind
                scene.cycles.device = "GPU"
                return "%s (%s)" % (kind, ", ".join(card.name for card in cards))
    scene.cycles.device = "CPU"
    return "CPU"


def main():
    scene = bpy.context.scene
    render = scene.render
    out = os.path.abspath(option("--out") or "frames")
    os.makedirs(out, exist_ok=True)
    if not scene.camera and not any(marker.camera for marker in scene.timeline_markers):
        say("The scene has no camera.")
        sys.exit(1)

    lost = [image.name for image in bpy.data.images
            if image.source in ("FILE", "SEQUENCE", "MOVIE") and not image.packed_file
            and not os.path.exists(bpy.path.abspath(image.filepath, library=image.library))]
    if lost:
        say("These pictures are not in the file and not on this machine, so what uses them will render pink: " + ", ".join(lost))

    if option("--samples") and render.engine == "CYCLES":
        scene.cycles.samples = int(option("--samples"))
    if option("--scale"):
        render.resolution_percentage = int(option("--scale"))
    device = pick_device(scene, (option("--device") or "gpu").lower())
    # Keeps the scene loaded on the card between frames: only what moved is sent again.
    render.use_persistent_data = True
    render.use_file_extension = True
    render.image_settings.media_type = "IMAGE"
    render.image_settings.file_format = "PNG"

    start, end = scene.frame_start, scene.frame_end
    width = render.resolution_x * render.resolution_percentage // 100
    height = render.resolution_y * render.resolution_percentage // 100
    with open(os.path.join(out, "render.json"), "w", encoding="utf-8") as about:
        json.dump({"first": start, "last": end, "fps": render.fps / render.fps_base, "width": width, "height": height}, about)
    say("%d x %d, frames %d to %d, on %s" % (width, height, start, end, device))

    def frame(number, path):
        """Renders one frame to `path`, by way of another name so a half-written picture is never mistaken for a finished one."""
        scene.frame_set(number)
        part = os.path.join(out, "rendering.png")
        render.filepath = part
        began = time.time()
        bpy.ops.render.render(write_still=True)
        if not os.path.exists(part):
            say("Frame %d was not written. Blender's own messages above say why (often: out of memory)." % number)
            sys.exit(1)
        os.replace(part, path)
        return time.time() - began

    test = option("--test")
    if test:
        took = frame(int(test), os.path.join(out, "test.png"))
        say("Frame %s took %s. The first frame of a run also loads the scene; later ones are quicker." % (test, duration(took)))
        say("At that rate all %d frames take about %s." % (end - start + 1, duration(took * (end - start + 1))))
        return

    first = max(start, int(option("--first") or start))
    last = min(end, int(option("--last") or end))
    wanted = [number for number in range(first, last + 1)
              if not os.path.exists(os.path.join(out, "%04d.png" % number))]
    say("%d of %d frames still to render" % (len(wanted), last - first + 1))
    spent = 0.0
    for count, number in enumerate(wanted, 1):
        spent += frame(number, os.path.join(out, "%04d.png" % number))
        say("frame %d done (%d of %d), %s a frame, about %s left"
            % (number, count, len(wanted), duration(spent / count), duration(spent / count * (len(wanted) - count))))
    say("All frames from %d to %d are in %s" % (first, last, out))


main()
