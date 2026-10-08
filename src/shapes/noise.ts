/** Deterministic pseudo-random helpers, so generated shapes are identical on every run. */

function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth value noise, about −1..1. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const [xi, yi, zi] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [u, v, w] = [fade(x - xi), fade(y - yi), fade(z - zi)];
  const corner = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz, seed);
  const value = mix(
    mix(mix(corner(0, 0, 0), corner(1, 0, 0), u), mix(corner(0, 1, 0), corner(1, 1, 0), u), v),
    mix(mix(corner(0, 0, 1), corner(1, 0, 1), u), mix(corner(0, 1, 1), corner(1, 1, 1), u), v),
    w,
  );
  return value * 2 - 1;
}

/** Several octaves of noise layered together, about −1..1. */
export function fbm3(x: number, y: number, z: number, octaves: number, seed = 0): number {
  let sum = 0;
  let amplitude = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = 2 ** o;
    sum += amplitude * noise3(x * f, y * f, z * f, seed + o * 17);
    total += amplitude;
    amplitude /= 2;
  }
  return sum / total;
}

/** A seeded generator of numbers in 0..1 (mulberry32). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
