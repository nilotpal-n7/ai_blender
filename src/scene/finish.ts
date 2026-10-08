/**
 * The numbers behind a worn finish (`material.wear`), shared by the viewport's
 * shader and the Blender material so the two chip at the same scale.
 */

/** Chips are around ten centimeters across: this many noise cells per meter. */
export const WEAR_SCALE = 4.6;
/** Frequency of the fine noise that roughens the chips' edges. */
export const WEAR_EDGE_SCALE = 23;
/** Frequency of the slow fade and grime across a surface. */
export const WEAR_GRIME_SCALE = 1.7;
/** The bare metal under the paint, linear RGB. */
export const WEAR_METAL: [number, number, number] = [0.23, 0.235, 0.245];
export const WEAR_METAL_ROUGHNESS = 0.46;
