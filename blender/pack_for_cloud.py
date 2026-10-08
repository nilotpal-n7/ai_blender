"""
Makes a copy of a scene that another machine can render at final quality: every
texture and sky inside the one file, the render settings turned up, and next to
it what is needed to render it on Google Colab.

    blender -b scene.blend --python blender/pack_for_cloud.py -- --out FOLDER
        [--name NAME] [--samples 1024] [--noise 0.01] [--scale 100]

It writes into FOLDER:

    NAME.blend        the scene, with nothing left outside it
    cloud_render.py   renders it there, and carries on where a run was cut off
    NAME.ipynb        a Colab notebook: install the same Blender, test a frame,
                      render them all to Google Drive, make the video

The scene it is run on is not changed, so working renders stay quick. What is
turned up is only what removes noise (samples, the denoiser, full size); light
bounces, motion blur and the grade are part of the look and stay as they are.
"""

import json
import os
import shutil
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))


def option(name, default=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if name in argv and argv.index(name) + 1 < len(argv):
        return argv[argv.index(name) + 1]
    return default


def attempt(what, action):
    """Settings come and go between Blender versions; one that is missing costs only itself."""
    try:
        action()
    except Exception as error:
        print("[pack] skipped %s: %s" % (what, error))


def final_quality(scene, samples, noise, scale):
    render = scene.render
    render.resolution_percentage = scale
    render.use_persistent_data = True
    attempt("still pictures", lambda: setattr(render.image_settings, "media_type", "IMAGE"))
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGB"
    render.image_settings.compression = 15
    render.filepath = "//frames/"
    if render.engine != "CYCLES":
        return
    cycles = scene.cycles
    cycles.samples = max(cycles.samples, samples)
    # Stops early where a pixel is already clean, so the samples go to dust, glass and shadow.
    cycles.use_adaptive_sampling = True
    cycles.adaptive_threshold = noise
    cycles.time_limit = 0
    cycles.use_denoising = True
    attempt("denoiser", lambda: setattr(cycles, "denoiser", "OPENIMAGEDENOISE"))
    attempt("denoiser passes", lambda: setattr(cycles, "denoising_input_passes", "RGB_ALBEDO_NORMAL"))
    attempt("denoiser prefilter", lambda: setattr(cycles, "denoising_prefilter", "ACCURATE"))
    attempt("denoiser quality", lambda: setattr(cycles, "denoising_quality", "HIGH"))
    attempt("denoiser on the card", lambda: setattr(cycles, "denoising_use_gpu", True))


def notebook(name, blender_url, scene):
    """A Colab notebook as plain data. Everything a person may want to change is in its first cell."""
    render = scene.render

    def text(*lines):
        return {"cell_type": "markdown", "metadata": {}, "source": "\n".join(lines)}

    def code(*lines):
        return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": "\n".join(lines)}

    keep = "grep --line-buffered -iE '^.render.|error|killed|out of memory'"
    blender = '!/content/blender/blender -b /content/scene.blend --python "{FOLDER}/cloud_render.py" -- --out "{FOLDER}/frames"'
    cells = [
        text(
            "# Render %s" % name,
            "",
            "1. **Runtime > Change runtime type > T4 GPU** (or a faster card if you have one), then Save.",
            "2. Put the folder with `%s.blend`, `cloud_render.py` and this notebook in your Google Drive." % name,
            "3. Run the cells from the top, one after another.",
            "",
            "Frames are saved to Drive as they finish. When Colab ends the session, open the notebook again and run every cell again: it carries on from the first missing frame.",
        ),
        code(
            "# Where the folder is in your Drive.",
            'FOLDER = "/content/drive/MyDrive/%s"' % name,
            'NAME = "%s"' % name,
            "",
            "# None keeps what the file says: %d samples, %d x %d." % (scene.cycles.samples if render.engine == "CYCLES" else 0, render.resolution_x * render.resolution_percentage // 100, render.resolution_y * render.resolution_percentage // 100),
            "SAMPLES = None   # fewer is faster and a little noisier in dust and shadow",
            "SCALE = None     # percent of that size: 200 is four times the pixels and four times the time",
            "FIRST, LAST = None, None   # a part of the film only, e.g. 1, 400",
            'DEVICE = "gpu"   # "cuda" if the test frame fails to start on the card',
            "TEST_FRAME = %d" % ((scene.frame_start + scene.frame_end) // 2),
            "",
            'BLENDER = "%s"' % blender_url,
        ),
        code(
            "import os",
            "from google.colab import drive",
            'drive.mount("/content/drive")',
            'assert os.path.exists(f"{FOLDER}/{NAME}.blend"), f"{FOLDER}/{NAME}.blend is not there: check FOLDER above"',
            "!nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || echo 'No GPU: set the runtime type to T4 GPU and start again'",
        ),
        code(
            "# The same Blender the scene was made in, and a copy of the scene on this machine's own disk.",
            'if not os.path.exists("/content/blender/blender"):',
            '    !wget -q -O /content/blender.tar.xz "{BLENDER}"',
            "    !mkdir -p /content/blender && tar -xf /content/blender.tar.xz -C /content/blender --strip-components=1",
            "    !apt-get -qq install -y libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libgl1 libegl1 > /dev/null",
            '!cp "{FOLDER}/{NAME}.blend" /content/scene.blend',
            "!/content/blender/blender --version | head -1",
            'EXTRA = f" --device {DEVICE}"',
            "if SAMPLES: EXTRA += f\" --samples {SAMPLES}\"",
            "if SCALE: EXTRA += f\" --scale {SCALE}\"",
            "if FIRST: EXTRA += f\" --first {FIRST}\"",
            "if LAST: EXTRA += f\" --last {LAST}\"",
        ),
        text("## One frame first", "", "Look at it, and at how long the whole film would take, before starting."),
        code(
            blender + " {EXTRA} --test {TEST_FRAME} 2>&1 | " + keep,
            "from IPython.display import Image, display",
            'display(Image(f"{FOLDER}/frames/test.png"))',
        ),
        text("## Every frame", "", "Leave the tab open. Run this again after a disconnect (and the cells above it): finished frames are skipped."),
        code(blender + " {EXTRA} 2>&1 | " + keep),
        text("## The video"),
        code(
            "import json",
            'about = json.load(open(f"{FOLDER}/frames/render.json"))',
            'start, end, fps = about["first"], about["last"], about["fps"]',
            'missing = [n for n in range(start, end + 1) if not os.path.exists(f"{FOLDER}/frames/{n:04d}.png")]',
            'assert not missing, f"{len(missing)} frames are still to render (the first is {missing[0]}): run the cell above again"',
            '!ffmpeg -y -loglevel error -framerate {fps} -start_number {start} -i "{FOLDER}/frames/%04d.png" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709,format=yuv420p" -c:v libx264 -preset slow -crf 14 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -movflags +faststart "{FOLDER}/{NAME}.mp4"',
            'print(f"{FOLDER}/{NAME}.mp4", round(os.path.getsize(f"{FOLDER}/{NAME}.mp4") / 1e6), "MB")',
        ),
    ]
    return {
        "nbformat": 4,
        "nbformat_minor": 0,
        "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"}, "kernelspec": {"name": "python3", "display_name": "Python 3"}},
        "cells": cells,
    }


def main():
    scene = bpy.context.scene
    folder = os.path.abspath(option("--out") or "cloud")
    name = option("--name") or "scene"
    os.makedirs(folder, exist_ok=True)
    final_quality(scene, int(option("--samples") or 1024), float(option("--noise") or 0.01), int(option("--scale") or 100))

    # Whatever was linked from another .blend becomes part of this one, then every picture goes inside.
    if bpy.data.libraries:
        attempt("linked files", lambda: bpy.ops.object.make_local(type="ALL"))
    attempt("packing", lambda: bpy.ops.file.pack_all())
    pictures = [image for image in bpy.data.images if image.source in ("FILE", "SEQUENCE", "MOVIE")]
    outside = [image.name for image in pictures if not image.packed_file]
    target = os.path.join(folder, name + ".blend")
    # No .blend1 of the last pack beside it: the folder is uploaded as it is.
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=target, copy=True, compress=True)

    shutil.copyfile(os.path.join(HERE, "cloud_render.py"), os.path.join(folder, "cloud_render.py"))
    version = bpy.app.version
    url = "https://download.blender.org/release/Blender%d.%d/blender-%d.%d.%d-linux-x64.tar.xz" % (version[0], version[1], *version)
    with open(os.path.join(folder, name + ".ipynb"), "w", encoding="utf-8", newline="\n") as out:
        json.dump(notebook(name, url, scene), out, indent=1)

    render = scene.render
    print("[pack] %s: %d MB, %d of %d pictures inside" % (target, round(os.path.getsize(target) / 1e6), len(pictures) - len(outside), len(pictures)))
    if outside:
        print("[pack] NOT inside (their files are missing here too): " + ", ".join(outside))
    if [library.filepath for library in bpy.data.libraries if library.users]:
        print("[pack] still linked from other files: " + ", ".join(library.filepath for library in bpy.data.libraries if library.users))
    if bpy.app.version_cycle != "release":
        print("[pack] this Blender is a %s build: there may be no download of it at %s" % (bpy.app.version_cycle, url))
    print("[pack] frames %d to %d at %d x %d, %s" % (
        scene.frame_start, scene.frame_end,
        render.resolution_x * render.resolution_percentage // 100, render.resolution_y * render.resolution_percentage // 100,
        "%d samples" % scene.cycles.samples if render.engine == "CYCLES" else render.engine))


main()
