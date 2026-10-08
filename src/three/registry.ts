import type { Object3D } from "three";

/**
 * Maps scene node ids to their live three.js objects, so the gizmo and the
 * camera can reach an object without threading refs through the tree.
 */
const objects = new Map<string, Object3D>();
const listeners = new Set<() => void>();

export const registry = {
  set(id: string, object: Object3D | null) {
    if (object) objects.set(id, object);
    else objects.delete(id);
    listeners.forEach((listener) => listener());
  },
  get: (id: string) => objects.get(id),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
