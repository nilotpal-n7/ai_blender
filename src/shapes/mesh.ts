import type { Vec3 } from "@/scene/types";

/**
 * A polygon mesh in plain data: what the viewport draws and what the exporters
 * write come from the same object, so they cannot drift apart.
 */
export interface MeshData {
  points: Vec3[];
  /** Vertex indices per face, counter-clockwise seen from outside. */
  faces: number[][];
  /** Curved surfaces are shaded smooth; boxes and pyramids stay faceted. */
  smooth: boolean;
  /**
   * Per-point color, sRGB 0..1, multiplied with the material color. Generated
   * shapes use it for shading variation; fused groups use it for the parts' colors.
   */
  colors?: Vec3[];
  /** Exact per-point normals, for shapes where averaging the faces isn't good enough. */
  normals?: Vec3[];
}

/** Rescales a mesh so its bounding box is exactly the unit cube centered on the origin. */
export function fitUnitBox(mesh: MeshData): MeshData {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.points) {
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }
  const fit = (v: number, a: number) => (v - (min[a] + max[a]) / 2) / (max[a] - min[a] || 1);
  return { ...mesh, points: mesh.points.map((p) => [fit(p[0], 0), fit(p[1], 1), fit(p[2], 2)]) };
}

/** A sphere of radius 1 made of near-equal triangles; `detail` 3 gives 642 points, 4 gives 2562. */
export function icosphere(detail: number): { points: Vec3[]; faces: number[][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const points: Vec3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const onSphere = (p: Vec3): Vec3 => {
    const length = Math.hypot(...p);
    return [p[0] / length, p[1] / length, p[2] / length];
  };
  points.forEach((p, i) => (points[i] = onSphere(p)));

  for (let level = 0; level < detail; level++) {
    const midpoints = new Map<number, number>();
    const midpoint = (a: number, b: number) => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      let index = midpoints.get(key);
      if (index === undefined) {
        const [pa, pb] = [points[a], points[b]];
        index = points.push(onSphere([pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]])) - 1;
        midpoints.set(key, index);
      }
      return index;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const [ab, bc, ca] = [midpoint(a, b), midpoint(b, c), midpoint(c, a)];
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  return { points, faces };
}
