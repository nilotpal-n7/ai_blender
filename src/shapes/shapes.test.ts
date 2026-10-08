import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { faceNormal, nodeMesh, primitiveMesh, shapeKey } from "@/export/meshdata";
import { runTool } from "@/planner/tools";
import { emptyScene, type GroupNode, type Primitive, type Vec3 } from "@/scene/types";
import { blendMesh, fusedMesh, fusedParts, isFused, type BlendPart } from "./blend";
import { beveledBox, frustumMesh, roundedBoxMesh, taperMesh, wedgeMesh } from "./hard";
import { icosphere, type MeshData } from "./mesh";
import { canopyMesh, pineMesh, rockMesh } from "./natural";

const part = (primitive: Primitive, overrides: Partial<BlendPart> = {}): BlendPart => ({
  primitive,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  color: "#808080",
  ...overrides,
});

function bounds(mesh: MeshData) {
  const box = new THREE.Box3().setFromPoints(mesh.points.map((p) => new THREE.Vector3(...p)));
  return { min: box.min.toArray(), max: box.max.toArray(), size: box.getSize(new THREE.Vector3()).toArray() };
}

/** Every edge of a closed, consistently wound mesh is used once in each direction. */
function expectWatertight(mesh: MeshData) {
  const edges = new Map<string, number>();
  for (const face of mesh.faces) {
    face.forEach((a, i) => {
      const key = a + ">" + face[(i + 1) % face.length];
      edges.set(key, (edges.get(key) ?? 0) + 1);
    });
  }
  let open = 0;
  for (const [key, count] of edges) {
    if (count !== 1 || edges.get(key.split(">").reverse().join(">")) !== 1) open++;
  }
  expect(open).toBe(0);
}

/** Signed volume by the divergence theorem: positive when faces wind outward. */
function volume(mesh: MeshData): number {
  let total = 0;
  for (const face of mesh.faces) {
    const n = faceNormal(mesh.points, face);
    const p = mesh.points[face[0]];
    total += (p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) / 6;
  }
  return total;
}

describe("blendMesh", () => {
  it("reproduces a single shape at its true size, closed and wound outward", () => {
    const shapes: [Primitive, Vec3, number][] = [
      ["sphere", [1, 1, 1], (4 / 3) * Math.PI * 0.125],
      ["sphere", [2, 0.6, 1], (4 / 3) * Math.PI * 1 * 0.3 * 0.5],
      ["box", [1, 2, 0.5], 1],
      ["cylinder", [1, 2, 1], Math.PI * 0.25 * 2],
      ["cone", [1, 2, 1], (Math.PI * 0.25 * 2) / 3],
      ["pyramid", [1, 1.5, 2], (1 * 2 * 1.5) / 3],
      ["torus", [2, 2, 2], 2 * Math.PI ** 2 * 0.75 * 0.25 ** 2],
    ];
    for (const [primitive, scale, expected] of shapes) {
      const mesh = blendMesh([part(primitive, { scale })], 0, 72);
      expectWatertight(mesh);
      const { size } = bounds(mesh);
      const height = primitive === "torus" ? 0.25 * scale[1] : scale[1];
      // Within a grid cell of the true extent.
      expect(Math.abs(size[0] - scale[0])).toBeLessThan(0.08);
      expect(Math.abs(size[1] - height)).toBeLessThan(0.08);
      expect(Math.abs(size[2] - scale[2])).toBeLessThan(0.08);
      expect(volume(mesh) / expected).toBeGreaterThan(0.9);
      expect(volume(mesh) / expected).toBeLessThan(1.06);
    }
  });

  it("places and turns shapes exactly as the viewport does", () => {
    // A long box, rotated and moved; three.js is the reference.
    const rotation: Vec3 = [20, 40, 65];
    const position: Vec3 = [1, 2, -0.5];
    const mesh = blendMesh([part("box", { scale: [2, 0.4, 0.4], rotation, position })], 0, 96);
    const [rx, ry, rz] = rotation.map((d) => (d * Math.PI) / 180);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "XYZ")),
      new THREE.Vector3(1, 1, 1),
    );
    const expected = new THREE.Box3()
      .setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(2, 0.4, 0.4))
      .applyMatrix4(matrix);
    const got = bounds(mesh);
    expected.min.toArray().forEach((v, i) => expect(Math.abs(got.min[i] - v)).toBeLessThan(0.05));
    expected.max.toArray().forEach((v, i) => expect(Math.abs(got.max[i] - v)).toBeLessThan(0.05));
  });

  it("fuses overlapping parts into one surface and fills the join when blending", () => {
    const two = [
      part("sphere", { position: [-0.35, 0, 0], color: "#ff0000" }),
      part("sphere", { position: [0.35, 0, 0], color: "#0000ff" }),
    ];
    const hard = blendMesh(two, 0, 80);
    const soft = blendMesh(two, 0.3, 80);
    expectWatertight(hard);
    expectWatertight(soft);
    // Blending only ever adds material, and it adds it around the seam.
    expect(volume(soft)).toBeGreaterThan(volume(hard) * 1.03);
    const waist = (mesh: MeshData) =>
      Math.max(...mesh.points.filter((p) => Math.abs(p[0]) < 0.03).map((p) => Math.hypot(p[1], p[2])));
    expect(waist(soft)).toBeGreaterThan(waist(hard) + 0.03);

    // Colors follow the nearest part and mix across the join.
    const colorAt = (x: number) => {
      const i = soft.points.reduce((best, p, j) => (Math.abs(p[0] - x) < Math.abs(soft.points[best][0] - x) ? j : best), 0);
      return soft.colors![i];
    };
    expect(colorAt(-0.85)[0]).toBeGreaterThan(0.95);
    expect(colorAt(0.85)[2]).toBeGreaterThan(0.95);
    const middle = colorAt(0);
    expect(middle[0]).toBeGreaterThan(0.3);
    expect(middle[2]).toBeGreaterThan(0.3);
  });

  it("returns an empty mesh for no parts", () => {
    expect(blendMesh([], 0.1).points).toEqual([]);
  });
});

describe("fused groups in a scene", () => {
  const scene = (() => {
    let s = runTool(emptyScene(), "add_object", {
      id: "bear",
      name: "Bear",
      position: [0, 0, 0],
      blend: 0.1,
      parts: [
        { name: "body", primitive: "sphere", position: [0, 1, 0], scale: [1, 1.4, 0.9], material: { color: "#4a3323" } },
        { name: "head", primitive: "sphere", position: [0, 1.9, 0.2], scale: [0.6, 0.55, 0.6], material: { color: "#4a3323" } },
        { name: "mat", primitive: "plane", position: [0, 0.01, 0], scale: [2, 1, 2], material: { color: "#333333" } },
        { name: "crown", primitive: "rock", position: [0, 2.3, 0.2], scale: [0.2, 0.2, 0.2], material: { color: "#999999" } },
      ],
    }).scene;
    s = runTool(s, "add_object", {
      id: "bear_face", name: "Face", parent: "bear", position: [0, 0, 0],
      parts: [{ name: "nose", primitive: "sphere", position: [0, 1.9, 0.5], scale: [0.1, 0.1, 0.1], material: { color: "#111111" } }],
    }).scene;
    return s;
  })();
  const bear = scene.nodes.bear as GroupNode;

  it("fuses only the solid primitives directly inside the blending group", () => {
    expect(bear.blend).toBe(0.1);
    expect(fusedParts(scene, bear).map((p) => p.primitive)).toEqual(["sphere", "sphere"]);
    expect(isFused(scene, scene.nodes.bear__body)).toBe(true);
    // Flat and generated shapes, and anything in a nested group, are drawn as they are.
    expect(isFused(scene, scene.nodes.bear__mat)).toBe(false);
    expect(isFused(scene, scene.nodes.bear__crown)).toBe(false);
    expect(isFused(scene, scene.nodes.bear_face__nose)).toBe(false);
  });

  it("stops fusing hidden parts and when blending is turned off", () => {
    const hidden = runTool(scene, "update_object", { id: "bear__head", visible: false }).scene;
    expect(fusedParts(hidden, hidden.nodes.bear as GroupNode)).toHaveLength(1);
    const off = runTool(scene, "update_object", { id: "bear", blend: 0 }).scene;
    expect(isFused(off, off.nodes.bear__body)).toBe(false);
    expect(() => runTool(scene, "update_object", { id: "bear__body", blend: 0.1 })).toThrow(/only groups can blend/);
  });

  it("builds one closed mesh and reuses it while nothing changes", () => {
    const mesh = fusedMesh(scene, bear, 48);
    expectWatertight(mesh);
    expect(mesh.colors).toHaveLength(mesh.points.length);
    expect(bounds(mesh).max[1]).toBeGreaterThan(2.1);
    expect(fusedMesh(scene, bear, 48)).toBe(mesh);
  });
});

describe("generated shapes", () => {
  const shapes = { rock: rockMesh, canopy: canopyMesh, pine: pineMesh };

  for (const [name, build] of Object.entries(shapes)) {
    it(name + " fits the unit cube, is detailed, and is the same every time", () => {
      const mesh = build();
      const { min, max } = bounds(mesh);
      min.forEach((v) => expect(v).toBeCloseTo(-0.5, 6));
      max.forEach((v) => expect(v).toBeCloseTo(0.5, 6));
      expect(mesh.points.length).toBeGreaterThan(2000);
      expect(mesh.colors).toHaveLength(mesh.points.length);
      for (const face of mesh.faces) for (const i of face) expect(i).toBeLessThan(mesh.points.length);
      expect(build()).toEqual(mesh);
      // The shared mesh module hands out this exact shape.
      expect(primitiveMesh(name as Primitive).points).toEqual(mesh.points);
    });
  }

  it("rock and canopy are closed surfaces wound outward", () => {
    for (const mesh of [rockMesh(), canopyMesh()]) {
      expectWatertight(mesh);
      expect(volume(mesh)).toBeGreaterThan(0.2);
    }
  });

  it("a pine is wide at the bottom and comes to a point", () => {
    const mesh = pineMesh();
    const radiusNear = (y: number) =>
      Math.max(...mesh.points.filter((p) => Math.abs(p[1] - y) < 0.06).map((p) => Math.hypot(p[0], p[2])));
    expect(radiusNear(-0.4)).toBeGreaterThan(0.4);
    expect(radiusNear(0.1)).toBeLessThan(radiusNear(-0.4));
    expect(radiusNear(0.47)).toBeLessThan(0.08);
    // Boughs wind outward: the whole shape has positive volume.
    expect(volume(mesh)).toBeGreaterThan(0);
  });

  it("icosphere points lie on the unit sphere and faces wind outward", () => {
    const { points, faces } = icosphere(2);
    expect(points).toHaveLength(162);
    for (const p of points) expect(Math.hypot(...p)).toBeCloseTo(1, 9);
    expect(volume({ points, faces, smooth: true })).toBeCloseTo((4 / 3) * Math.PI, 0);
  });
});

describe("hard-surface shapes", () => {
  it("a rounded box fills its size exactly and is closed", () => {
    for (const [size, radius] of [[[1, 1, 1], 0.1], [[0.3, 2, 0.05], 0.02], [[1, 1, 1], 5]] as [Vec3, number][]) {
      const mesh = roundedBoxMesh(size, radius);
      const { min, max } = bounds(mesh);
      min.forEach((v) => expect(v).toBeCloseTo(-0.5, 9));
      max.forEach((v) => expect(v).toBeCloseTo(0.5, 9));
      expectWatertight(mesh);
      expect(volume(mesh)).toBeGreaterThan(0.4);
      expect(volume(mesh)).toBeLessThanOrEqual(1);
    }
  });

  it("rounded box normals are perpendicular to the real, stretched surface", () => {
    const size: Vec3 = [0.4, 1.6, 0.9];
    const mesh = roundedBoxMesh(size, 0.08);
    // Undo the unit-space correction to get each point's true normal.
    const truth = mesh.normals!.map((n) => {
      const real = n.map((v, a) => v / size[a]);
      const length = Math.hypot(...real);
      return real.map((v) => v / length);
    });
    mesh.points.forEach((p, i) => {
      const real = p.map((v, a) => v * size[a]);
      const core = real.map((v, a) => Math.min(Math.max(v, -(size[a] / 2 - 0.08)), size[a] / 2 - 0.08));
      const out = real.map((v, a) => v - core[a]);
      // Every surface point is exactly one radius from the inner box, along its normal.
      expect(Math.hypot(...out)).toBeCloseTo(0.08, 6);
      out.forEach((v, a) => expect(v / 0.08).toBeCloseTo(truth[i][a], 5));
    });
  });

  it("reuses the mesh for boxes of the same size", () => {
    expect(beveledBox([1, 2, 3], 0.1)).toBe(beveledBox([1, 2, 3], 0.1));
    expect(beveledBox([1, 2, 3], 0.1)).not.toBe(beveledBox([1, 2, 3], 0.2));
  });

  it("the wedge is half a cube", () => {
    const mesh = wedgeMesh();
    expectWatertight(mesh);
    expect(volume(mesh)).toBeCloseTo(0.5, 9);
    // Tall at the back, nothing at the front.
    expect(Math.max(...mesh.points.filter((p) => p[2] > 0).map((p) => p[1]))).toBe(-0.5);
  });

  it("rounded boxes and arrays keep their own edges inside a blending group", () => {
    let scene = runTool(emptyScene(), "add_object", {
      id: "blob", name: "Blob", position: [0, 0, 0], blend: 0.1,
      parts: [
        { name: "soft", primitive: "sphere", position: [0, 0.5, 0], scale: [1, 1, 1], material: { color: "#888888" } },
        { name: "plate", primitive: "box", position: [0, 1, 0], scale: [0.5, 0.1, 0.5], bevel: 0.02, material: { color: "#888888" } },
        { name: "stud", primitive: "sphere", position: [0.3, 1, 0], scale: [0.1, 0.1, 0.1], array: { count: 3, turn: [0, 120, 0] }, material: { color: "#888888" } },
      ],
    }).scene;
    expect(isFused(scene, scene.nodes.blob__soft)).toBe(true);
    expect(isFused(scene, scene.nodes.blob__plate)).toBe(false);
    expect(isFused(scene, scene.nodes.blob__stud)).toBe(false);
    expect(fusedParts(scene, scene.nodes.blob as GroupNode)).toHaveLength(1);
    scene = runTool(scene, "update_object", { id: "blob__plate", bevel: 0 }).scene;
    expect(isFused(scene, scene.nodes.blob__plate)).toBe(true);
  });
});

describe("tapered shapes", () => {
  it("narrows a box toward its top and leaves the bottom alone", () => {
    const mesh = nodeMesh({ primitive: "box", scale: [1, 1, 1], bevel: 0, taper: [0.5, 0.25] });
    const top = mesh.points.filter((p) => p[1] > 0);
    const bottom = mesh.points.filter((p) => p[1] < 0);
    expect(Math.max(...top.map((p) => p[0]))).toBeCloseTo(0.25, 9);
    expect(Math.max(...top.map((p) => p[2]))).toBeCloseTo(0.125, 9);
    expect(Math.max(...bottom.map((p) => p[0]))).toBeCloseTo(0.5, 9);
    expectWatertight(mesh);
    // A frustum of a 1 x 1 base and a 0.5 x 0.25 top.
    expect(volume(mesh)).toBeCloseTo((1 + 0.125 + (0.25 + 0.5) / 2) / 3, 6);
  });

  it("keeps a rounded box's normals perpendicular to its tapered surface", () => {
    const size: Vec3 = [0.6, 1, 0.6];
    const straight = roundedBoxMesh(size, 0.02);
    const mesh = taperMesh(straight, [0.5, 1]);
    // A point on the flat of the +X side. Tapered, that side leans inward, so its normal tips upward.
    const side = straight.normals!.findIndex((n) => n[0] > 0.999999);
    const real = mesh.normals![side].map((n, a) => n / size[a]);
    const length = Math.hypot(...real);
    // The side runs from x = 0.3 at the bottom to 0.15 at the top over a height of 1.
    const slope = 0.15;
    expect(real[0] / length).toBeCloseTo(1 / Math.hypot(1, slope), 3);
    expect(real[1] / length).toBeCloseTo(slope / Math.hypot(1, slope), 3);
    for (const n of mesh.normals!) expect(Math.hypot(...n)).toBeCloseTo(1, 6);
  });

  it("a tapered cylinder is a frustum with a crisp rim", () => {
    const mesh = frustumMesh([0.5, 0.5]);
    const radiusAt = (y: number) => Math.max(...mesh.points.filter((p) => p[1] === y).map((p) => Math.hypot(p[0], p[2])));
    expect(radiusAt(-0.5)).toBeCloseTo(0.5, 9);
    expect(radiusAt(0.5)).toBeCloseTo(0.25, 9);
    expect(volume(mesh)).toBeCloseTo((Math.PI * (0.25 + 0.0625 + 0.125)) / 3, 2);
    // The rim has a side point leaning outward and a cap point facing straight up at the same place.
    const rim = mesh.points.map((p, i) => ({ p, n: mesh.normals![i] })).filter(({ p }) => p[1] === 0.5 && Math.abs(p[2]) < 1e-9 && p[0] > 0);
    expect(rim).toHaveLength(2);
    expect(rim.map(({ n }) => n[1]).sort()).toEqual([expect.closeTo(0.2425, 3), 1]);
  });

  it("gives every distinct shape its own key, and plain primitives none", () => {
    const plain = { primitive: "box" as const, scale: [1, 2, 3] as Vec3, bevel: 0, taper: [1, 1] as [number, number] };
    expect(shapeKey(plain)).toBeNull();
    expect(nodeMesh(plain)).toBe(primitiveMesh("box"));
    expect(shapeKey({ ...plain, taper: [0.5, 1] })).toBe("box t0.5x1");
    expect(shapeKey({ ...plain, bevel: 0.01, taper: [0.5, 1] })).toBe("box 1x2x3 r0.01 t0.5x1");
    expect(shapeKey({ ...plain, primitive: "cylinder", taper: [0.5, 0.5] })).toBe("cylinder t0.5x0.5");
    // Only boxes and cylinders taper; a sphere ignores it.
    expect(shapeKey({ ...plain, primitive: "sphere", taper: [0.5, 0.5] })).toBeNull();
    expect(nodeMesh({ ...plain, taper: [0.5, 1] })).toBe(nodeMesh({ ...plain, scale: [9, 9, 9], taper: [0.5, 1] }));
  });
});
