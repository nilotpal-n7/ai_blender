import type * as THREE from "three";

/**
 * The live viewport, for code outside the canvas that has to reach into it:
 * the camera buttons and the video recorder.
 */
export const stage: {
  canvas: HTMLCanvasElement | null;
  camera: THREE.PerspectiveCamera | null;
  controls: { target: THREE.Vector3; update(): void } | null;
} = { canvas: null, camera: null, controls: null };
