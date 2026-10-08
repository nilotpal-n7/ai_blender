import { roundVec } from "./math";
import type { ArrayCopies, Vec3 } from "./types";

/** Where one copy of an arrayed mesh sits: turned about its parent's origin, then moved. */
export interface CopyPlacement {
  position: Vec3;
  /** Euler XYZ in degrees. */
  rotation: Vec3;
}

const HERE: CopyPlacement = { position: [0, 0, 0], rotation: [0, 0, 0] };

/**
 * The placement of every copy of an arrayed mesh, the original (which doesn't
 * move) first. A mesh without an array is a single copy.
 */
export function arrayCopies(array: ArrayCopies | null): CopyPlacement[] {
  if (!array) return [HERE];
  return Array.from({ length: array.count }, (_, i) => ({
    position: roundVec(array.step.map((v) => v * i), 6),
    rotation: roundVec(array.turn.map((v) => v * i), 6),
  }));
}
