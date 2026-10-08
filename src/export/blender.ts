/**
 * Blender export: a Python script that rebuilds the scene with native Blender
 * data, ready to keep working on. Run it from Blender's Scripting tab or
 * `blender --python scene.py`.
 *
 * What it makes:
 *   - meshes at their real size (scale applied), with UV maps;
 *   - Principled materials, with a procedural chipped-paint setup where a
 *     material has `wear`;
 *   - arrays as a Geometry Nodes modifier, so the count stays editable;
 *   - an armature for anything animated: one bone per group, the parts
 *     parented to their bones, and the clip baked onto the bones as keyframes;
 *   - the camera, a compositor setup for the grade, and render settings.
 *
 * The scene is embedded as data, already converted to Blender's Z-up axes; the
 * script itself is fixed. The parts that differ between Blender versions (the
 * compositor, geometry nodes, UV unwrap) are each attempted on their own, so an
 * older Blender loses that part, not the scene.
 */

import { frameCount, sampleTrack } from "@/scene/animate";
import {
  WEAR_EDGE_SCALE,
  WEAR_GRIME_SCALE,
  WEAR_METAL,
  WEAR_METAL_ROUGHNESS,
  WEAR_SCALE,
} from "@/scene/finish";
import { DEG, eulerToQuat, hexToLinear, quatFromTo, round, sunDirection, type Quat } from "@/scene/math";
import { childIds, descendantIds, pathTo } from "@/scene/ops";
import { DEFAULT_MATERIAL, type Material, type MeshNode, type Scene, type Vec3 } from "@/scene/types";
import { EXPORT_DETAIL, fusedFinish, fusedMesh, isFused } from "@/shapes/blend";
import type { MeshData } from "@/shapes/mesh";
import { GENERATED, isBeveled, nodeMesh } from "./meshdata";

const GROUND_HALF_SIZE = 150;
/**
 * Blender point and spot lights are set in watts with an extra factor of π in
 * their definition; this turns the editor's intensity into a similar brightness.
 */
const WATTS_PER_INTENSITY = 4 * Math.PI ** 2;
const RENDER_SIZE = [1920, 1080];

const r = (v: readonly number[], places = 6) => v.map((n) => round(n, places));

// Editor space is Y-up, Blender is Z-up: (x, y, z) → (x, −z, y). This is a
// rotation, so handedness and face winding carry over unchanged.
const point = ([x, y, z]: Vec3) => r([x, -z, y]);
const size = ([x, y, z]: Vec3) => r([x, z, y]);
/** Blender quaternions are (w, x, y, z); the vector part converts like a point. */
const rotation = ([x, y, z, w]: Quat) => r([w, x, -z, y]);
const NO_ROTATION = [1, 0, 0, 0];

function material(m: Material, vertexColors = false) {
  return {
    color: r(hexToLinear(m.color)),
    roughness: m.roughness,
    metalness: m.metalness,
    emissive: r(hexToLinear(m.emissive)),
    emissiveIntensity: m.emissiveIntensity,
    opacity: m.opacity,
    wear: m.wear,
    // The mesh carries per-point colors that the material multiplies in.
    vertexColors,
  };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Mesh data in Blender's axes. Colors are stored linear, as Blender expects. */
function meshSpec(mesh: MeshData) {
  return {
    verts: mesh.points.map(point),
    faces: mesh.faces,
    smooth: mesh.smooth,
    ...(mesh.colors && { colors: mesh.colors.map((c) => c.map((v) => round(toLinear(v), 4))) }),
    ...(mesh.normals && { normals: mesh.normals.map((n) => r([n[0], -n[2], n[1]], 4)) }),
  };
}

/** One object, bone or empty in the script's data. */
export interface BlenderNode {
  id: string;
  name: string;
  parent: string | null;
  kind: string;
  visible: boolean;
  location: number[];
  /** Quaternion, (w, x, y, z). */
  rotation: number[];
  scale: number[];
  /** A group inside a rig: it becomes a bone instead of an object. */
  bone?: boolean;
  /** Key into the shared meshes. */
  mesh?: string;
  meshData?: ReturnType<typeof meshSpec>;
  material?: ReturnType<typeof material>;
  /** A transform applied to the mesh's points instead of to the object. */
  bake?: { location?: number[]; rotation?: number[]; scale: number[] };
  array?: { count: number; step: number[]; turn: number[] };
  light?: { type: string; color: number[]; energy: number; distance: number; spotSize: number };
}

/** Meshes are shared by key: one per primitive, and one per size of rounded box. */
const meshKey = (node: MeshNode) =>
  isBeveled(node) ? `box ${node.scale.join("x")} r${node.bevel}` : node.primitive;

/** The clip, sampled on every frame with the same code the viewport plays it with. */
function animationData(scene: Scene) {
  const { clip } = scene;
  if (clip.tracks.length === 0) return null;
  const frames = frameCount(clip);
  const tracks: Record<string, { location?: number[][]; rotation?: number[][]; scale?: number[][] }> = {};
  for (const track of clip.tracks) {
    const samples = Array.from({ length: frames }, (_, frame) =>
      sampleTrack(track.keys, Math.min(frame / clip.fps, clip.duration)),
    );
    const entry = (tracks[track.node] ??= {});
    if (track.property === "position") entry.location = samples.map(point);
    else if (track.property === "rotation") entry.rotation = samples.map((v) => rotation(eulerToQuat(v)));
    else entry.scale = samples.map(size);
  }
  return { fps: clip.fps, frames, loop: clip.loop, tracks };
}

/**
 * Anything animated is rigged: the highest group above each animated node
 * becomes an armature, and every group inside it a bone.
 */
function rigsOf(scene: Scene) {
  const roots = new Set<string>();
  for (const track of scene.clip.tracks) {
    const root = pathTo(scene, track.node).find((id) => scene.nodes[id].kind === "group");
    if (root) roots.add(root);
  }
  return [...roots].map((root) => ({
    root,
    name: `${scene.nodes[root].name} rig`,
    // Parents before their children.
    bones: [root, ...descendantIds(scene, root)].filter((id) => scene.nodes[id].kind === "group"),
  }));
}

export function blenderData(scene: Scene, title: string) {
  const env = scene.environment;
  const order = childIds(scene, null).flatMap((id) => [id, ...descendantIds(scene, id)]);
  const meshes: Record<string, ReturnType<typeof meshSpec>> = {};
  const rigs = rigsOf(scene);
  const bones = new Set(rigs.flatMap((rig) => rig.bones));

  // Blender doesn't hide the children of a hidden parent, so hiding is
  // resolved here. `order` lists parents first, so each parent is already known.
  const shown = new Map<string, boolean>();
  const nodes = order.flatMap((id): BlenderNode | BlenderNode[] => {
    const node = scene.nodes[id];
    const visible = node.visible && (node.parent === null || shown.get(node.parent) === true);
    shown.set(id, visible);

    // A part fused into its group's surface isn't an object of its own. It is
    // kept as an empty only if something is parented to it.
    const fused = isFused(scene, node);
    const parent = childIds(scene, id).length > 0;
    if (fused && !parent) return [];
    // A blending group becomes one mesh: its fused surface.
    const surface = node.kind === "group" && node.blend > 0 ? fusedMesh(scene, node, EXPORT_DETAIL) : null;
    const drawn = node.kind === "mesh" && !fused ? node : null;
    if (drawn) meshes[meshKey(drawn)] ??= meshSpec(nodeMesh(drawn));

    const placed = {
      location: point(node.position),
      rotation: rotation(eulerToQuat(node.rotation)),
      scale: size(node.scale),
    };
    const base = { id, name: node.name, parent: node.parent, visible };
    const drawing = drawn && {
      mesh: meshKey(drawn),
      material: material(drawn.material, GENERATED.has(drawn.primitive)),
    };

    if (drawn?.array) {
      const [a, b, c] = drawn.array.turn.map((d) => d * DEG);
      // The copies are laid out in the parent's space, so the mesh is moved
      // into that space and the object itself sits at the parent's origin.
      const arrayed = {
        ...base,
        id: parent ? `${id}/array` : id,
        kind: "mesh",
        location: [0, 0, 0],
        rotation: NO_ROTATION,
        scale: [1, 1, 1],
        ...drawing,
        bake: placed,
        array: {
          count: drawn.array.count,
          step: point(drawn.array.step),
          // The editor turns each copy by Rx(a) · Ry(b) · Rz(c). Its Y is
          // Blender's Z and its Z is Blender's −Y, so in Blender that is
          // Rx(a) · Rz(b) · Ry(−c). Listed in that order: x, z, y.
          turn: r([a, b, -c]),
        },
      };
      // Anything parented to the mesh still needs the mesh's own frame.
      return parent ? [{ ...base, kind: "group", ...placed }, arrayed] : [arrayed];
    }

    return {
      ...base,
      kind: surface && surface.points.length > 0 ? "mesh" : fused ? "group" : node.kind,
      ...placed,
      ...(bones.has(id) && { bone: true }),
      ...(drawn && {
        ...drawing,
        // A mesh's size goes into its points, leaving the object at scale 1,
        // unless something parented to it relies on that scale.
        ...(!parent && { scale: [1, 1, 1], bake: { scale: placed.scale } }),
      }),
      ...(node.kind === "group" &&
        surface &&
        surface.points.length > 0 && {
          meshData: meshSpec(surface),
          material: material({ ...DEFAULT_MATERIAL, color: "#ffffff", ...fusedFinish(scene, node) }, true),
        }),
      ...(node.kind === "light" && {
        light: {
          type: node.light.type,
          color: r(hexToLinear(node.light.color)),
          energy: round(node.light.intensity * WATTS_PER_INTENSITY, 3),
          distance: node.light.distance,
          // Blender's spot size is the full cone angle, in radians.
          spotSize: round((node.light.angle * 2 * Math.PI) / 180, 6),
        },
      }),
    };
  });

  // Sun lamps shine down their local −Z, so +Z must point back at the sun.
  // Solved directly in Blender's axes: the lamp's own axes are Blender's.
  const [sx, sy, sz] = sunDirection(env.sun);
  const [qx, qy, qz, qw] = quatFromTo([0, 0, 1], [sx, -sz, sy]);
  return {
    name: title,
    meshes,
    nodes,
    rigs,
    animation: animationData(scene),
    sun: {
      rotation: r([qw, qx, qy, qz]),
      color: r(hexToLinear(env.sun.color)),
      strength: env.sun.intensity,
    },
    world: { color: r(hexToLinear(env.background)), strength: env.ambient },
    ground: env.ground.visible
      ? { halfSize: GROUND_HALF_SIZE, material: material({ ...DEFAULT_MATERIAL, color: env.ground.color, roughness: 1 }) }
      : null,
    fog: env.fog && { color: r(hexToLinear(env.fog.color)), near: env.fog.near, far: env.fog.far },
    camera: {
      location: point(scene.camera.position),
      target: point(scene.camera.target),
      // Vertical field of view, in radians.
      fov: round(scene.camera.fov * DEG, 6),
    },
    grade: env.grade,
    wear: {
      scale: WEAR_SCALE,
      edgeScale: WEAR_EDGE_SCALE,
      grimeScale: WEAR_GRIME_SCALE,
      metal: WEAR_METAL,
      metalRoughness: WEAR_METAL_ROUGHNESS,
    },
    render: { size: RENDER_SIZE },
  };
}

const SCRIPT = `
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

# Before Blender 5, materials and worlds had to opt in to shader nodes.
NODES_ARE_OPTIONAL = bpy.app.version < (5, 0, 0)
IDENTITY = Matrix.Identity(4)


def attempt(what, step, *args):
    """Runs a stage that newer or older Blenders may not support, without losing the rest."""
    try:
        return step(*args)
    except Exception as error:
        print(f"AI Blender: skipped {what} ({type(error).__name__}: {error})")
        return None


def set_input(node, names, value):
    """Sets the first socket that exists; socket names differ between Blender versions."""
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return True
    return False


def socket(node, identifier, outputs=False):
    """A socket by identifier, for nodes that have several sockets with the same name."""
    return next(s for s in (node.outputs if outputs else node.inputs) if s.identifier == identifier)


class Graph:
    """Shorthand for building node trees: values are either numbers or sockets."""

    def __init__(self, tree):
        self.tree = tree

    def node(self, kind, **properties):
        node = self.tree.nodes.new(kind)
        for name, value in properties.items():
            setattr(node, name, value)
        return node

    def plug(self, target, value):
        if isinstance(value, bpy.types.NodeSocket):
            self.tree.links.new(value, target)
        else:
            target.default_value = value

    def math(self, operation, a, b=0.0):
        node = self.node("ShaderNodeMath", operation=operation)
        self.plug(node.inputs[0], a)
        self.plug(node.inputs[1], b)
        return node.outputs[0]

    def remap(self, value, from_min, from_max, to_min, to_max, interpolation="LINEAR"):
        node = self.node("ShaderNodeMapRange", interpolation_type=interpolation)
        for index, item in enumerate((value, from_min, from_max, to_min, to_max)):
            self.plug(node.inputs[index], item)
        return node.outputs[0]

    def mix(self, factor, a, b, blend="MIX"):
        node = self.node("ShaderNodeMix", data_type="RGBA", blend_type=blend)
        self.plug(socket(node, "Factor_Float"), factor)
        self.plug(socket(node, "A_Color"), a)
        self.plug(socket(node, "B_Color"), b)
        return socket(node, "Result_Color", outputs=True)


def add_wear(tree, shader, spec, paint):
    """Chipped paint: noise picks where the color has worn through to bare metal."""
    wear = DATA["wear"]
    amount = spec["wear"]
    graph = Graph(tree)

    # Each point's place on the object, in meters, shifted so every object chips differently.
    coords = graph.node("ShaderNodeTexCoord")
    shift = graph.math("MULTIPLY", graph.node("ShaderNodeObjectInfo").outputs["Random"], 53.0)
    offset = graph.node("ShaderNodeCombineXYZ")
    for axis in range(3):
        graph.plug(offset.inputs[axis], shift)
    place = graph.node("ShaderNodeVectorMath", operation="ADD")
    graph.plug(place.inputs[0], coords.outputs["Object"])
    graph.plug(place.inputs[1], offset.outputs[0])

    def noise(scale, detail):
        node = graph.node("ShaderNodeTexNoise")
        graph.plug(node.inputs["Vector"], place.outputs[0])
        node.inputs["Scale"].default_value = scale
        node.inputs["Detail"].default_value = detail
        return node.outputs[0]

    # Broad patches with ragged edges.
    field = graph.math(
        "ADD",
        graph.math("MULTIPLY", noise(wear["scale"], 3.0), 0.75),
        graph.math("MULTIPLY", noise(wear["edgeScale"], 2.0), 0.25),
    )
    level = 0.65 - 0.22 * amount
    chip = graph.remap(field, level, level + 0.015, 0.0, 1.0, "SMOOTHSTEP")
    rim = graph.math("MULTIPLY", graph.remap(field, level - 0.035, level, 0.0, 1.0, "SMOOTHSTEP"), graph.math("SUBTRACT", 1.0, chip))

    # Sun-fade and grime, uneven across the surface.
    fade = min(1.0, amount * 1.8)
    grime = graph.remap(noise(wear["grimeScale"], 3.0), 0.25, 0.75, 1.0 - 0.38 * fade, 1.0 + 0.24 * fade)
    shade = graph.math("MULTIPLY", grime, graph.math("SUBTRACT", 1.0, graph.math("MULTIPLY", rim, 0.47)))
    faded = graph.node("ShaderNodeVectorMath", operation="SCALE")
    graph.plug(faded.inputs[0], paint if isinstance(paint, bpy.types.NodeSocket) else paint[:3])
    graph.plug(faded.inputs["Scale"], shade)

    graph.plug(shader.inputs["Base Color"], graph.mix(chip, faded.outputs[0], (*wear["metal"], 1.0)))
    graph.plug(shader.inputs["Roughness"], graph.remap(chip, 0.0, 1.0, spec["roughness"], wear["metalRoughness"]))
    graph.plug(shader.inputs["Metallic"], graph.remap(chip, 0.0, 1.0, spec["metalness"], 1.0))


def make_material(name, spec):
    material = bpy.data.materials.new(name)
    if NODES_ARE_OPTIONAL:
        material.use_nodes = True
    shader = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    paint = (*spec["color"], 1.0)
    if shader is not None:
        set_input(shader, ["Base Color"], paint)
        set_input(shader, ["Roughness"], spec["roughness"])
        set_input(shader, ["Metallic"], spec["metalness"])
        set_input(shader, ["Emission Color", "Emission"], (*spec["emissive"], 1.0))
        set_input(shader, ["Emission Strength"], spec["emissiveIntensity"])
        set_input(shader, ["Alpha"], spec["opacity"])
    if shader is not None and spec["vertexColors"]:
        # Base color = the mesh's own colors times the material color.
        tree = material.node_tree
        colors = tree.nodes.new("ShaderNodeVertexColor")
        colors.layer_name = "Color"
        tint = tree.nodes.new("ShaderNodeVectorMath")
        tint.operation = "MULTIPLY"
        tint.inputs[1].default_value = spec["color"]
        tree.links.new(colors.outputs["Color"], tint.inputs[0])
        tree.links.new(tint.outputs["Vector"], shader.inputs["Base Color"])
        paint = tint.outputs["Vector"]
    if shader is not None and spec["wear"] > 0:
        attempt("the worn finish of " + name, add_wear, material.node_tree, shader, spec, paint)
    material.diffuse_color = (*spec["color"], spec["opacity"])
    if spec["opacity"] < 1.0:
        if hasattr(material, "surface_render_method"):
            material.surface_render_method = "BLENDED"
        elif hasattr(material, "blend_method"):
            material.blend_method = "BLEND"
    return material


def trs(spec):
    """The matrix for a location, rotation and scale; any of them may be left out."""
    return Matrix.LocRotScale(
        Vector(spec.get("location", (0.0, 0.0, 0.0))),
        Quaternion(spec.get("rotation", (1.0, 0.0, 0.0, 0.0))),
        Vector(spec.get("scale", (1.0, 1.0, 1.0))),
    )


def make_mesh(name, spec, bake=None):
    """Builds a mesh, with its points moved by the matrix 'bake' if one is given."""
    verts = [Vector(v) for v in spec["verts"]]
    if bake is not None:
        verts = [bake @ v for v in verts]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in spec["faces"]])
    mesh.update()
    if spec["smooth"]:
        mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    if "colors" in spec and hasattr(mesh, "color_attributes"):
        attribute = mesh.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="POINT")
        attribute.data.foreach_set("color", [v for c in spec["colors"] for v in (*c, 1.0)])
    if "normals" in spec:
        # Exact normals, for rounded edges. Normals turn with the inverse transpose.
        turn = bake.to_3x3().inverted().transposed() if bake is not None else Matrix.Identity(3)
        normals = [(turn @ Vector(n)).normalized() for n in spec["normals"]]
        if hasattr(mesh, "use_auto_smooth"):
            mesh.use_auto_smooth = True
        mesh.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    return mesh


def make_light(name, spec):
    light = bpy.data.lights.new(name, "SPOT" if spec["type"] == "spot" else "POINT")
    light.color = spec["color"]
    light.energy = spec["energy"]
    light.shadow_soft_size = 0.05
    if spec["type"] == "spot":
        light.spot_size = spec["spotSize"]
        light.spot_blend = 0.35
    if spec["distance"] > 0 and hasattr(light, "use_custom_distance"):
        light.use_custom_distance = True
        light.cutoff_distance = spec["distance"]
    return light


def place(obj, node):
    obj.location = node["location"]
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = node["rotation"]
    obj.scale = node["scale"]


def copy_turn(turn, index):
    """How far copy number 'index' of an array is turned."""
    return (
        Matrix.Rotation(turn[0] * index, 4, "X")
        @ Matrix.Rotation(turn[1] * index, 4, "Z")
        @ Matrix.Rotation(turn[2] * index, 4, "Y")
    )


def array_group():
    """A Geometry Nodes group that repeats a mesh in a row or a ring."""
    name = "AI Blender array"
    tree = bpy.data.node_groups.get(name)
    if tree is not None:
        return tree
    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    tree.is_modifier = True
    inputs = {}
    for label, kind in (("Geometry", "NodeSocketGeometry"), ("Count", "NodeSocketInt"), ("Step", "NodeSocketVector"), ("Turn", "NodeSocketVector")):
        inputs[label] = tree.interface.new_socket(label, in_out="INPUT", socket_type=kind)
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    inputs["Count"].default_value = 1
    inputs["Count"].min_value = 1
    for label, subtype in (("Step", "TRANSLATION"), ("Turn", "EULER")):
        # Shown as a distance and as angles where Blender allows it.
        try:
            inputs[label].subtype = subtype
        except (TypeError, AttributeError):
            pass

    graph = Graph(tree)
    start = graph.node("NodeGroupInput")
    end = graph.node("NodeGroupOutput")
    line = graph.node("GeometryNodeMeshLine", mode="OFFSET")
    graph.plug(line.inputs["Count"], start.outputs["Count"])
    graph.plug(line.inputs["Offset"], start.outputs["Step"])

    # Copy i is turned i times as far as the first: about Y, then Z, then X.
    index = graph.node("GeometryNodeInputIndex").outputs[0]
    turn = graph.node("ShaderNodeSeparateXYZ")
    graph.plug(turn.inputs[0], start.outputs["Turn"])
    rotation = None
    for axis, part in (((0.0, 1.0, 0.0), "Y"), ((0.0, 0.0, 1.0), "Z"), ((1.0, 0.0, 0.0), "X")):
        step = graph.node("FunctionNodeAxisAngleToRotation")
        step.inputs["Axis"].default_value = axis
        graph.plug(step.inputs["Angle"], graph.math("MULTIPLY", index, turn.outputs[part]))
        if rotation is None:
            rotation = step.outputs[0]
            continue
        combine = graph.node("FunctionNodeRotateRotation", rotation_space="GLOBAL")
        graph.plug(combine.inputs["Rotation"], rotation)
        graph.plug(combine.inputs["Rotate By"], step.outputs[0])
        rotation = combine.outputs[0]

    copies = graph.node("GeometryNodeInstanceOnPoints")
    graph.plug(copies.inputs["Points"], line.outputs[0])
    graph.plug(copies.inputs["Instance"], start.outputs["Geometry"])
    graph.plug(copies.inputs["Rotation"], rotation)
    real = graph.node("GeometryNodeRealizeInstances")
    graph.plug(real.inputs[0], copies.outputs[0])
    graph.plug(end.inputs[0], real.outputs[0])
    tree["sockets"] = {label: item.identifier for label, item in inputs.items()}
    return tree


def add_array(obj, spec):
    tree = array_group()
    modifier = obj.modifiers.new("Array", "NODES")
    modifier.node_group = tree
    sockets = tree["sockets"]
    # Blender 5 keeps a modifier's inputs under 'properties'; before that they were custom properties.
    inputs = getattr(getattr(modifier, "properties", None), "inputs", None)

    def give(label, value):
        if inputs is not None:
            getattr(inputs, sockets[label]).value = value
        else:
            modifier[sockets[label]] = value

    try:
        give("Count", spec["count"])
        give("Step", spec["step"])
        # The group turns about Blender's Y, then Z, then X; the data lists the angles as x, z, y.
        give("Turn", (spec["turn"][0], spec["turn"][2], spec["turn"][1]))
    except Exception:
        obj.modifiers.remove(modifier)
        raise
    return True


def add_copies(obj, spec, collection):
    """The fallback for arrays where Geometry Nodes can't be used: one linked object per copy."""
    for index in range(1, spec["count"]):
        copy = obj.copy()
        collection.objects.link(copy)
        copy.matrix_basis = Matrix.Translation(Vector(spec["step"]) * index) @ copy_turn(spec["turn"], index)


def build_rigs(collection, rest):
    """One armature per animated object, with a bone for every group inside it."""
    by_id = {node["id"]: node for node in DATA["nodes"]}
    children = {}
    for node in DATA["nodes"]:
        children.setdefault(node["parent"], []).append(node)

    bones = {}
    for rig in DATA["rigs"]:
        data = bpy.data.armatures.new(rig["name"])
        armature = bpy.data.objects.new(rig["name"], data)
        armature["ai_blender_id"] = rig["root"]
        armature.show_in_front = True
        collection.objects.link(armature)
        bpy.context.view_layer.objects.active = armature
        bpy.ops.object.mode_set(mode="EDIT")
        names = {}
        for node_id in rig["bones"]:
            node = by_id[node_id]
            bone = data.edit_bones.new(node["name"])
            head = rest[node_id].to_translation()
            # A bone points at the joints it carries, or failing that at its own parts.
            below = children.get(node_id, [])
            aims = [rest[c["id"]].to_translation() for c in below if c.get("bone")]
            aims = aims or [rest[c["id"]].to_translation() for c in below]
            reach = sum(aims, Vector()) / len(aims) - head if aims else Vector()
            if reach.length < 0.06:
                reach = Vector((0.0, 0.0, 0.15))
            bone.head = head
            bone.tail = head + reach
            # The nearest group above it is its parent bone.
            above = node["parent"]
            while above is not None and above not in names:
                above = by_id[above]["parent"]
            if above is not None:
                bone.parent = data.edit_bones[names[above]]
            names[node_id] = bone.name
        bpy.ops.object.mode_set(mode="OBJECT")
        for node_id, name in names.items():
            bones[node_id] = (armature, name)
    return bones


def attach(obj, parent_id, objects, bones, rest):
    if parent_id is None:
        return
    if parent_id not in bones:
        obj.parent = objects[parent_id]
        return
    armature, name = bones[parent_id]
    bone = armature.data.bones[name]
    obj.parent = armature
    obj.parent_type = "BONE"
    obj.parent_bone = name
    # Blender hangs a bone's children off its tail, in the bone's own axes.
    # This puts them back in the frame of the group the bone stands for.
    obj.matrix_parent_inverse = Matrix.Translation((0.0, -bone.length, 0.0)) @ bone.matrix_local.inverted() @ rest[parent_id]


def bake_animation(bones, rest):
    """Keys every animated bone on every frame of the clip."""
    clip = DATA["animation"]
    scene = bpy.context.scene
    scene.render.fps = clip["fps"]
    scene.frame_start = 1
    scene.frame_end = clip["frames"]
    by_id = {node["id"]: node for node in DATA["nodes"]}
    for node_id, track in clip["tracks"].items():
        armature, name = bones[node_id]
        pose = armature.pose.bones[name]
        pose.rotation_mode = "QUATERNION"
        node = by_id[node_id]
        # The scene poses a group relative to its parent group; a bone is posed
        # relative to its own rest position. 'frame' goes from one to the other.
        frame = armature.data.bones[name].matrix_local.inverted() @ rest.get(node["parent"], IDENTITY)
        back = trs(node).inverted() @ frame.inverted()
        channels = [path for key, path in (("location", "location"), ("rotation", "rotation_quaternion"), ("scale", "scale")) if key in track]
        previous = None
        for index in range(clip["frames"]):
            local = trs({key: track[key][index] if key in track else node[key] for key in ("location", "rotation", "scale")})
            location, turn, scale = (frame @ local @ back).decompose()
            # Take the short way round from the frame before.
            if previous is not None and previous.dot(turn) < 0:
                turn.negate()
            previous = turn.copy()
            pose.location, pose.rotation_quaternion, pose.scale = location, turn, scale
            for path in channels:
                pose.keyframe_insert(path, frame=index + 1)
    scene.frame_set(1)


def unwrap(objects):
    """Gives hard-surface meshes a UV map with Smart UV Project. Meshes shaded by their own colors don't need one."""
    targets = [o for o in objects if o.type == "MESH" and len(o.data.polygons) > 0 and len(o.data.color_attributes) == 0 and not o.hide_get()]
    if not targets:
        return 0
    bpy.ops.object.select_all(action="DESELECT")
    for obj in targets:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    return len(targets)


def make_camera(collection):
    spec = DATA["camera"]
    data = bpy.data.cameras.new("Camera")
    data.sensor_fit = "VERTICAL"
    data.angle_y = spec["fov"]
    data.clip_end = 1200.0
    camera = bpy.data.objects.new("Camera", data)
    collection.objects.link(camera)
    camera.location = spec["location"]
    camera.rotation_mode = "QUATERNION"
    # Cameras look down their own -Z with +Y up.
    camera.rotation_quaternion = (Vector(spec["target"]) - Vector(spec["location"])).to_track_quat("-Z", "Y")
    bpy.context.scene.camera = camera


def make_grade():
    """The compositor: distance haze, bloom, saturation, contrast and a vignette."""
    grade = DATA["grade"]
    fog = DATA["fog"]
    scene = bpy.context.scene
    modern = hasattr(scene, "compositing_node_group")
    if modern:
        tree = bpy.data.node_groups.new("AI Blender grade", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        scene.compositing_node_group = tree
        output = tree.nodes.new("NodeGroupOutput")
    else:
        scene.use_nodes = True
        tree = scene.node_tree
        tree.nodes.clear()
        output = tree.nodes.new("CompositorNodeComposite")
    graph = Graph(tree)
    layers = graph.node("CompositorNodeRLayers")
    image = layers.outputs["Image"]

    if fog is not None and modern:
        # Haze by distance, using the mist pass.
        bpy.context.view_layer.use_pass_mist = True
        mist = scene.world.mist_settings
        mist.start = fog["near"]
        mist.depth = max(fog["far"] - fog["near"], 0.01)
        mist.falloff = "LINEAR"
        image = graph.mix(layers.outputs["Mist"], image, (*fog["color"], 1.0))

    if grade["bloom"] > 0:
        glare = graph.node("CompositorNodeGlare")
        graph.plug(glare.inputs["Image"], image)
        if modern:
            glare.inputs["Type"].default_value = "Bloom"
            set_input(glare, ["Threshold"], 1.0)
            set_input(glare, ["Strength"], min(1.0, grade["bloom"] * 0.5))
            set_input(glare, ["Size"], 0.5)
        else:
            glare.glare_type = "BLOOM" if bpy.app.version >= (4, 2, 0) else "FOG_GLOW"
            glare.threshold = 1.0
        image = glare.outputs["Image"]

    if grade["saturation"] != 1:
        colors = graph.node("CompositorNodeHueSat")
        graph.plug(colors.inputs["Image"], image)
        set_input(colors, ["Saturation"], grade["saturation"])
        image = colors.outputs["Image"]

    if grade["contrast"] != 0:
        contrast = graph.node("CompositorNodeBrightContrast")
        graph.plug(contrast.inputs["Image"], image)
        # Blender's contrast runs to 100.
        set_input(contrast, ["Contrast"], grade["contrast"] * 25.0)
        image = contrast.outputs["Image"]

    if grade["vignette"] > 0 and modern:
        # Darker with distance from the middle of the frame.
        where = graph.node("CompositorNodeImageCoordinates")
        graph.plug(where.inputs["Image"], image)
        middle = graph.node("ShaderNodeVectorMath", operation="SUBTRACT")
        graph.plug(middle.inputs[0], where.outputs["Normalized"])
        middle.inputs[1].default_value = (0.5, 0.5, 0.0)
        away = graph.node("ShaderNodeVectorMath", operation="LENGTH")
        graph.plug(away.inputs[0], middle.outputs[0])
        edge = graph.remap(away.outputs["Value"], 0.3, 0.75, 0.0, grade["vignette"], "SMOOTHSTEP")
        image = graph.mix(edge, image, (0.0, 0.0, 0.0, 1.0))

    graph.plug(output.inputs[0], image)


def render_settings():
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = DATA["render"]["size"]
    # Blender's default look is flatter than the editor's filmic picture.
    # The name of the look depends on the Blender version.
    for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            pass
    if hasattr(scene, "cycles"):
        scene.cycles.samples = 96
        scene.cycles.use_denoising = True
    if hasattr(getattr(scene, "eevee", None), "use_raytracing"):
        # Bounced light and contact shadows in EEVEE.
        scene.eevee.use_raytracing = True


def option(name):
    """The value given after '--name' on the command line, past Blender's own '--'."""
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def render(collection):
    """Renders when asked to on the command line: '-- --video out.mp4' or '-- --still out.png'."""
    scene = bpy.context.scene
    video, still = option("--video"), option("--still")
    if video is None and still is None:
        return
    # Render this scene only, not what the file already held (the startup cube and lamp, say).
    ours = set(collection.all_objects)
    for obj in scene.objects:
        if obj not in ours:
            obj.hide_render = True
    engine = option("--engine")
    if engine is not None:
        scene.render.engine = "CYCLES" if engine.lower() == "cycles" else next(
            e.identifier for e in type(scene.render).bl_rna.properties["engine"].enum_items if "EEVEE" in e.identifier
        )
    if option("--samples") is not None:
        samples = int(option("--samples"))
        if scene.render.engine == "CYCLES":
            scene.cycles.samples = samples
        else:
            scene.eevee.taa_render_samples = samples
    if option("--percent") is not None:
        scene.render.resolution_percentage = int(option("--percent"))
    settings = scene.render.image_settings
    if still is not None:
        scene.frame_set(int(option("--frame") or scene.frame_current))
        if hasattr(settings, "media_type"):
            settings.media_type = "IMAGE"
        settings.file_format = "PNG"
        scene.render.filepath = os.path.abspath(still)
        bpy.ops.render.render(write_still=True)
    if video is not None:
        if hasattr(settings, "media_type"):
            settings.media_type = "VIDEO"
        settings.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        scene.render.ffmpeg.constant_rate_factor = "HIGH"
        scene.render.filepath = os.path.abspath(video)
        bpy.ops.render.render(animation=True)


def build():
    scene = bpy.context.scene
    collection = bpy.data.collections.new(DATA["name"])
    scene.collection.children.link(collection)

    # Where everything stands before any animation, in world space.
    rest = {}
    for node in DATA["nodes"]:
        rest[node["id"]] = rest.get(node["parent"], IDENTITY) @ trs(node)
    bones = attempt("the rig", build_rigs, collection, rest) or {}

    materials = {}
    objects = {}
    made = []
    for node in DATA["nodes"]:
        data = None
        if node["kind"] == "mesh":
            # Each object gets its own mesh, so editing one never changes another.
            bake = trs(node["bake"]) if "bake" in node else None
            data = make_mesh(node["name"], node.get("meshData") or DATA["meshes"][node["mesh"]], bake)
            key = repr(node["material"])
            if key not in materials:
                materials[key] = make_material(node["name"], node["material"])
            data.materials.append(materials[key])
        elif node["kind"] == "light":
            data = make_light(node["name"], node["light"])
        elif node["id"] in bones:
            # A rigged group is a bone, not an object.
            continue

        obj = bpy.data.objects.new(node["name"], data)
        # Blender renames duplicates ("Chair.001"), so keep the scene id on the object.
        obj["ai_blender_id"] = node["id"]
        if data is None:
            obj.empty_display_type = "PLAIN_AXES"
            obj.empty_display_size = 0.25
        collection.objects.link(obj)
        if node["id"] in bones:
            # The fused surface of a rigged group rides on that group's own bone.
            attach(obj, node["id"], objects, bones, rest)
        else:
            attach(obj, node["parent"], objects, bones, rest)
            place(obj, node)
        if not node["visible"]:
            # The eye icon in the outliner, so it is easy to show again.
            obj.hide_set(True)
            obj.hide_render = True
        if "array" in node and not attempt("a Geometry Nodes array", add_array, obj, node["array"]):
            add_copies(obj, node["array"], collection)
        objects[node["id"]] = obj
        made.append(obj)

    sun_spec = DATA["sun"]
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.color = sun_spec["color"]
    sun.energy = sun_spec["strength"]
    # A sun a few degrees wide, for shadows with soft edges.
    sun.angle = math.radians(3.0)
    sun_object = bpy.data.objects.new("Sun", sun)
    collection.objects.link(sun_object)
    place(sun_object, {"location": (0.0, 0.0, 20.0), "rotation": sun_spec["rotation"], "scale": (1.0, 1.0, 1.0)})

    ground = DATA["ground"]
    if ground is not None:
        s = ground["halfSize"]
        mesh = make_mesh("Ground", {"verts": [(-s, -s, 0.0), (s, -s, 0.0), (s, s, 0.0), (-s, s, 0.0)], "faces": [(0, 1, 2, 3)], "smooth": False})
        mesh.materials.append(make_material("Ground", ground["material"]))
        collection.objects.link(bpy.data.objects.new("Ground", mesh))

    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        scene.world = world
    if NODES_ARE_OPTIONAL:
        world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (*DATA["world"]["color"], 1.0)
        background.inputs["Strength"].default_value = DATA["world"]["strength"]

    make_camera(collection)
    render_settings()
    unwrapped = attempt("UV unwrapping", unwrap, made) or 0
    if DATA["animation"] is not None and bones:
        attempt("the animation", bake_animation, bones, rest)
    attempt("the compositor", make_grade)

    print(f"AI Blender: built {len(made)} objects and {len(bones)} bones in collection '{collection.name}', unwrapped {unwrapped}")
    render(collection)


build()
`;

export function toBlenderScript(scene: Scene, title = "Scene"): string {
  // The data is JSON inside a JSON string literal. That literal is also a
  // valid Python string, so names and other text can never run as code.
  const literal = JSON.stringify(JSON.stringify(blenderData(scene, title)));
  return [
    `# ${title.replace(/[\r\n]+/g, " ")} — exported from AI Blender.`,
    "# Run in Blender: Scripting workspace > Open > Run Script, or `blender --python <this file>`.",
    "# It adds a new collection with its own camera, and sets the world, the frame range and the",
    "# compositor; nothing existing is deleted, so start from an empty file or delete the startup cube.",
    "# To render without opening Blender:",
    "#   blender -b --python <this file> -- --video out.mp4      (or --still out.png --frame 24)",
    "#   optional: --engine cycles|eevee  --samples 64  --percent 50",
    "# A render started this way leaves out whatever else is in the file.",
    "import json",
    "",
    `DATA = json.loads(${literal})`,
    SCRIPT,
  ].join("\n");
}
