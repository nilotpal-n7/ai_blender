/**
 * The numbers behind worn and rusty finishes (`material.wear`, `material.rust`),
 * shared by the viewport's shader and the Blender material so the two agree on
 * scale and color.
 */

/**
 * On a part about 40 cm across, chips are around ten centimeters: this many
 * noise cells per meter. Smaller and larger parts scale it with `wearFit`.
 */
export const WEAR_SCALE = 4.6;
/** Frequency of the fine noise that roughens the chips' edges. */
export const WEAR_EDGE_SCALE = 23;
/** Frequency of the slow fade and grime across a surface. */
export const WEAR_GRIME_SCALE = 1.7;
/** Paint goes first within this many meters of an edge (on a part about 40 cm across). */
export const WEAR_EDGE_REACH = 0.04;
/** The part size the numbers above were set for, and how far the pattern may scale either way. */
export const WEAR_FIT = { size: 0.4, min: 0.65, max: 12 } as const;

/**
 * How much finer (above 1) or coarser (below 1) the wear pattern is on a part
 * of this size, so a bolt gets millimeter chips and a wall gets broad ones,
 * instead of every object wearing like a half-meter machine part. The size
 * that counts is the middle one of the three: a long thin rod wears like its
 * thickness, a big thin sheet like its width.
 */
export function wearFit(size: readonly number[]): number {
  const middle = size[0] + size[1] + size[2] - Math.min(...size) - Math.max(...size);
  return Math.min(Math.max(WEAR_FIT.size / Math.max(middle, 1e-4), WEAR_FIT.min), WEAR_FIT.max);
}
/** The bare metal under the paint, linear RGB. */
export const WEAR_METAL: [number, number, number] = [0.2, 0.205, 0.215];
export const WEAR_METAL_ROUGHNESS = 0.44;
/** Rust runs from a dark brown to a brighter orange, linear RGB. */
export const RUST_DARK: [number, number, number] = [0.05, 0.018, 0.008];
export const RUST_BRIGHT: [number, number, number] = [0.25, 0.08, 0.022];
/** Frequency of the rust blooms. */
export const RUST_SCALE = 3.3;

/**
 * Which edges a shape has, for wearing paint off them: a box's twelve, the two
 * rims of a cylinder, or none that a simple rule can find.
 */
export const EDGES = { box: 0, round: 1, none: -1 } as const;

export function edgesOf(primitive: string): number {
  if (primitive === "box" || primitive === "wedge" || primitive === "pyramid") return EDGES.box;
  if (primitive === "cylinder" || primitive === "cone") return EDGES.round;
  return EDGES.none;
}
