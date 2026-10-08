/**
 * Fusing parts into one surface.
 *
 * A group with `blend` above zero doesn't draw its primitive children one by
 * one. They become distance fields, are joined with a smooth union (which
 * rounds the seams by about `blend` meters), and the result is turned back
 * into a single mesh. That is how a body gets shoulders instead of a ball
 * stuck on a box.
 */

import { DEG, hexToRgb } from "@/scene/math";
import { childIds } from "@/scene/ops";
import type { GroupNode, MeshNode, Primitive, Scene, SceneNode, Vec3 } from "@/scene/types";
import type { MeshData } from "./mesh";

export interface BlendPart {
  primitive: Primitive;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: string;
}

/** Solid shapes with a distance field. Flat planes and generated shapes are drawn as they are. */
const BLENDABLE: ReadonlySet<Primitive> = new Set(["box", "sphere", "cylinder", "cone", "pyramid", "torus"]);

/** Cells along the longest side of a fused shape, on screen. */
export const VIEW_DETAIL = 88;
/** Exports use a coarser grid to keep files a sensible size. */
export const EXPORT_DETAIL = 60;
const MAX_GRID_POINTS = 2_400_000;

/** Whether `node` is fused into its parent's surface instead of being drawn itself. */
export function isFused(scene: Scene, node: SceneNode): boolean {
  if (node.kind !== "mesh" || node.parent === null || !node.visible) return false;
  // Rounded and tapered shapes and arrays are hard-surface work; they keep their own edges.
  if (node.bevel > 0 || node.array || node.taper[0] !== 1 || node.taper[1] !== 1) return false;
  const parent = scene.nodes[node.parent];
  return parent?.kind === "group" && parent.blend > 0 && BLENDABLE.has(node.primitive);
}

/** The parts a blending group fuses, in its own coordinates. */
export function fusedParts(scene: Scene, group: GroupNode): BlendPart[] {
  if (group.blend <= 0) return [];
  return childIds(scene, group.id)
    .map((id) => scene.nodes[id])
    .filter((node): node is MeshNode => isFused(scene, node))
    .map((node) => ({
      primitive: node.primitive,
      position: node.position,
      rotation: node.rotation,
      scale: node.scale,
      color: node.material.color,
    }));
}

/** How the fused surface of a group should shine: the average of its parts. */
export function fusedFinish(scene: Scene, group: GroupNode): { roughness: number; metalness: number } {
  const parts = childIds(scene, group.id)
    .map((id) => scene.nodes[id])
    .filter((node): node is MeshNode => isFused(scene, node));
  const mean = (pick: (node: MeshNode) => number) =>
    parts.reduce((sum, node) => sum + pick(node), 0) / (parts.length || 1);
  return { roughness: mean((n) => n.material.roughness), metalness: mean((n) => n.material.metalness) };
}

// ─── Distance fields ────────────────────────────────────────────────

interface Shape {
  primitive: Primitive;
  /** Rows of the rotation matrix; its transpose takes world offsets into the shape's frame. */
  rot: number[];
  center: Vec3;
  /** Half the size along each local axis. */
  half: Vec3;
  /** Radius of a sphere around `center` that contains the shape. */
  reach: number;
  color: Vec3;
}

function toShape(part: BlendPart): Shape {
  const [x, y, z] = part.rotation.map((d) => d * DEG);
  const [a, b] = [Math.cos(x), Math.sin(x)];
  const [c, d] = [Math.cos(y), Math.sin(y)];
  const [e, f] = [Math.cos(z), Math.sin(z)];
  const half = part.scale.map((s) => s / 2) as Vec3;
  return {
    primitive: part.primitive,
    // Euler XYZ, the same matrix three.js builds.
    rot: [c * e, -c * f, d, a * f + b * e * d, a * e - b * f * d, -b * c, b * f - a * e * d, b * e + a * f * d, a * c],
    center: part.position,
    half,
    reach: Math.hypot(...half),
    color: hexToRgb(part.color),
  };
}

/** Distance to an ellipse-like profile with radii `r`; exact when the radii are equal. */
function rounded(p: number[], r: number[]): number {
  let k0 = 0;
  let k1 = 0;
  for (let i = 0; i < p.length; i++) {
    k0 += (p[i] / r[i]) ** 2;
    k1 += (p[i] / (r[i] * r[i])) ** 2;
  }
  k0 = Math.sqrt(k0);
  if (k0 < 1e-9) return -Math.min(...r);
  return (k0 * (k0 - 1)) / Math.sqrt(k1);
}

/** Signed distance from a point to a shape: negative inside, zero on the surface. */
export function distanceTo(shape: Shape, px: number, py: number, pz: number): number {
  const { rot, center, half } = shape;
  const [dx, dy, dz] = [px - center[0], py - center[1], pz - center[2]];
  const x = rot[0] * dx + rot[3] * dy + rot[6] * dz;
  const y = rot[1] * dx + rot[4] * dy + rot[7] * dz;
  const z = rot[2] * dx + rot[5] * dy + rot[8] * dz;
  const [hx, hy, hz] = half;

  switch (shape.primitive) {
    case "sphere":
      return rounded([x, y, z], [hx, hy, hz]);
    case "box": {
      const [qx, qy, qz] = [Math.abs(x) - hx, Math.abs(y) - hy, Math.abs(z) - hz];
      return (
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0)
      );
    }
    case "cylinder": {
      const side = rounded([x, z], [hx, hz]);
      const cap = Math.abs(y) - hy;
      return Math.min(Math.max(side, cap), 0) + Math.hypot(Math.max(side, 0), Math.max(cap, 0));
    }
    case "cone": {
      // A capped cone with the base at −hy and the apex at +hy.
      const r = Math.min(hx, hz);
      const q = Math.hypot((x * r) / hx, (z * r) / hz);
      const [ax, ay] = [q - Math.min(q, y < 0 ? r : 0), Math.abs(y) - hy];
      const t = Math.min(1, Math.max(0, (q * r + (hy - y) * 2 * hy) / (r * r + 4 * hy * hy)));
      const [bx, by] = [q - r * t, y - hy + 2 * hy * t];
      const sign = bx < 0 && ay < 0 ? -1 : 1;
      return sign * Math.sqrt(Math.min(ax * ax + ay * ay, bx * bx + by * by));
    }
    case "pyramid": {
      const height = 2 * hy;
      const faceX = (height * Math.abs(x) + hx * (y - hy)) / Math.hypot(height, hx);
      const faceZ = (height * Math.abs(z) + hz * (y - hy)) / Math.hypot(height, hz);
      return Math.max(faceX, faceZ, -(y + hy));
    }
    case "torus": {
      // Measured on the unit ring, then scaled down to stay a safe underestimate.
      const [ux, uy, uz] = [x / (2 * hx), y / (2 * hy), z / (2 * hz)];
      return (Math.hypot(Math.hypot(ux, uz) - 0.375, uy) - 0.125) * 2 * Math.min(hx, hy, hz);
    }
    default:
      return Infinity;
  }
}

/** Union that rounds the join over a distance of about `k`. */
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ─── Surface extraction ─────────────────────────────────────────────

const CORNERS = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => [b & 1, (b >> 1) & 1, (b >> 2) & 1]);
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Builds the mesh of the fused surface of `parts`.
 * @param blend how far the joins are rounded, in meters
 * @param detail grid cells along the longest side; more is smoother and slower
 */
export function blendMesh(parts: BlendPart[], blend: number, detail = VIEW_DETAIL): MeshData {
  const empty: MeshData = { points: [], faces: [], smooth: true, colors: [] };
  if (parts.length === 0) return empty;
  const shapes = parts.map(toShape);

  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const shape of shapes) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], shape.center[a] - shape.reach);
      hi[a] = Math.max(hi[a], shape.center[a] + shape.reach);
    }
  }
  const longest = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let cell = Math.max(longest / detail, 0.004);
  let dims: number[] = [];
  let origin: Vec3 = lo;
  for (;;) {
    const pad = blend + 2 * cell;
    origin = [lo[0] - pad, lo[1] - pad, lo[2] - pad];
    dims = [0, 1, 2].map((a) => Math.ceil((hi[a] - lo[a] + 2 * pad) / cell) + 1);
    if ((dims[0] + 1) * (dims[1] + 1) * (dims[2] + 1) <= MAX_GRID_POINTS) break;
    cell *= 1.2;
  }
  const [nx, ny, nz] = dims;
  const [sx, sy] = [nx + 1, (nx + 1) * (ny + 1)];

  // Sample the field. Each shape only touches the grid points it can affect.
  const far = blend + 3 * cell;
  const field = new Float32Array(sx * (ny + 1) * (nz + 1)).fill(far);
  for (const shape of shapes) {
    const range = [0, 1, 2].map((a) => {
      const from = Math.floor((shape.center[a] - shape.reach - far - origin[a]) / cell);
      const to = Math.ceil((shape.center[a] + shape.reach + far - origin[a]) / cell);
      return [Math.max(0, from), Math.min(dims[a], to)];
    });
    for (let k = range[2][0]; k <= range[2][1]; k++) {
      for (let j = range[1][0]; j <= range[1][1]; j++) {
        for (let i = range[0][0]; i <= range[0][1]; i++) {
          const index = i + sx * j + sy * k;
          const d = distanceTo(shape, origin[0] + i * cell, origin[1] + j * cell, origin[2] + k * cell);
          field[index] = smoothMin(field[index], d, blend);
        }
      }
    }
  }

  // Surface nets: one vertex in every cell the surface passes through, placed
  // at the average of where it crosses the cell's edges.
  const points: Vec3[] = [];
  const vertexOf = new Int32Array(nx * ny * nz).fill(-1);
  const value = new Float32Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          value[c] = field[i + CORNERS[c][0] + sx * (j + CORNERS[c][1]) + sy * (k + CORNERS[c][2])];
          if (value[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let [px, py, pz, crossings] = [0, 0, 0, 0];
        for (const [a, b] of EDGES) {
          if (value[a] < 0 === value[b] < 0) continue;
          const t = value[a] / (value[a] - value[b]);
          px += CORNERS[a][0] + t * (CORNERS[b][0] - CORNERS[a][0]);
          py += CORNERS[a][1] + t * (CORNERS[b][1] - CORNERS[a][1]);
          pz += CORNERS[a][2] + t * (CORNERS[b][2] - CORNERS[a][2]);
          crossings++;
        }
        vertexOf[i + nx * (j + ny * k)] = points.length;
        points.push([
          origin[0] + (i + px / crossings) * cell,
          origin[1] + (j + py / crossings) * cell,
          origin[2] + (k + pz / crossings) * cell,
        ]);
      }
    }
  }

  // A quad for every grid edge the surface crosses, joining the four cells around it.
  const faces: number[][] = [];
  const cellAt = (i: number, j: number, k: number) => vertexOf[i + nx * (j + ny * k)];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    faces.push(flip ? [a, d, c, b] : [a, b, c, d]);
  };
  for (let k = 1; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const here = field[i + sx * j + sy * k] < 0;
        if (here !== field[i + 1 + sx * j + sy * k] < 0) {
          quad(cellAt(i, j - 1, k - 1), cellAt(i, j, k - 1), cellAt(i, j, k), cellAt(i, j - 1, k), !here);
        }
        if (here !== field[i + sx * (j + 1) + sy * k] < 0) {
          quad(cellAt(i - 1, j, k - 1), cellAt(i, j, k - 1), cellAt(i, j, k), cellAt(i - 1, j, k), here);
        }
        if (here !== field[i + sx * j + sy * (k + 1)] < 0) {
          quad(cellAt(i - 1, j - 1, k), cellAt(i, j - 1, k), cellAt(i, j, k), cellAt(i - 1, j, k), !here);
        }
      }
    }
  }

  // Each point takes the colors of the parts it is closest to, mixed where they meet.
  const softness = Math.max(blend * 0.35, cell * 0.5);
  const distances = new Float64Array(shapes.length);
  const colors = points.map(([x, y, z]): Vec3 => {
    let nearest = Infinity;
    shapes.forEach((shape, s) => {
      distances[s] = distanceTo(shape, x, y, z);
      if (distances[s] < nearest) nearest = distances[s];
    });
    let [r, g, b, total] = [0, 0, 0, 0];
    shapes.forEach((shape, s) => {
      const weight = Math.exp(-(distances[s] - nearest) / softness);
      r += weight * shape.color[0];
      g += weight * shape.color[1];
      b += weight * shape.color[2];
      total += weight;
    });
    return [r / total, g / total, b / total];
  });

  return { points, faces, smooth: true, colors };
}

const cache = new Map<string, MeshData>();
const CACHE_SIZE = 96;

/** The fused mesh of a blending group, in the group's own coordinates. Cached by content. */
export function fusedMesh(scene: Scene, group: GroupNode, detail = VIEW_DETAIL): MeshData {
  const parts = fusedParts(scene, group);
  const key = JSON.stringify([parts, group.blend, detail]);
  let mesh = cache.get(key);
  if (!mesh) {
    mesh = blendMesh(parts, group.blend, detail);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, mesh);
  }
  return mesh;
}
