/**
 * Hard-surface shapes: the wedge, and boxes with rounded edges.
 *
 * A rounded box depends on its real size (the rounding is a radius in meters),
 * so unlike the other primitives it is built per size. It is still returned in
 * unit space, where a node's scale stretches it back to its true dimensions.
 */

import type { Vec3 } from "@/scene/types";
import type { MeshData } from "./mesh";

/** A ramp filling the unit cube: full height at the back (−Z), nothing at the front (+Z). */
export function wedgeMesh(): MeshData {
  const h = 0.5;
  return {
    points: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [-h, h, -h], [h, h, -h]],
    faces: [[0, 1, 2, 3], [1, 0, 4, 5], [3, 2, 5, 4], [0, 3, 4], [2, 1, 5]],
    smooth: false,
  };
}

/** Steps across each rounded edge. Three already reads as round at arm's length. */
const ARC_STEPS = 3;

/**
 * A box of `size` meters with edges and corners rounded by `radius` meters.
 * Points and normals are in unit space (divided by, and corrected for, `size`).
 */
export function roundedBoxMesh(size: Vec3, radius: number): MeshData {
  const half = size.map((s) => s / 2) as Vec3;
  const r = Math.min(radius, Math.min(...half) * 0.98);
  // Along each axis: a few steps across the rounded edge, the flat middle, and back.
  const stops = half.map((h) => {
    const rising = Array.from({ length: ARC_STEPS + 1 }, (_, i) => -h + (r * i) / ARC_STEPS);
    return [...rising, ...rising.map((v) => -v).reverse()];
  });
  const n = stops[0].length;

  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const indexOf = new Map<number, number>();
  /** The surface point for lattice position (i, j, k), created on first use. */
  const vertex = (i: number, j: number, k: number) => {
    const key = (i * n + j) * n + k;
    let index = indexOf.get(key);
    if (index === undefined) {
      const p = [stops[0][i], stops[1][j], stops[2][k]];
      // Pull the point onto a box shrunk by r, then push it back out r along that offset.
      const core = p.map((v, a) => Math.min(Math.max(v, -(half[a] - r)), half[a] - r));
      const out = p.map((v, a) => v - core[a]);
      const length = Math.hypot(...out) || 1;
      const normal = out.map((v) => v / length);
      // In unit space a normal has to be stretched by the size to stay perpendicular.
      const stretched = normal.map((v, a) => v * size[a]);
      const scale = Math.hypot(...stretched) || 1;
      index = points.push(core.map((v, a) => (v + normal[a] * r) / size[a]) as Vec3) - 1;
      normals.push(stretched.map((v) => v / scale) as Vec3);
      indexOf.set(key, index);
    }
    return index;
  };

  const faces: number[][] = [];
  const last = n - 1;
  for (let a = 0; a < last; a++) {
    for (let b = 0; b < last; b++) {
      // One quad on each of the six sides, wound counter-clockwise seen from outside.
      faces.push(
        [vertex(last, a, b), vertex(last, a + 1, b), vertex(last, a + 1, b + 1), vertex(last, a, b + 1)],
        [vertex(0, a, b), vertex(0, a, b + 1), vertex(0, a + 1, b + 1), vertex(0, a + 1, b)],
        [vertex(a, last, b), vertex(a, last, b + 1), vertex(a + 1, last, b + 1), vertex(a + 1, last, b)],
        [vertex(a, 0, b), vertex(a + 1, 0, b), vertex(a + 1, 0, b + 1), vertex(a, 0, b + 1)],
        [vertex(a, b, last), vertex(a + 1, b, last), vertex(a + 1, b + 1, last), vertex(a, b + 1, last)],
        [vertex(a, b, 0), vertex(a, b + 1, 0), vertex(a + 1, b + 1, 0), vertex(a + 1, b, 0)],
      );
    }
  }
  return { points, faces, smooth: true, normals };
}

const cache = new Map<string, MeshData>();

/** A rounded box, reused for every box of the same size and radius. */
export function beveledBox(size: Vec3, radius: number): MeshData {
  const key = `${size.join(",")}|${radius}`;
  let mesh = cache.get(key);
  if (!mesh) {
    mesh = roundedBoxMesh(size, radius);
    if (cache.size > 2000) cache.clear();
    cache.set(key, mesh);
  }
  return mesh;
}
