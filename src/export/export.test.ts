import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createOfflinePlanner } from "@/planner/offline";
import { runTool } from "@/planner/tools";
import { eulerToQuat, lookAtQuat, quatFromTo, sunDirection } from "@/scene/math";
import { applyOps } from "@/scene/ops";
import { PRIMITIVES, emptyScene, type Scene, type Vec3 } from "@/scene/types";
import { primitiveGeometry } from "@/three/geometry";
import { blenderData, toBlenderScript, type BlenderNode } from "./blender";
import { faceNormal, primitiveMesh, vertexNormals } from "./meshdata";
import { toUsda } from "./usda";

async function build(prompt: string): Promise<Scene> {
  let scene = emptyScene();
  await createOfflinePlanner({ delayMs: 0 }).run(
    { scene, prompt, chat: [], selection: [] },
    (event) => {
      if (event.type === "ops") scene = applyOps(scene, event.ops).scene;
    },
    new AbortController().signal,
  );
  return scene;
}

/** Rotates `v` by quaternion `[x, y, z, w]`. */
function rotate([x, y, z, w]: readonly number[], v: Vec3): Vec3 {
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const t = cross([x, y, z], v).map((n) => 2 * n);
  const u = cross([x, y, z], t);
  return [v[0] + w * t[0] + u[0], v[1] + w * t[1] + u[1], v[2] + w * t[2] + u[2]];
}
const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((n, i) => expect(n).toBeCloseTo(b[i], 5));

describe("primitive meshes", () => {
  for (const primitive of PRIMITIVES) {
    const mesh = primitiveMesh(primitive);

    it(primitive + " fits the unit size the editor documents", () => {
      const span = (axis: number) => {
        const values = mesh.points.map((p) => p[axis]);
        return Math.max(...values) - Math.min(...values);
      };
      const height = { torus: 0.25, plane: 0 }[primitive as string] ?? 1;
      expect(span(0)).toBeCloseTo(1, 5);
      expect(span(1)).toBeCloseTo(height, 5);
      expect(span(2)).toBeCloseTo(1, 5);
    });

    // A pine is many separate boughs, not one solid; src/shapes tests cover its winding.
    if (primitive === "pine") continue;

    it(primitive + " faces all point outward", () => {
      for (const face of mesh.faces) {
        const centroid = [0, 1, 2].map(
          (axis) => face.reduce((sum, i) => sum + mesh.points[i][axis], 0) / face.length,
        );
        // "Inside" is the shape's center, or for the torus the middle of the tube.
        let inside = [0, 0, 0];
        if (primitive === "torus") {
          const d = Math.hypot(centroid[0], centroid[2]);
          inside = [(centroid[0] / d) * 0.375, 0, (centroid[2] / d) * 0.375];
        }
        if (primitive === "plane") inside = [0, -1, 0];
        // The middle of a wedge is on its slope, so look from deeper inside.
        if (primitive === "wedge") inside = [0, -0.25, -0.25];
        const normal = faceNormal(mesh.points, face);
        const outward = centroid.map((c, i) => c - inside[i]);
        expect(normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2]).toBeGreaterThan(0);
      }
    });

    if (primitive !== "plane") {
      it(primitive + " is watertight", () => {
        // In a closed, consistently wound mesh every directed edge has exactly one opposite.
        const edges = new Map<string, number>();
        for (const face of mesh.faces) {
          face.forEach((a, i) => {
            const key = a + ">" + face[(i + 1) % face.length];
            edges.set(key, (edges.get(key) ?? 0) + 1);
          });
        }
        for (const [key, count] of edges) {
          expect(count).toBe(1);
          expect(edges.get(key.split(">").reverse().join(">"))).toBe(1);
        }
      });
    }
  }

  it("match the geometry the viewport draws", () => {
    for (const primitive of PRIMITIVES) {
      const drawn = primitiveGeometry(primitive);
      drawn.computeBoundingBox();
      const exported = new THREE.Box3().setFromPoints(
        primitiveMesh(primitive).points.map((p) => new THREE.Vector3(...p)),
      );
      close(drawn.boundingBox!.min.toArray(), exported.min.toArray());
      close(drawn.boundingBox!.max.toArray(), exported.max.toArray());
    }
    // The pyramid's base corners line up with the axes in both.
    const corners = (points: number[][]) =>
      points
        // Base vertices only, without the center point three.js adds to cap the base.
        .filter((p) => p[1] < 0 && Math.abs(p[0]) > 0.25)
        .map((p) => p.map((n) => Math.round(n * 2) / 2).join())
        .sort();
    const position = primitiveGeometry("pyramid").getAttribute("position");
    const drawn = Array.from({ length: position.count }, (_, i) => [position.getX(i), position.getY(i), position.getZ(i)]);
    expect(new Set(corners(drawn))).toEqual(new Set(corners(primitiveMesh("pyramid").points)));
    expect([...new Set(corners(drawn))]).toHaveLength(4);
  });

  it("vertex normals of a sphere are unit length and point away from its center", () => {
    const mesh = primitiveMesh("sphere");
    vertexNormals(mesh).forEach((normal, i) => {
      expect(Math.hypot(...normal)).toBeCloseTo(1, 5);
      const radial = mesh.points[i].map((c) => c * 2);
      expect(normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2]).toBeGreaterThan(0.97);
    });
  });
});

describe("math used by the exporters", () => {
  it("eulerToQuat agrees with three.js, which is what the viewport renders with", () => {
    for (const rotation of [[30, 0, 0], [0, 45, 0], [0, 0, 60], [10, 20, 30], [-170, 85, 200]] as Vec3[]) {
      const [x, y, z] = rotation.map((d) => (d * Math.PI) / 180);
      const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ"));
      close(eulerToQuat(rotation), expected.toArray());
    }
  });

  it("eulerToQuat applies X, then Y, then Z like three.js XYZ order", () => {
    // 90° about X takes +Y to +Z; a further 90° about the rotated Y axis leaves it there.
    close(rotate(eulerToQuat([90, 0, 0]), [0, 1, 0]), [0, 0, 1]);
    close(rotate(eulerToQuat([90, 90, 0]), [1, 0, 0]), [0, 1, 0]);
    close(rotate(eulerToQuat([0, 0, 90]), [1, 0, 0]), [0, 1, 0]);
  });

  it("quatFromTo rotates one direction onto another, including opposite ones", () => {
    const sun = sunDirection({ azimuth: 35, elevation: 50, intensity: 1, color: "#ffffff" });
    close(rotate(quatFromTo([0, 0, 1], sun), [0, 0, 1]), sun);
    close(rotate(quatFromTo([0, 0, 1], [0, 0, -1]), [0, 0, 1]), [0, 0, -1]);
  });
});

describe("USD export", () => {
  it("writes the hierarchy, shared materials and environment", async () => {
    const scene = await build("a red cube on a wooden table with a spotlight");
    const usda = toUsda(scene, "Demo");

    expect(usda.startsWith("#usda 1.0\n")).toBe(true);
    expect(usda).toContain('defaultPrim = "World"');
    expect(usda).toContain('upAxis = "Y"');
    // The table's parts are nested inside the table.
    expect(usda).toMatch(/def Xform "table" \([^)]*\)\s*\{[\s\S]*def Xform "table__top"/);
    expect(usda).toContain('def Cube "cube_geo"');
    expect(usda).toContain('def SphereLight "spotlight_1_light"');
    expect(usda).toContain("inputs:shaping:cone:angle = 28");
    expect(usda).toContain('def DistantLight "Sun"');
    expect(usda).toContain('def Mesh "Ground"');
    // Identical materials are shared: table top, the four legs, the cube.
    expect(usda.match(/def Material "mat_\d+"/g)).toHaveLength(3);
    expect(usda.match(/rel material:binding = <\/World\/Materials\/mat_1>/g)).toHaveLength(4);
    // Braces and parentheses balance.
    for (const [open, shut] of ["{}", "()", "[]"]) {
      expect(usda.split(open).length).toBe(usda.split(shut).length);
    }
  });

  it("writes explicit meshes for shapes USD has no native prim for", () => {
    const scene = runTool(emptyScene(), "add_object", {
      id: "roof", name: "Roof", position: [0, 2, 0], primitive: "pyramid", scale: [4, 1.5, 4],
    }).scene;
    const usda = toUsda(scene);
    expect(usda).toContain('def Mesh "roof_geo"');
    expect(usda).toContain("int[] faceVertexCounts = [3, 3, 3, 3, 4]");
    expect(usda).toContain("float3 xformOp:scale = (4, 1.5, 4)");
  });

  it("keeps helper prims from colliding with scene ids and escapes names", () => {
    let scene = runTool(emptyScene(), "add_object", {
      id: "a", name: 'Say "hi"\n', position: [0, 0, 0], primitive: "box",
    }).scene;
    scene = runTool(scene, "add_object", { id: "a_geo", name: "Child", parent: "a", position: [0, 1, 0], primitive: "box" }).scene;
    const usda = toUsda(scene);
    expect(usda).toContain('def Cube "a_geo_"');
    expect(usda).toContain('def Xform "a_geo"');
    expect(usda).toContain('displayName = "Say \\"hi\\"\\n"');
  });
});

describe("Blender export", () => {
  it("converts Y-up to Z-up for positions, sizes, rotations and mesh data", async () => {
    let scene = runTool(emptyScene(), "add_object", {
      id: "post", name: "Post", position: [1, 2, 3], rotation: [90, 0, 0], scale: [0.2, 4, 0.3], primitive: "cylinder",
    }).scene;
    scene = runTool(scene, "add_light", { id: "spot", name: "Spot", type: "spot", position: [0, 5, 0], angle: 30 }).scene;
    const data = blenderData(scene, "Test");

    const post = data.nodes[0];
    expect(post.location).toEqual([1, -3, 2]);
    // The size goes into the mesh's points, so the object itself is unscaled.
    expect(post.scale).toEqual([1, 1, 1]);
    expect(post.bake).toEqual({ scale: [0.2, 0.3, 4] }); // height is along Blender's Z
    // 90° about X is the same rotation in both spaces, because X is shared.
    close(post.rotation, [Math.SQRT1_2, Math.SQRT1_2, 0, 0]);

    // The unit cylinder's axis becomes Blender's Z.
    const zs = data.meshes.cylinder.verts.map((v) => v[2]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([-0.5, 0.5]);

    const spot = data.nodes[1];
    expect(spot.light).toMatchObject({ type: "spot" });
    expect(spot.light!.spotSize).toBeCloseTo(Math.PI / 3, 5); // full cone angle
    // Unrotated, the lamp keeps Blender's default aim (−Z), which is "down" in both spaces.
    expect(spot.rotation).toEqual([1, 0, 0, 0]);
  });

  it("points the sun lamp's +Z back at the sun", () => {
    const scene = emptyScene();
    const [w, x, y, z] = blenderData(scene, "Sun").sun.rotation;
    const [sx, sy, sz] = sunDirection(scene.environment.sun);
    close(rotate([x, y, z, w], [0, 0, 1]), [sx, -sz, sy]);
  });

  it("lists parents before children and only embeds the meshes it uses", async () => {
    const data = blenderData(await build("a table and a sphere"), "Test");
    const seen = new Set<string>();
    for (const node of data.nodes) {
      if (node.parent !== null) expect(seen.has(node.parent)).toBe(true);
      seen.add(node.id);
    }
    expect(Object.keys(data.meshes).sort()).toEqual(["box", "sphere"]);
  });

  it("hides everything under a hidden object, since Blender would not", async () => {
    let scene = await build("a table and a cube");
    scene = runTool(scene, "update_object", { id: "table", visible: false }).scene;
    const visible = Object.fromEntries(blenderData(scene, "Test").nodes.map((n) => [n.id, n.visible]));
    expect(visible).toMatchObject({ table: false, table__top: false, table__leg_1: false, cube: true });
  });

  it("embeds the scene as inert data, whatever the names contain", () => {
    const hostile = 'x"); import os; os.system("calc") #\'\'\'"""\n\\';
    const scene = runTool(emptyScene(), "add_object", {
      id: "a", name: hostile.slice(0, 80), position: [0, 0, 0], primitive: "box",
    }).scene;
    const script = toBlenderScript(scene, "Title\nimport os");

    // The title can't break out of its comment line.
    expect(script.split("\n")[0]).toBe("# Title import os — exported from AI Blender.");
    // The data is exactly one line: a JSON string literal holding JSON.
    const line = script.split("\n").find((l) => l.startsWith("DATA = json.loads("))!;
    const literal = line.slice("DATA = json.loads(".length, -1);
    const data = JSON.parse(JSON.parse(literal));
    expect(data.nodes[0].name).toBe(hostile.slice(0, 80));
    expect(script).toContain("def build():");
  });
});

describe("fused bodies and generated shapes", () => {
  const scene = (() => {
    const calls: [string, unknown][] = [
      ["add_object", {
        id: "bear", name: "Bear", position: [0, 0, 0], blend: 0.1,
        parts: [
          { name: "body", primitive: "sphere", position: [0, 1, 0], scale: [1, 1.4, 0.9], material: { color: "#4a3323", roughness: 0.9 } },
          { name: "head", primitive: "sphere", position: [0, 1.9, 0.2], scale: [0.6, 0.55, 0.6], material: { color: "#7a5a3c", roughness: 0.7 } },
        ],
      }],
      // Details hang off a fused part, so that part has to survive as an empty.
      ["add_object", { id: "nose", name: "Nose", parent: "bear__head", position: [0, 0, 0.3], primitive: "sphere", scale: [0.1, 0.1, 0.1] }],
      ["add_object", { id: "pine_a", name: "Pine", position: [3, 2, 0], primitive: "pine", scale: [2, 4, 2], material: { color: "#2f6b3a" } }],
      ["add_object", { id: "pine_b", name: "Pine", position: [-3, 2, 0], primitive: "pine", scale: [3, 6, 3], material: { color: "#2f6b3a" } }],
      ["add_object", { id: "boulder", name: "Boulder", position: [0, 0.4, 3], primitive: "rock", material: { color: "#7d8088" } }],
    ];
    let s = emptyScene();
    for (const [tool, input] of calls) s = runTool(s, tool, input).scene;
    return s;
  })();

  it("USD writes the fused surface with its colors and drops the parts it replaced", () => {
    const usda = toUsda(scene);
    expect(usda).toContain('def Mesh "bear_fused"');
    expect(usda).not.toContain('def Xform "bear__body"');
    // The head stays, without geometry, because the nose is parented to it.
    expect(usda).toMatch(/def Xform "bear__head" \([^)]*\)\s*\{[^}]*def Xform "nose"/);
    expect(usda).not.toContain('"bear__head_geo"');
    expect(usda).toContain('uniform token info:id = "UsdPrimvarReader_float3"');
    expect(usda).toMatch(/color3f inputs:diffuseColor\.connect = <\/World\/Materials\/mat_\d+\/colors\.outputs:result>/);
  });

  it("USD writes each generated shape and color once and refers to it", () => {
    const usda = toUsda(scene);
    expect(usda.match(/class Mesh "pine_\d+"/g)).toHaveLength(1);
    expect(usda.match(/prepend references = <\/World\/Prototypes\/pine_0>/g)).toHaveLength(2);
    expect(usda.match(/class Mesh "rock_\d+"/g)).toHaveLength(1);
    // The shape's shading is multiplied by the material color and written per point.
    const pine = usda.slice(usda.indexOf('class Mesh "pine_0"'));
    const points = pine.match(/point3f\[\] points = \[(.*)\]/)![1].split("), (").length;
    const colors = pine.match(/primvars:displayColor = \[(.*)\]/)![1].split("), (").length;
    expect(colors).toBe(points);
    expect(points).toBe(primitiveMesh("pine").points.length);
  });

  it("Blender data turns the blending group into one mesh with per-point colors", () => {
    const data = blenderData(scene, "Test");
    const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
    expect(Object.keys(byId)).toEqual(["bear", "bear__head", "nose", "pine_a", "pine_b", "boulder"]);

    const bear = byId.bear as BlenderNode & { meshData: { verts: number[][]; colors: number[][] } };
    expect(bear.kind).toBe("mesh");
    expect(bear.meshData.colors).toHaveLength(bear.meshData.verts.length);
    expect(bear.meshData.verts.length).toBeGreaterThan(500);
    expect(bear.material).toMatchObject({ vertexColors: true, color: [1, 1, 1], roughness: 0.8 });
    // Z is up in Blender: the bear stands about 2.2 m tall.
    const zs = bear.meshData.verts.map((v) => v[2]);
    expect(Math.max(...zs)).toBeGreaterThan(2.1);
    expect(Math.min(...zs)).toBeGreaterThan(0.2);

    expect(byId.bear__head.kind).toBe("group");
    expect(byId.pine_a).toMatchObject({ mesh: "pine", material: { vertexColors: true } });
    expect(data.meshes.pine.colors).toHaveLength(data.meshes.pine.verts.length);
    expect(byId.nose).toMatchObject({ mesh: "sphere", material: { vertexColors: false } });
  });

  it("the script wires mesh colors into the material", () => {
    const script = toBlenderScript(scene, "Test");
    expect(script).toContain('mesh.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="POINT")');
    expect(script).toContain('tree.nodes.new("ShaderNodeVertexColor")');
  });
});

describe("rigs, animation and arrays", () => {
  const scene = (() => {
    const grey = { color: "#808080" };
    const calls: [string, unknown][] = [
      ["add_object", {
        id: "crane", name: "Crane", position: [1, 0, 2], rotation: [0, 30, 0],
        parts: [{ name: "base", primitive: "box", position: [0, 0.25, 0], scale: [1, 0.5, 1], bevel: 0.05, material: { ...grey, wear: 0.4 } }],
      }],
      ["add_object", {
        id: "boom", name: "Boom", parent: "crane", position: [0, 0.5, 0], rotation: [0, 0, 20],
        parts: [
          { name: "beam", primitive: "box", position: [1, 0, 0], scale: [2, 0.1, 0.1], material: grey },
          { name: "rung", primitive: "cylinder", position: [0.2, 0.1, 0], scale: [0.03, 0.2, 0.03], material: grey, array: { count: 5, step: [0.4, 0, 0], turn: [10, 20, 30] } },
        ],
      }],
      ["add_object", { id: "crate", name: "Crate", position: [-3, 0.5, 0], primitive: "box" }],
      ["set_clip", { duration: 2, fps: 12, loop: false }],
      ["animate", {
        id: "boom",
        rotation: [{ t: 0, value: [0, 0, 20] }, { t: 2, value: [0, 90, 60], ease: "linear" }],
      }],
      ["animate", { id: "crane", position: [{ t: 0, value: [1, 0, 2] }, { t: 2, value: [1, 0, 4] }] }],
      ["set_camera", { position: [6, 3, 6], target: [0, 1, 0], fov: 50 }],
    ];
    let s = emptyScene();
    for (const [tool, input] of calls) s = runTool(s, tool, input).scene;
    return s;
  })();

  it("the camera's look-at rotation agrees with three.js", () => {
    for (const [from, to] of [[[6, 3, 6], [0, 1, 0]], [[-2, 0.5, 1], [3, 4, -5]], [[0, 9, 0], [0, 0, 0]], [[0, -4, 0], [0, 0, 0]]] as [Vec3, Vec3][]) {
      const camera = new THREE.PerspectiveCamera();
      camera.position.fromArray(from);
      camera.lookAt(...to);
      const q = lookAtQuat(from, to);
      // The view direction and the up vector are what matter; a quaternion and its negative are the
      // same turn. Looking straight up or down, three.js nudges the view by a hair, hence the tolerance.
      for (const axis of [[0, 0, -1], [0, 1, 0]] as Vec3[]) {
        const expected = new THREE.Vector3(...axis).applyQuaternion(camera.quaternion).toArray();
        rotate(q, axis).forEach((n, i) => expect(n).toBeCloseTo(expected[i], 3));
      }
    }
  });

  it("Blender data rigs the animated object and leaves the rest alone", () => {
    const data = blenderData(scene, "Test");
    expect(data.rigs).toEqual([{ root: "crane", name: "Crane rig", bones: ["crane", "boom"] }]);
    const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
    expect(byId.crane.bone).toBe(true);
    expect(byId.boom.bone).toBe(true);
    expect(byId.crate.bone).toBeUndefined();
    // Sizes are baked into the mesh; a rounded box gets a mesh for its size, with its own normals.
    expect(byId.crane__base).toMatchObject({ scale: [1, 1, 1], bake: { scale: [1, 1, 0.5] }, material: { wear: 0.4 } });
    const rounded = data.meshes[byId.crane__base.mesh!];
    expect(rounded.normals).toHaveLength(rounded.verts.length);
    expect(Object.keys(data.meshes).sort()).toEqual(["box", "box 1x0.5x1 r0.05", "cylinder"]);
  });

  it("Blender data samples the clip on every frame, in Blender's axes", () => {
    const { animation } = blenderData(scene, "Test");
    expect(animation).toMatchObject({ fps: 12, frames: 25, loop: false });
    const boom = animation!.tracks.boom;
    expect(Object.keys(boom)).toEqual(["rotation"]);
    expect(boom.rotation).toHaveLength(25);
    // Half way through, the linear key gives Euler (0, 45, 40) degrees.
    const [x, y, z, w] = eulerToQuat([0, 45, 40]);
    close(boom.rotation![12], [w, x, -z, y]);
    // The crane slides 2 m along the editor's +Z, which is Blender's -Y.
    expect(animation!.tracks.crane.location![0]).toEqual([1, -2, 0]);
    expect(animation!.tracks.crane.location![24]).toEqual([1, -4, 0]);
    expect(blenderData(emptyScene(), "Empty").animation).toBeNull();
  });

  it("array copies land where the viewport draws them, after the change of axes", () => {
    const data = blenderData(scene, "Test");
    const rung = data.nodes.find((n) => n.id === "boom__rung")!;
    expect(rung).toMatchObject({ location: [0, 0, 0], rotation: [1, 0, 0, 0], scale: [1, 1, 1] });
    expect(rung.array!.count).toBe(5);
    const node = scene.nodes.boom__rung;
    const toBlender = ([px, py, pz]: number[]) => [px, -pz, py];

    for (let index = 0; index < 5; index++) {
      // Where three.js puts a point of copy `index`, in the parent's space.
      const radians = (degrees: number) => (degrees * index * Math.PI) / 180;
      const turn = new THREE.Euler(radians(10), radians(20), radians(30), "XYZ");
      const expected = new THREE.Vector3(0.3, -0.2, 0.5)
        .applyEuler(turn)
        .add(new THREE.Vector3(0.4 * index, 0, 0));
      // What the script does: turn about Blender's Y, then Z, then X, then step.
      const [tx, tz, ty] = rung.array!.turn.map((angle) => angle * index);
      const got = new THREE.Vector3(...toBlender([0.3, -0.2, 0.5]))
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), ty)
        .applyAxisAngle(new THREE.Vector3(0, 0, 1), tz)
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), tx)
        .add(new THREE.Vector3(...rung.array!.step).multiplyScalar(index));
      close(got.toArray(), toBlender(expected.toArray()));
    }
    // The mesh itself is moved into the parent's space by the node's own transform.
    expect(rung.bake).toMatchObject({ location: [node.position[0], -node.position[2] + 0, node.position[1]] });
  });

  it("the script builds the rig, the modifiers, the materials and the compositor from that data", () => {
    const script = toBlenderScript(scene, "Test");
    for (const piece of [
      "def build_rigs(", "def bake_animation(", "def add_array(", "def add_wear(", "def unwrap(", "def make_grade(",
      'bpy.ops.uv.smart_project(', 'data.edit_bones.new(', 'pose.keyframe_insert(', '"GeometryNodeInstanceOnPoints"',
    ]) {
      expect(script).toContain(piece);
    }
  });

  it("USD writes time samples, a camera and one prim per array copy", () => {
    const usda = toUsda(scene);
    expect(usda).toContain("endTimeCode = 24");
    expect(usda).toContain("timeCodesPerSecond = 12");
    const boom = usda.slice(usda.indexOf('def Xform "boom"'));
    expect(boom).toMatch(/quatf xformOp:orient\.timeSamples = \{\s+0: \(/);
    expect(boom.match(/^\s+\d+: \(/gm)!.length).toBeGreaterThanOrEqual(25);
    expect(usda).toMatch(/double3 xformOp:translate\.timeSamples = \{\s+0: \(1, 0, 2\),/);
    expect(usda.match(/def Xform "boom__rung_copy\d"/g)).toHaveLength(4);
    expect(usda).toContain('def Camera "Camera"');
    // The rounded base is written as a mesh; plain boxes stay native cubes.
    expect(usda).toMatch(/def Mesh "crane__base_geo"/);
    expect(usda).toMatch(/def Cube "crate_geo"/);
    // A still scene has no time codes at all.
    expect(toUsda(emptyScene())).not.toContain("TimeCode");
  });
});
