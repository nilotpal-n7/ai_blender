/**
 * Generated natural shapes: rock, leafy canopy, pine foliage.
 *
 * Each fits the unit cube like every other primitive, so a node's scale is its
 * size. Their colors are shading variation (crevices darker, tips lighter)
 * that gets multiplied with the material color.
 */

import type { Vec3 } from "@/scene/types";
import { fitUnitBox, icosphere, type MeshData } from "./mesh";
import { fbm3, noise3, random } from "./noise";

const gray = (v: number): Vec3 => [v, v, v];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A weathered boulder: a sphere pushed around by layered noise, flatter underneath. */
export function rockMesh(): MeshData {
  const { points, faces } = icosphere(4);
  const colors: Vec3[] = [];
  const shaped = points.map(([x, y, z]): Vec3 => {
    const broad = fbm3(x * 1.3 + 7, y * 1.3, z * 1.3, 3, 11);
    // Ridged noise reads as cracks and chipped edges.
    const ridged = 1 - Math.abs(fbm3(x * 3.1, y * 3.1 + 3, z * 3.1, 3, 23));
    const grain = noise3(x * 11, y * 11, z * 11, 5);
    const r = 1 + 0.26 * broad + 0.1 * (ridged - 0.6) + 0.015 * grain;
    colors.push(gray(clamp(0.78 + 0.5 * (r - 1) + 0.06 * grain, 0.5, 1.08)));
    // Rocks sit on the ground: squash the underside.
    return [x * r, (y < 0 ? y * 0.72 : y) * r, z * r];
  });
  return fitUnitBox({ points: shaped, faces, smooth: true, colors });
}

/** The crown of a broadleaf tree or a bush: billowing clumps, lighter where the sun reaches. */
export function canopyMesh(): MeshData {
  const { points, faces } = icosphere(4);
  const colors: Vec3[] = [];
  const shaped = points.map(([x, y, z]): Vec3 => {
    // Folding the noise makes rounded lobes with creases between them.
    const lobes = Math.abs(fbm3(x * 1.9 + 2, y * 1.9, z * 1.9 + 5, 3, 41));
    const leaves = Math.abs(noise3(x * 9, y * 9, z * 9, 3));
    const r = 0.78 + 0.34 * lobes + 0.05 * leaves;
    const sunlit = 0.08 * (y + 1);
    colors.push(gray(clamp(0.52 + 1.25 * lobes + 0.12 * leaves + sunlit, 0.4, 1.12)));
    return [x * r, y * r * 0.9, z * r];
  });
  return fitUnitBox({ points: shaped, faces, smooth: true, colors });
}

/** One bough: a flattened, tapering spray of needles from `base`, reaching `length` along `yaw`. */
function bough(
  out: { points: Vec3[]; faces: number[][]; colors: Vec3[] },
  base: Vec3,
  yaw: number,
  length: number,
  droop: number,
  shade: number,
) {
  const around = 6;
  const along = 5;
  const start = out.points.length;
  const [cosY, sinY] = [Math.cos(yaw), Math.sin(yaw)];
  for (let i = 0; i <= along; i++) {
    const s = i / along;
    // Widest a third of the way out, pointed at both ends.
    const girth = Math.sin(Math.PI * s ** 0.7) ** 0.8;
    const width = 0.2 * length * girth;
    const height = 0.07 * length * girth;
    const reach = s * length;
    // Boughs sag under their own weight, then lift slightly at the tip.
    const sag = -droop * length * (s * s - 0.25 * s ** 4);
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around;
      const [side, up] = [Math.cos(a) * width, Math.sin(a) * height];
      out.points.push([
        base[0] + cosY * reach - sinY * side,
        base[1] + sag + up,
        base[2] - sinY * reach - cosY * side,
      ]);
      // Undersides and the shaded interior are darker than the tips.
      const underside = Math.sin(a) < 0 ? 0.8 : 1;
      out.colors.push(gray(clamp(shade * underside * (0.62 + 0.5 * s), 0.3, 1.15)));
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      const a = start + i * around + j;
      const b = start + i * around + ((j + 1) % around);
      out.faces.push([a, b, b + around, a + around]);
    }
  }
}

/** The needles of a conifer: whorls of drooping boughs, wide at the bottom, tapering to a tip. */
export function pineMesh(): MeshData {
  const out = { points: [] as Vec3[], faces: [] as number[][], colors: [] as Vec3[] };
  const next = random(20261006);
  const tiers = 13;
  for (let tier = 0; tier < tiers; tier++) {
    const t = tier / (tiers - 1);
    const y = -0.44 + 0.86 * t;
    const reach = 0.5 * (1 - t) ** 0.8 + 0.035;
    const count = Math.round(10 - 5 * t);
    const twist = next() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const yaw = twist + (2 * Math.PI * k) / count + (next() - 0.5) * 0.35;
      const length = reach * (0.82 + 0.3 * next());
      const droop = 0.42 - 0.3 * t + 0.08 * next();
      const shade = 0.85 + 0.25 * next();
      const base: Vec3 = [0, y + (next() - 0.5) * 0.02, 0];
      bough(out, base, yaw, length, droop, shade);
      // Lower boughs fork into side sprays, which fills out the silhouette.
      if (t < 0.7) {
        for (const turn of [-0.6, 0.6]) {
          const from = 0.45 * length;
          const fork: Vec3 = [
            base[0] + Math.cos(yaw) * from,
            base[1] - droop * length * 0.2,
            base[2] - Math.sin(yaw) * from,
          ];
          bough(out, fork, yaw + turn, length * 0.5, droop, shade * 0.95);
        }
      }
    }
  }
  // The leader: a short upright tip.
  const top = out.points.length;
  const sides = 7;
  for (let j = 0; j < sides; j++) {
    const a = (2 * Math.PI * j) / sides;
    out.points.push([0.035 * Math.cos(a), 0.4, -0.035 * Math.sin(a)]);
    out.colors.push(gray(0.85));
  }
  out.points.push([0, 0.5, 0]);
  out.colors.push(gray(1.1));
  for (let j = 0; j < sides; j++) out.faces.push([top + j, top + ((j + 1) % sides), top + sides]);

  return fitUnitBox({ ...out, smooth: true });
}
