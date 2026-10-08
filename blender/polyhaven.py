"""
Poly Haven for the co-pilot: scanned surfaces and HDRI skies, free and CC0.

The co-pilot's code gets a `Library` as `assets`. It finds things by words,
downloads what it uses once into a folder shared by every project, and builds
the node setups, so that a material made from photographs of real rust is one
line instead of a guess made of noise.

Only the standard library and what ships with Blender are used.
"""

import json
import math
import os
import time
import urllib.error
import urllib.request

import bpy
from mathutils import Matrix, Vector

API = "https://api.polyhaven.com"
# Poly Haven asks every client to say who it is.
HEADERS = {"User-Agent": "ai-blender-studio/0.2"}
INDEX_AGE = 7 * 24 * 3600
KINDS = {"hdri": "hdris", "hdris": "hdris", "sky": "hdris", "texture": "textures", "textures": "textures", "material": "textures", "materials": "textures"}
RESOLUTIONS = ("1k", "2k", "4k", "8k")
# What a surface is made of, and the names Poly Haven files those maps under.
MAPS = {
    "color": ("Diffuse", "diff", "Color"),
    "arm": ("arm",),
    "roughness": ("Rough",),
    "metal": ("Metal",),
    "normal": ("nor_gl",),
    "height": ("Displacement",),
}


class AssetError(Exception):
    """A failure the co-pilot can act on: a wrong id, or no connection."""


def sky_direction(u, v):
    """Where a point of an equirectangular sky picture is in the world, before the sky is turned."""
    longitude = (0.5 - u) * 2 * math.pi
    latitude = (v - 0.5) * math.pi
    return Vector((math.cos(latitude) * math.cos(longitude), math.cos(latitude) * math.sin(longitude), math.sin(latitude)))


def brightest(image):
    """The sun in a sky picture: (u, v) of its brightest point, and how bright that is."""
    import numpy

    width, height = image.size
    pixels = numpy.empty(width * height * 4, numpy.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(height, width, 4)
    light = pixels[..., 0] * 0.2126 + pixels[..., 1] * 0.7152 + pixels[..., 2] * 0.0722
    row, column = numpy.unravel_index(int(light.argmax()), light.shape)
    return (column + 0.5) / width, (row + 0.5) / height, float(light[row, column])


def mean_colour(image):
    """A picture's overall colour, in the scene's linear values, for the viewport and the web preview."""
    import numpy

    width, height = image.size
    pixels = numpy.empty(width * height * 4, numpy.float32)
    image.pixels.foreach_get(pixels)
    r, g, b = (float(pixels[i::4][::97].mean()) for i in range(3))
    return tuple(c ** 2.2 for c in (r, g, b)) if image.colorspace_settings.name == "sRGB" else (r, g, b)


class Library:
    def __init__(self, folder):
        self.folder = folder

    # ── Fetching ──────────────────────────────────────────────────

    def _get(self, url, timeout=90):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise AssetError("Poly Haven answered %d for %s." % (err.code, url))
        except Exception:
            raise AssetError("Poly Haven can't be reached, so build this from Blender's own nodes instead.")

    def _cached(self, url, *where, max_age=None):
        """The local copy of a file, downloading it the first time."""
        path = os.path.join(self.folder, *where)
        fresh = os.path.exists(path) and (max_age is None or time.time() - os.path.getmtime(path) < max_age)
        if not fresh:
            data = self._get(url)
            if data is None:
                return None
            os.makedirs(os.path.dirname(path), exist_ok=True)
            # Written whole and then renamed, so another Blender never loads half a file.
            partial = "%s.%d.part" % (path, os.getpid())
            with open(partial, "wb") as out:
                out.write(data)
            os.replace(partial, path)
        return path

    def _json(self, url, *where, max_age=None):
        path = self._cached(url, *where, max_age=max_age)
        if path is None:
            return None
        with open(path, encoding="utf-8") as source:
            return json.load(source)

    def _index(self, kind):
        return self._json("%s/assets?t=%s" % (API, kind), "index-%s.json" % kind, max_age=INDEX_AGE) or {}

    def _files(self, asset_id):
        if not isinstance(asset_id, str) or not asset_id.replace("_", "").isalnum():
            raise AssetError('"%s" is not an asset id. Use assets.search to find one.' % (asset_id,))
        files = self._json("%s/files/%s" % (API, asset_id), "files", asset_id + ".json")
        if not files:
            raise AssetError('Poly Haven has no asset "%s". Use assets.search to find one.' % asset_id)
        return files

    @staticmethod
    def _sized(entry, resolution):
        """The nearest available size of a map."""
        order = [resolution] + [r for r in ("2k", "1k", "4k", "8k") if r != resolution]
        return next((entry[r] for r in order if r in entry), None)

    @staticmethod
    def _image(path, colour):
        image = bpy.data.images.load(path, check_existing=True)
        image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        return image

    # ── What the co-pilot calls ───────────────────────────────────

    def search(self, kind, query="", limit=10):
        """
        Finds assets by words. `kind` is "textures" or "hdris". Returns a list of
        {id, name, tags, categories, size_m}, best match first; print it to read it.
        """
        kind = KINDS.get(str(kind).lower())
        if not kind:
            raise AssetError('Search "textures" (scanned surfaces) or "hdris" (skies and rooms to light with).')
        words = str(query).lower().replace(",", " ").split()
        found = []
        for asset_id, info in self._index(kind).items():
            name = (asset_id + " " + info.get("name", "")).lower()
            tags = " ".join(info.get("tags", [])).lower()
            categories = " ".join(info.get("categories", [])).lower()
            hits = [3 if w in name else 2 if w in tags else 1 if w in categories else 0 for w in words]
            matched = sum(1 for h in hits if h)
            if words and not matched:
                continue
            found.append((matched, sum(hits), info.get("download_count", 0), asset_id, info))
        found.sort(key=lambda f: f[:3], reverse=True)
        results = []
        for _, _, _, asset_id, info in found[:limit]:
            item = {"id": asset_id, "name": info.get("name"), "tags": info.get("tags", [])[:6], "categories": info.get("categories", [])[:5]}
            if info.get("dimensions"):
                item["size_m"] = round(info["dimensions"][0] / 1000, 2)
            results.append(item)
        return results

    def maps(self, asset_id, resolution="2k", only=None):
        """Downloads a scanned surface's pictures and returns their paths by map: color, arm (occlusion, roughness, metal), roughness, metal, normal, height."""
        files = self._files(asset_id)
        paths = {}
        for name, keys in MAPS.items():
            if only is not None and name not in only:
                continue
            entry = next((files[key] for key in keys if isinstance(files.get(key), dict)), None)
            sizes = entry and self._sized(entry, resolution)
            kind = sizes and next((k for k in ("jpg", "png", "exr") if k in sizes), None)
            path = kind and self._cached(sizes[kind]["url"], "textures", asset_id, sizes[kind]["url"].rsplit("/", 1)[-1])
            if path:
                paths[name] = path
        if only is None or "color" in only:
            if not paths.get("color"):
                raise AssetError('"%s" is not a scanned surface. Search "textures" for one.' % asset_id)
        return paths

    def layer(self, tree, asset_id, scale=1.0, resolution="2k", projection="box", relief=1.0):
        """
        Adds a scanned surface's texture nodes to a node tree you are building and
        returns its sockets: {"color", "roughness", "metal", "normal"} (metal can be None),
        plus "display", the scan's overall colour as (r, g, b).
        Use it to mix scanned surfaces with each other or with your own nodes.

        projection "box" needs no UV map and keeps the scan at its real size (scale 2
        makes it half as big); "uv" uses the object's UV map, `scale` repeats across it.
        """
        uv = projection == "uv"
        paths = self.maps(asset_id, resolution, ("color", "arm", "normal" if uv else "height"))
        if "arm" not in paths:
            paths.update(self.maps(asset_id, resolution, ("roughness", "metal")))
        nodes, links = tree.nodes, tree.links

        size = (self._index("textures").get(asset_id, {}).get("dimensions") or [1000])[0] / 1000
        coord = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (scale,) * 3 if uv else (scale / size,) * 3
        links.new(coord.outputs["UV" if uv else "Object"], mapping.inputs["Vector"])

        images = {}

        def picture(name, colour=False):
            if not paths.get(name):
                return None
            node = nodes.new("ShaderNodeTexImage")
            node.image = images[name] = self._image(paths[name], colour)
            node.label = "%s %s" % (asset_id, name)
            if not uv:
                node.projection = "BOX"
                node.projection_blend = 0.2
            links.new(mapping.outputs[0], node.inputs["Vector"])
            return node.outputs["Color"]

        out = {"color": picture("color", True), "roughness": picture("roughness"), "metal": picture("metal"), "normal": None}
        packed = picture("arm")
        if packed:
            split = nodes.new("ShaderNodeSeparateColor")
            links.new(packed, split.inputs[0])
            out["roughness"], out["metal"] = split.outputs["Green"], split.outputs["Blue"]
        if uv and paths.get("normal"):
            normal = nodes.new("ShaderNodeNormalMap")
            normal.inputs["Strength"].default_value = relief
            links.new(picture("normal"), normal.inputs["Color"])
            out["normal"] = normal.outputs["Normal"]
        elif paths.get("height"):
            # A normal map needs a UV map's tangents. A height map works with any projection.
            bump = nodes.new("ShaderNodeBump")
            bump.inputs["Strength"].default_value = min(1.0, 0.6 * relief)
            bump.inputs["Distance"].default_value = 0.004 * relief
            links.new(picture("height"), bump.inputs["Height"])
            out["normal"] = bump.outputs["Normal"]
        out["display"] = mean_colour(images["color"])
        return out

    def material(self, asset_id, name=None, scale=1.0, resolution="2k", projection="box", relief=1.0, tint=None):
        """
        A material from a scanned surface, ready to assign. `tint` (r, g, b) multiplies
        its colour. See `layer` for scale and projection. Returns the material.
        """
        name = name or asset_id
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.use_nodes = True
        tree = mat.node_tree
        tree.nodes.clear()
        surface = self.layer(tree, asset_id, scale, resolution, projection, relief)
        bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
        colour = surface["color"]
        display = surface["display"]
        if tint:
            mix = tree.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1.0
            tree.links.new(colour, mix.inputs[6])
            mix.inputs[7].default_value = (*tint, 1)
            colour = mix.outputs[2]
            display = tuple(a * b for a, b in zip(display, tint))
        tree.links.new(colour, bsdf.inputs["Base Color"])
        for key, socket in (("roughness", "Roughness"), ("metal", "Metallic"), ("normal", "Normal")):
            if surface[key]:
                tree.links.new(surface[key], bsdf.inputs[socket])
        tree.links.new(bsdf.outputs[0], tree.nodes.new("ShaderNodeOutputMaterial").inputs[0])
        mat.diffuse_color = (*display, 1)
        mat.roughness = 0.6
        mat["polyhaven"] = asset_id
        return mat

    def painted(self, name, colour, under="rusty_metal_02", wear=0.4, dirt=0.3, scale=1.0, roughness=0.4, coat=0.0, resolution="2k", dirt_colour=(0.20, 0.15, 0.10)):
        """
        Paint over scanned metal: the paint is chipped away along edges and in patches
        (`wear`, 0 to 1), showing the scan `under` it, and dirt sits in the corners
        (`dirt`, 0 to 1). For machines, vehicles, tools, containers. Edges and corners
        are found by the renderer, so this needs Cycles. Returns the material.
        """
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.use_nodes = True
        tree = mat.node_tree
        tree.nodes.clear()
        nodes, links = tree.nodes, tree.links
        metal = self.layer(tree, under, scale, resolution)

        def feed(socket, value):
            if isinstance(value, bpy.types.NodeSocket):
                links.new(value, socket)
            elif value is not None:
                socket.default_value = (*value, 1) if isinstance(value, tuple) else value

        def math_(operation, a, b=None):
            node = nodes.new("ShaderNodeMath")
            node.operation = operation
            node.use_clamp = True
            feed(node.inputs[0], a)
            feed(node.inputs[1], b)
            return node.outputs[0]

        def ramp(value, low, high):
            node = nodes.new("ShaderNodeMapRange")
            feed(node.inputs["Value"], value)
            node.inputs["From Min"].default_value = low
            node.inputs["From Max"].default_value = high
            return node.outputs[0]

        def mix(factor, a, b):
            node = nodes.new("ShaderNodeMix")
            node.data_type = "RGBA"
            feed(node.inputs[0], factor)
            feed(node.inputs[6], a)
            feed(node.inputs[7], b)
            return node.outputs[2]

        coord = nodes.new("ShaderNodeTexCoord")
        geometry = nodes.new("ShaderNodeNewGeometry")

        def noise(size, detail=4.0, rough=0.55):
            node = nodes.new("ShaderNodeTexNoise")
            node.inputs["Scale"].default_value = size * scale
            node.inputs["Detail"].default_value = detail
            node.inputs["Roughness"].default_value = rough
            links.new(coord.outputs["Object"], node.inputs["Vector"])
            return node.outputs[0]

        # Where a rounded-off normal differs from the true one, an edge is near.
        rounded = nodes.new("ShaderNodeBevel")
        rounded.samples = 4
        rounded.inputs["Radius"].default_value = 0.02 / scale
        facing = nodes.new("ShaderNodeVectorMath")
        facing.operation = "DOT_PRODUCT"
        links.new(rounded.outputs["Normal"], facing.inputs[0])
        links.new(geometry.outputs["True Normal"], facing.inputs[1])
        # A modelled bevel spreads the turn over several faces, so even a small difference counts.
        edge = ramp(facing.outputs["Value"], 0.999, 0.955)

        # Paint goes first where it is knocked (edges), then in patches; fine noise makes the chips ragged.
        chance = math_("ADD", math_("ADD", math_("MULTIPLY", edge, 0.55), math_("MULTIPLY", noise(2.2, 3.0), 0.75)), math_("MULTIPLY", noise(38.0, 5.0, 0.7), 0.32))
        limit = 0.97 - 0.5 * max(0.0, min(1.0, wear))
        bare = ramp(chance, limit, limit + 0.025)

        occlusion = nodes.new("ShaderNodeAmbientOcclusion")
        occlusion.samples = 6
        occlusion.inputs["Distance"].default_value = 0.06 / scale
        grime = math_("MULTIPLY", math_("ADD", ramp(occlusion.outputs["AO"], 0.8, 0.25), math_("MULTIPLY", ramp(noise(1.6, 5.0), 0.45, 0.8), 0.5)), dirt)

        shade = lambda k: tuple(min(1.0, c * k) for c in colour)
        paint = mix(ramp(noise(4.0, 3.0), 0.3, 0.7), shade(0.82), shade(1.06))
        # Sun and rain take the colour out of old paint unevenly.
        paint = mix(math_("MULTIPLY", ramp(noise(0.9, 4.0), 0.4, 0.75), 0.35 * wear), paint, shade(0.55))
        surface = mix(grime, mix(bare, paint, metal["color"]), dirt_colour)

        paint_rough = math_("ADD", roughness, math_("MULTIPLY", math_("SUBTRACT", metal["roughness"], 0.5), 0.3))
        rough = nodes.new("ShaderNodeMix")
        feed(rough.inputs[0], bare)
        feed(rough.inputs[2], paint_rough)
        feed(rough.inputs[3], metal["roughness"])
        rough = math_("ADD", rough.outputs[0], math_("MULTIPLY", grime, 0.4))
        metallic = math_("MULTIPLY", math_("MULTIPLY", bare, metal["metal"] if metal["metal"] else 0.0), math_("SUBTRACT", 1.0, grime))

        # Paint has thickness: a chip is a small step down to the metal.
        step = nodes.new("ShaderNodeBump")
        step.inputs["Strength"].default_value = 0.6
        step.inputs["Distance"].default_value = 0.0006
        links.new(math_("SUBTRACT", 1.0, bare), step.inputs["Height"])
        if metal["normal"]:
            links.new(metal["normal"], step.inputs["Normal"])

        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        links.new(surface, bsdf.inputs["Base Color"])
        links.new(rough, bsdf.inputs["Roughness"])
        links.new(metallic, bsdf.inputs["Metallic"])
        links.new(step.outputs["Normal"], bsdf.inputs["Normal"])
        if coat:
            bsdf.inputs["Coat Weight"].default_value = coat
            bsdf.inputs["Coat Roughness"].default_value = 0.2
        links.new(bsdf.outputs[0], nodes.new("ShaderNodeOutputMaterial").inputs[0])
        mat.diffuse_color = (*colour, 1)
        mat.metallic = 0.0
        mat.roughness = roughness
        mat["polyhaven"] = under
        return mat

    def hdri(self, asset_id, strength=1.0, rotation=0.0, sun=None, resolution="2k", scene=None):
        """
        Lights the scene with an HDRI: a photograph of a whole sky or room. It is the
        world's light, reflections and background at once, and an outdoor one has a
        real sun that casts sharp shadows.

        `rotation` turns it about the vertical, in degrees. Or give `sun=(x, y)`, the
        horizontal direction toward where the sun should be, e.g. (-1, -1) for
        front-left of a subject facing -Y. Returns {"sun": unit vector toward the sun,
        "elevation": degrees, "peak": its brightness}; a peak under about 100 means an
        overcast sky or an interior with no single hard light.
        """
        files = self._files(asset_id)
        sizes = isinstance(files.get("hdri"), dict) and self._sized(files["hdri"], resolution)
        kind = sizes and next((k for k in ("hdr", "exr") if k in sizes), None)
        if not kind:
            raise AssetError('"%s" is not an HDRI. Search "hdris" for one.' % asset_id)
        url = sizes[kind]["url"]
        image = bpy.data.images.load(self._cached(url, "hdris", url.rsplit("/", 1)[-1]), check_existing=True)

        u, v, peak = brightest(image)
        toward = sky_direction(u, v)
        if sun is not None:
            wanted = math.atan2(sun[1], sun[0])
            turn = math.atan2(toward.y, toward.x) - wanted
        else:
            turn = -math.radians(rotation)
        # The Mapping node turns the lookup, so the sky itself turns the other way.
        toward = Matrix.Rotation(-turn, 3, "Z") @ toward

        scene = scene or bpy.context.scene
        world = scene.world or bpy.data.worlds.new("World")
        scene.world = world
        world.use_nodes = True
        tree = world.node_tree
        tree.nodes.clear()
        coord = tree.nodes.new("ShaderNodeTexCoord")
        mapping = tree.nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value = (0, 0, turn)
        environment = tree.nodes.new("ShaderNodeTexEnvironment")
        environment.image = image
        background = tree.nodes.new("ShaderNodeBackground")
        background.inputs["Strength"].default_value = strength
        tree.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
        tree.links.new(mapping.outputs[0], environment.inputs["Vector"])
        tree.links.new(environment.outputs[0], background.inputs[0])
        tree.links.new(background.outputs[0], tree.nodes.new("ShaderNodeOutputWorld").inputs[0])
        world["polyhaven"] = asset_id
        return {"sun": tuple(round(c, 3) for c in toward), "elevation": round(math.degrees(math.asin(max(-1.0, min(1.0, toward.z)))), 1), "peak": round(peak, 1)}
