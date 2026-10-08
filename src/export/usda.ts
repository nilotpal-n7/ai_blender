/**
 * OpenUSD (.usda) export.
 *
 * Layout: /World/Geometry holds the scene hierarchy, /World/Materials the
 * surfaces, /World/Environment the sun, sky and ground, /World/Camera the
 * camera. The stage is Y-up in meters, like the editor, so no axis conversion
 * is needed. Animation is written as time samples on the groups that move.
 *
 * Light intensities are approximate: renderers disagree on light units.
 */

import { frameCount, sampleTrack, trackOf } from "@/scene/animate";
import { arrayCopies } from "@/scene/array";
import { DEG, eulerToQuat, hexToLinear, lookAtQuat, quatFromTo, round, sunDirection, type Quat } from "@/scene/math";
import { childIds } from "@/scene/ops";
import {
  DEFAULT_MATERIAL,
  type Animatable,
  type Material,
  type MeshNode,
  type Primitive,
  type Scene,
  type SceneNode,
  type Vec3,
} from "@/scene/types";
import { EXPORT_DETAIL, fusedFinish, fusedMesh, isFused } from "@/shapes/blend";
import type { MeshData } from "@/shapes/mesh";
import { GENERATED, isBeveled, nodeMesh, primitiveMesh, vertexNormals } from "./meshdata";

const GROUND_HALF_SIZE = 150;
/** UsdLux lights shine down −Z; scene spot lights shine down −Y. */
const SPOT_AIM: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** Radius given to point and spot lights, which USD models as small spheres. */
const LIGHT_RADIUS = 0.05;

const num = (n: number) => String(round(n, 6));
const tuple = (v: readonly number[]) => `(${v.map(num).join(", ")})`;
const color = (hex: string) => tuple(hexToLinear(hex));
/**
 * USD quaternions are written real part first. They get more digits than
 * other numbers: readers that recover the angle from the real part alone lose
 * accuracy on small rotations otherwise.
 */
const quat = ([x, y, z, w]: Quat) => `(${[w, x, y, z].map((n) => round(n, 9)).join(", ")})`;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Big arrays are written with just enough digits: a tenth of a millimeter for points. */
const compact = (v: readonly number[], places: number) => `(${v.map((n) => round(n, places)).join(", ")})`;

/**
 * @param tint linear color the mesh's own colors are multiplied by; USD's
 *   preview material can't multiply, so the product is written per point
 */
function meshAttributes(mesh: MeshData, doubleSided = false, tint: Vec3 = [1, 1, 1]): string[] {
  const xs = mesh.points.map((p) => p[0]);
  const ys = mesh.points.map((p) => p[1]);
  const zs = mesh.points.map((p) => p[2]);
  const lines = [
    `float3[] extent = [${tuple([Math.min(...xs), Math.min(...ys), Math.min(...zs)])}, ${tuple([Math.max(...xs), Math.max(...ys), Math.max(...zs)])}]`,
    `int[] faceVertexCounts = [${mesh.faces.map((f) => f.length).join(", ")}]`,
    `int[] faceVertexIndices = [${mesh.faces.flat().join(", ")}]`,
    `point3f[] points = [${mesh.points.map((p) => compact(p, 4)).join(", ")}]`,
    `uniform token subdivisionScheme = "none"`,
  ];
  if (mesh.smooth) {
    const normals = mesh.normals ?? vertexNormals(mesh);
    lines.push(
      `normal3f[] normals = [${normals.map((n) => compact(n, 3)).join(", ")}] (\n    interpolation = "vertex"\n)`,
    );
  }
  if (mesh.colors) {
    const shown = mesh.colors.map((c) => compact(c.map((v, i) => toLinear(v) * tint[i]), 3));
    lines.push(`color3f[] primvars:displayColor = [${shown.join(", ")}] (\n    interpolation = "vertex"\n)`);
  }
  if (doubleSided) lines.push("uniform bool doubleSided = 1");
  return lines;
}

/** The prim type and attributes for a mesh node. Plain solids use USD's native shapes. */
function geometry(node: MeshNode): { type: string; lines: string[] } {
  const unit = "float3[] extent = [(-0.5, -0.5, -0.5), (0.5, 0.5, 0.5)]";
  const { primitive } = node;
  // A rounded box has no native shape; its mesh is written out.
  if (isBeveled(node)) return { type: "Mesh", lines: meshAttributes(nodeMesh(node)) };
  switch (primitive) {
    case "box":
      return { type: "Cube", lines: ["double size = 1", unit] };
    case "sphere":
      return { type: "Sphere", lines: ["double radius = 0.5", unit] };
    case "cylinder":
    case "cone":
      return {
        type: primitive === "cone" ? "Cone" : "Cylinder",
        lines: ['uniform token axis = "Y"', "double height = 1", "double radius = 0.5", unit],
      };
    default:
      return { type: "Mesh", lines: meshAttributes(primitiveMesh(primitive), primitive === "plane") };
  }
}

class Writer {
  private lines: string[] = [];
  private depth = 0;

  line(text = "") {
    for (const part of text.split("\n")) {
      this.lines.push(part ? "    ".repeat(this.depth) + part : "");
    }
  }

  /** Writes `def Type "name" (metadata) { … }` around whatever `body` emits. */
  prim(type: string, name: string, metadata: string[], body: () => void, specifier = "def") {
    this.line(`${specifier} ${type} "${name}"` + (metadata.length > 0 ? " (" : ""));
    if (metadata.length > 0) {
      this.depth++;
      metadata.forEach((m) => this.line(m));
      this.depth--;
      this.line(")");
    }
    this.line("{");
    this.depth++;
    body();
    this.depth--;
    this.line("}");
  }

  toString() {
    return this.lines.join("\n") + "\n";
  }
}

export function toUsda(scene: Scene, title = "Scene"): string {
  const out = new Writer();
  const env = scene.environment;

  // Identical materials are written once and shared.
  const materialNames = new Map<string, string>();
  const materials: { material: Material; vertexColors: boolean }[] = [];
  /** @param vertexColors the surface color comes from the mesh's displayColor instead */
  const materialFor = (material: Material, vertexColors = false): string => {
    const key = JSON.stringify([vertexColors ? { ...material, color: "" } : material, vertexColors]);
    let name = materialNames.get(key);
    if (!name) {
      name = `mat_${materials.length}`;
      materialNames.set(key, name);
      materials.push({ material, vertexColors });
    }
    return name;
  };

  /** A sibling name that no scene node uses (prim names share the id grammar). */
  const freeName = (base: string) => {
    let name = base;
    while (name in scene.nodes) name += "_";
    return name;
  };
  const binding = ['prepend apiSchemas = ["MaterialBindingAPI"]'];

  const transform = (position: Vec3, orientation: Quat, scale?: Vec3) => {
    out.line(`double3 xformOp:translate = ${tuple(position)}`);
    out.line(`quatf xformOp:orient = ${quat(orientation)}`);
    if (scale) out.line(`float3 xformOp:scale = ${tuple(scale)}`);
    const order = ["translate", "orient", ...(scale ? ["scale"] : [])];
    out.line(`uniform token[] xformOpOrder = [${order.map((op) => `"xformOp:${op}"`).join(", ")}]`);
  };

  // Animation: one time sample per frame, taken the same way the viewport plays the clip.
  const { clip } = scene;
  const frames = clip.tracks.length > 0 ? frameCount(clip) : 0;
  const samplesOf = (id: string, property: Animatable): Vec3[] | null => {
    const track = trackOf(scene, id, property);
    if (!track) return null;
    return Array.from({ length: frames }, (_, frame) =>
      sampleTrack(track.keys, Math.min(frame / clip.fps, clip.duration)),
    );
  };
  const timeSamples = (attribute: string, values: string[]) => {
    out.line(`${attribute}.timeSamples = {`);
    values.forEach((value, frame) => out.line(`    ${frame}: ${value},`));
    out.line("}");
  };
  const animate = (id: string) => {
    const position = samplesOf(id, "position");
    if (position) timeSamples("double3 xformOp:translate", position.map(tuple));
    const turns = samplesOf(id, "rotation");
    if (turns) {
      let previous: Quat | null = null;
      const orientations = turns.map((turn) => {
        let q = eulerToQuat(turn);
        // The same rotation has two quaternions; stay on the side of the frame before.
        if (previous && q[0] * previous[0] + q[1] * previous[1] + q[2] * previous[2] + q[3] * previous[3] < 0) {
          q = q.map((n) => -n) as Quat;
        }
        previous = q;
        return quat(q);
      });
      timeSamples("quatf xformOp:orient", orientations);
    }
    const scale = samplesOf(id, "scale");
    if (scale) timeSamples("float3 xformOp:scale", scale.map(tuple));
  };

  // Generated shapes have thousands of points, so each distinct shape and
  // color is written once, as a class, and the objects that use it refer to it.
  const prototypes = new Map<string, { name: string; primitive: Primitive; color: string }>();
  const prototypeFor = (primitive: Primitive, color: string): string => {
    const key = `${primitive} ${color}`;
    if (!prototypes.has(key)) prototypes.set(key, { name: `${primitive}_${prototypes.size}`, primitive, color });
    return prototypes.get(key)!.name;
  };

  /** A part fused into its group's surface is only written if something hangs off it. */
  const isWritten = (id: string) =>
    !isFused(scene, scene.nodes[id]) || childIds(scene, id).length > 0;

  const writeGeometry = (node: MeshNode, name: string) => {
    const colored = GENERATED.has(node.primitive);
    const { type, lines } = colored ? { type: "Mesh", lines: [] } : geometry(node);
    const metadata = colored
      ? [...binding, `prepend references = </World/Prototypes/${prototypeFor(node.primitive, node.material.color)}>`]
      : binding;
    out.prim(type, name, metadata, () => {
      lines.forEach((l) => out.line(l));
      out.line(`rel material:binding = </World/Materials/${materialFor(node.material, colored)}>`);
    });
  };

  const writeNode = (node: SceneNode) => {
    const drawn = node.kind === "mesh" && !isFused(scene, node) ? node : null;
    out.prim("Xform", node.id, [`displayName = ${JSON.stringify(node.name)}`], () => {
      if (!node.visible) out.line('token visibility = "invisible"');
      transform(node.position, eulerToQuat(node.rotation), node.scale);
      if (node.kind === "group") animate(node.id);

      if (drawn) {
        out.line();
        writeGeometry(drawn, freeName(`${node.id}_geo`));
      }
      if (node.kind === "group" && node.blend > 0) {
        // The group's solid parts, fused into one surface.
        const surface = fusedMesh(scene, node, EXPORT_DETAIL);
        if (surface.points.length > 0) {
          const finish = { ...DEFAULT_MATERIAL, ...fusedFinish(scene, node) };
          out.line();
          out.prim("Mesh", freeName(`${node.id}_fused`), binding, () => {
            meshAttributes(surface).forEach((l) => out.line(l));
            out.line(`rel material:binding = </World/Materials/${materialFor(finish, true)}>`);
          });
        }
      }
      if (node.kind === "light") {
        const { light } = node;
        const spot = light.type === "spot";
        out.line();
        out.prim("SphereLight", freeName(`${node.id}_light`), spot ? ['prepend apiSchemas = ["ShapingAPI"]'] : [], () => {
          out.line(`color3f inputs:color = ${color(light.color)}`);
          // Radiance that gives a sphere of this radius the requested intensity.
          out.line(`float inputs:intensity = ${num(light.intensity / (Math.PI * LIGHT_RADIUS ** 2))}`);
          out.line(`float inputs:radius = ${LIGHT_RADIUS}`);
          if (spot) {
            out.line(`float inputs:shaping:cone:angle = ${num(light.angle)}`);
            out.line("float inputs:shaping:cone:softness = 0.35");
            out.line(`quatf xformOp:orient = ${quat(SPOT_AIM)}`);
            out.line('uniform token[] xformOpOrder = ["xformOp:orient"]');
          }
        });
      }
      for (const childId of childIds(scene, node.id).filter(isWritten)) {
        out.line();
        writeNode(scene.nodes[childId]);
      }
    });
    // The copies of an arrayed mesh stand beside it, each in a frame of its own.
    arrayCopies(drawn?.array ?? null).slice(1).forEach((copy, i) => {
      out.line();
      out.prim("Xform", freeName(`${node.id}_copy${i + 2}`), [`displayName = ${JSON.stringify(`${node.name} ${i + 2}`)}`], () => {
        if (!node.visible) out.line('token visibility = "invisible"');
        transform(copy.position, eulerToQuat(copy.rotation));
        out.line();
        out.prim("Xform", "part", [], () => {
          transform(node.position, eulerToQuat(node.rotation), node.scale);
          out.line();
          writeGeometry(drawn!, "geo");
        });
      });
    });
  };

  out.line("#usda 1.0");
  out.line("(");
  out.line('    defaultPrim = "World"');
  out.line(`    doc = ${JSON.stringify(`${title} — exported from AI Blender`)}`);
  out.line("    metersPerUnit = 1");
  out.line('    upAxis = "Y"');
  if (frames > 0) {
    out.line("    startTimeCode = 0");
    out.line(`    endTimeCode = ${frames - 1}`);
    out.line(`    timeCodesPerSecond = ${clip.fps}`);
    out.line(`    framesPerSecond = ${clip.fps}`);
  }
  out.line(")");
  out.line();

  out.prim("Xform", "World", ['kind = "assembly"'], () => {
    out.prim("Scope", "Geometry", [], () => {
      childIds(scene, null).forEach((id, i) => {
        if (i > 0) out.line();
        writeNode(scene.nodes[id]);
      });
    });
    out.line();

    if (prototypes.size > 0) {
      out.prim("Scope", "Prototypes", [], () => {
        [...prototypes.values()].forEach(({ name, primitive, color }, i) => {
          if (i > 0) out.line();
          out.prim(
            "Mesh",
            name,
            [],
            () => meshAttributes(primitiveMesh(primitive), false, hexToLinear(color)).forEach((l) => out.line(l)),
            "class",
          );
        });
      });
      out.line();
    }

    out.prim("Camera", "Camera", [], () => {
      // A 16:9 film back; the focal length gives the editor's vertical field of view.
      const aperture = 20.25;
      out.line("float2 clippingRange = (0.1, 1200)");
      out.line(`float focalLength = ${num(aperture / 2 / Math.tan((scene.camera.fov * DEG) / 2))}`);
      out.line("float horizontalAperture = 36");
      out.line(`float verticalAperture = ${aperture}`);
      out.line('token projection = "perspective"');
      transform(scene.camera.position, lookAtQuat(scene.camera.position, scene.camera.target));
    });
    out.line();

    out.prim("Scope", "Environment", [], () => {
      out.prim("DistantLight", "Sun", [], () => {
        out.line(`color3f inputs:color = ${color(env.sun.color)}`);
        out.line(`float inputs:intensity = ${num(env.sun.intensity)}`);
        out.line("float inputs:angle = 1");
        // Distant lights shine down −Z, so +Z has to point back at the sun.
        transform([0, 0, 0], quatFromTo([0, 0, 1], sunDirection(env.sun)));
      });
      out.line();
      out.prim("DomeLight", "Sky", [], () => {
        out.line(`color3f inputs:color = ${color(env.background)}`);
        out.line(`float inputs:intensity = ${num(env.ambient)}`);
      });
      if (env.ground.visible) {
        const s = GROUND_HALF_SIZE;
        out.line();
        out.prim("Mesh", "Ground", binding, () => {
          const ground: MeshData = {
            points: [[-s, 0, -s], [s, 0, -s], [s, 0, s], [-s, 0, s]],
            faces: [[0, 3, 2, 1]],
            smooth: false,
          };
          meshAttributes(ground).forEach((l) => out.line(l));
          out.line("rel material:binding = </World/Materials/ground>");
        });
      }
    });
    out.line();

    out.prim("Scope", "Materials", [], () => {
      const writeMaterial = (name: string, material: Material, vertexColors = false) => {
        out.prim("Material", name, [], () => {
          const here = `</World/Materials/${name}`;
          out.line(`token outputs:surface.connect = ${here}/surface.outputs:surface>`);
          out.line();
          if (vertexColors) {
            out.prim("Shader", "colors", [], () => {
              out.line('uniform token info:id = "UsdPrimvarReader_float3"');
              out.line('string inputs:varname = "displayColor"');
              out.line("float3 outputs:result");
            });
            out.line();
          }
          out.prim("Shader", "surface", [], () => {
            out.line('uniform token info:id = "UsdPreviewSurface"');
            out.line(
              vertexColors
                ? `color3f inputs:diffuseColor.connect = ${here}/colors.outputs:result>`
                : `color3f inputs:diffuseColor = ${color(material.color)}`,
            );
            const glow = hexToLinear(material.emissive).map((c) => c * material.emissiveIntensity);
            out.line(`color3f inputs:emissiveColor = ${tuple(glow)}`);
            out.line(`float inputs:metallic = ${num(material.metalness)}`);
            out.line(`float inputs:opacity = ${num(material.opacity)}`);
            out.line(`float inputs:roughness = ${num(material.roughness)}`);
            out.line("token outputs:surface");
          });
        });
      };
      materials.forEach(({ material, vertexColors }, i) => {
        if (i > 0) out.line();
        writeMaterial(`mat_${i}`, material, vertexColors);
      });
      if (env.ground.visible) {
        if (materials.length > 0) out.line();
        writeMaterial("ground", { ...DEFAULT_MATERIAL, color: env.ground.color, roughness: 1 });
      }
    });
  });

  return out.toString();
}
