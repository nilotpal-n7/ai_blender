/**
 * Polygon data for the unit primitives, for exporters that need explicit
 * meshes. Y up, faces wound counter-clockwise seen from outside. The basic
 * shapes match the viewport geometry in src/three/geometry.ts; the generated
 * ones are the very meshes the viewport draws.
 */

import type { Outline, Primitive, Taper, Vec3 } from "@/scene/types";
import { beveledBox, frustumMesh, taperMesh, wedgeMesh } from "@/shapes/hard";
import type { MeshData } from "@/shapes/mesh";
import { canopyMesh, pineMesh, rockMesh } from "@/shapes/natural";
import { isOutlined, outlineMesh } from "@/shapes/profile";

export type { MeshData };

const TAU = Math.PI * 2;
const SEGMENTS = 32;

/** `n` points around the Y axis, counter-clockwise seen from above. */
function ring(n: number, radius: number, y: number, offset = 0): Vec3[] {
  return Array.from({ length: n }, (_, i) => {
    const a = offset + (TAU * i) / n;
    return [radius * Math.cos(a), y, -radius * Math.sin(a)];
  });
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function box(): MeshData {
  const h = 0.5;
  return {
    points: [
      [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h],
      [-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h],
    ],
    faces: [
      [0, 1, 2, 3], [4, 7, 6, 5], [3, 2, 6, 7],
      [1, 0, 4, 5], [2, 1, 5, 6], [0, 3, 7, 4],
    ],
    smooth: false,
  };
}

function cylinder(n = SEGMENTS): MeshData {
  return {
    points: [...ring(n, 0.5, -0.5), ...ring(n, 0.5, 0.5)],
    faces: [
      ...range(n).map((i) => [i, (i + 1) % n, n + ((i + 1) % n), n + i]),
      range(n).map((i) => n + i),
      range(n).reverse(),
    ],
    smooth: true,
  };
}

function cone(n = SEGMENTS, radius = 0.5, offset = 0, smooth = true): MeshData {
  return {
    points: [...ring(n, radius, -0.5, offset), [0, 0.5, 0]],
    faces: [...range(n).map((i) => [i, (i + 1) % n, n]), range(n).reverse()],
    smooth,
  };
}

function sphere(n = SEGMENTS, rings = SEGMENTS / 2): MeshData {
  const points: Vec3[] = [[0, 0.5, 0]];
  for (let k = 1; k < rings; k++) {
    const phi = (Math.PI * k) / rings;
    points.push(...ring(n, 0.5 * Math.sin(phi), 0.5 * Math.cos(phi)));
  }
  points.push([0, -0.5, 0]);
  const at = (k: number, i: number) => 1 + (k - 1) * n + (i % n);
  const south = points.length - 1;

  const faces: number[][] = [];
  for (let i = 0; i < n; i++) faces.push([0, at(1, i), at(1, i + 1)]);
  for (let k = 1; k < rings - 1; k++) {
    for (let i = 0; i < n; i++) faces.push([at(k, i), at(k + 1, i), at(k + 1, i + 1), at(k, i + 1)]);
  }
  for (let i = 0; i < n; i++) faces.push([south, at(rings - 1, i + 1), at(rings - 1, i)]);
  return { points, faces, smooth: true };
}

function torus(around = SEGMENTS, tube = 12): MeshData {
  const R = 0.375;
  const r = 0.125;
  const points: Vec3[] = [];
  for (let i = 0; i < around; i++) {
    const theta = (TAU * i) / around;
    for (let j = 0; j < tube; j++) {
      const phi = (TAU * j) / tube;
      const d = R + r * Math.cos(phi);
      points.push([d * Math.cos(theta), r * Math.sin(phi), -d * Math.sin(theta)]);
    }
  }
  const at = (i: number, j: number) => (i % around) * tube + (j % tube);
  const faces: number[][] = [];
  for (let i = 0; i < around; i++) {
    for (let j = 0; j < tube; j++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  }
  return { points, faces, smooth: true };
}

function plane(): MeshData {
  const h = 0.5;
  return {
    points: [[-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h]],
    faces: [[0, 3, 2, 1]],
    smooth: false,
  };
}

const builders: Record<Primitive, () => MeshData> = {
  box,
  sphere,
  cylinder,
  cone,
  // A four-sided cone turned so its base is the unit square.
  pyramid: () => cone(4, Math.SQRT1_2, Math.PI / 4, false),
  torus,
  plane,
  wedge: wedgeMesh,
  lathe: () => outlineMesh("lathe", null),
  extrude: () => outlineMesh("extrude", null),
  pine: pineMesh,
  canopy: canopyMesh,
  rock: rockMesh,
};

/** Primitives whose mesh is generated here and drawn as-is, with shading baked into colors. */
export const GENERATED: ReadonlySet<Primitive> = new Set(["pine", "canopy", "rock"]);

const cache = new Map<Primitive, MeshData>();

export function primitiveMesh(primitive: Primitive): MeshData {
  let mesh = cache.get(primitive);
  if (!mesh) {
    mesh = builders[primitive]();
    cache.set(primitive, mesh);
  }
  return mesh;
}

/** Whether a mesh node is drawn with rounded edges, which makes its mesh depend on its size. */
export const isBeveled = (node: { primitive: Primitive; bevel: number }) =>
  node.primitive === "box" && node.bevel > 0;

/** What a mesh node's shape depends on. */
export interface Shaped {
  primitive: Primitive;
  scale: Vec3;
  bevel: number;
  taper: Taper;
  outline: Outline | null;
}

/** Whether a mesh node narrows toward its top. Only boxes and cylinders can. */
export const isTapered = (node: Pick<Shaped, "primitive" | "taper">) =>
  (node.primitive === "box" || node.primitive === "cylinder") && (node.taper[0] !== 1 || node.taper[1] !== 1);

/**
 * A name for a mesh node's shape when it has one of its own (rounded, tapered
 * or drawn from an outline), or null when it is just its primitive. Nodes with the same key
 * can share a mesh.
 */
export function shapeKey(node: Shaped): string | null {
  if (isOutlined(node.primitive)) {
    return node.outline ? `${node.primitive} ${node.outline.map((p) => p.join(",")).join(" ")}` : null;
  }
  const beveled = isBeveled(node);
  const tapered = isTapered(node);
  if (!beveled && !tapered) return null;
  return [
    node.primitive,
    ...(beveled ? [node.scale.join("x"), `r${node.bevel}`] : []),
    ...(tapered ? [`t${node.taper.join("x")}`] : []),
  ].join(" ");
}

const shaped = new Map<string, MeshData>();

/** The unit-space mesh of a mesh node: its primitive, or its own rounded or tapered shape. */
export function nodeMesh(node: Shaped): MeshData {
  const key = shapeKey(node);
  if (key === null) return primitiveMesh(node.primitive);
  let mesh = shaped.get(key);
  if (!mesh) {
    if (isOutlined(node.primitive)) mesh = outlineMesh(node.primitive, node.outline);
    else if (node.primitive === "cylinder") mesh = frustumMesh(node.taper);
    else {
      const box = isBeveled(node) ? beveledBox(node.scale, node.bevel) : primitiveMesh("box");
      mesh = isTapered(node) ? taperMesh(box, node.taper) : box;
    }
    if (shaped.size > 3000) shaped.clear();
    shaped.set(key, mesh);
  }
  return mesh;
}

/** Unnormalized normal of a polygon (Newell's method); its length is twice the area. */
export function faceNormal(points: readonly Vec3[], face: readonly number[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < face.length; i++) {
    const a = points[face[i]];
    const b = points[face[(i + 1) % face.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Per-vertex normals: the area-weighted average of the surrounding faces. */
export function vertexNormals(mesh: MeshData): Vec3[] {
  const normals: Vec3[] = mesh.points.map(() => [0, 0, 0]);
  for (const face of mesh.faces) {
    const n = faceNormal(mesh.points, face);
    for (const index of face) {
      normals[index][0] += n[0];
      normals[index][1] += n[1];
      normals[index][2] += n[2];
    }
  }
  return normals.map((n) => {
    const length = Math.hypot(...n) || 1;
    return [n[0] / length, n[1] / length, n[2] / length];
  });
}
