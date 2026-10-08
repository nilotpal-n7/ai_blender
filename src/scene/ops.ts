/**
 * Scene operations — the only way a scene changes.
 *
 * `applyOp` is pure: it returns a new scene plus the ops that undo the change.
 * The planner (server) and the editor (browser) both run this same code, so an
 * op validated on the server produces the identical result on the client.
 */

import {
  MAX_NODES,
  PINNABLE,
  type Animatable,
  type Author,
  type Camera,
  type ClipPatch,
  type EnvPatch,
  type Key,
  type NodePatch,
  type Op,
  type Pinnable,
  type Scene,
  type SceneNode,
} from "./types";

/** Thrown when an op can't be applied. The message is written for the op's author. */
export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}

export interface Applied {
  scene: Scene;
  /** Applying these in order restores the previous scene. */
  inverse: Op[];
}

// ─── Hierarchy lookups ──────────────────────────────────────────────

const childIndexCache = new WeakMap<Scene["nodes"], Map<string | null, string[]>>();

function childIndex(scene: Scene): Map<string | null, string[]> {
  let index = childIndexCache.get(scene.nodes);
  if (!index) {
    index = new Map();
    for (const node of Object.values(scene.nodes)) {
      const siblings = index.get(node.parent);
      if (siblings) siblings.push(node.id);
      else index.set(node.parent, [node.id]);
    }
    childIndexCache.set(scene.nodes, index);
  }
  return index;
}

/** Ids of the direct children of `parent` (`null` for top-level nodes), in outliner order. */
export function childIds(scene: Scene, parent: string | null): readonly string[] {
  return childIndex(scene).get(parent) ?? [];
}

/** Ids of everything under `id`, parents before their children. */
export function descendantIds(scene: Scene, id: string): string[] {
  const out: string[] = [];
  const visit = (parent: string) => {
    for (const child of childIds(scene, parent)) {
      out.push(child);
      visit(child);
    }
  };
  visit(id);
  return out;
}

/** The chain from the top-level ancestor down to `id` itself. */
export function pathTo(scene: Scene, id: string): string[] {
  const path: string[] = [];
  let current: string | null = id;
  while (current !== null && scene.nodes[current] && path.length <= MAX_NODES) {
    path.unshift(current);
    current = scene.nodes[current].parent;
  }
  return path;
}

// ─── Apply ──────────────────────────────────────────────────────────

function requireNode(scene: Scene, id: string): SceneNode {
  const node = scene.nodes[id];
  if (!node) throw new OpError(`No object with id "${id}" exists.`);
  return node;
}

function applyAdd(scene: Scene, node: SceneNode): Applied {
  if (scene.nodes[node.id]) {
    throw new OpError(`An object with id "${node.id}" already exists. Pick a different id.`);
  }
  if (node.parent !== null && !scene.nodes[node.parent]) {
    throw new OpError(`Parent "${node.parent}" does not exist. Add the parent first.`);
  }
  if (Object.keys(scene.nodes).length >= MAX_NODES) {
    throw new OpError(`The scene is full (${MAX_NODES} objects).`);
  }
  return {
    scene: { ...scene, nodes: { ...scene.nodes, [node.id]: node } },
    inverse: [{ type: "remove", id: node.id }],
  };
}

function applyUpdate(scene: Scene, id: string, patch: NodePatch, author: Author): Applied {
  const prev = requireNode(scene, id);
  const next = { ...prev } as SceneNode;
  const undo: NodePatch = {};

  if (patch.name !== undefined) {
    undo.name = prev.name;
    next.name = patch.name;
  }
  if (patch.visible !== undefined) {
    undo.visible = prev.visible;
    next.visible = patch.visible;
  }
  for (const key of ["position", "rotation", "scale"] as const) {
    if (patch[key] !== undefined) {
      undo[key] = prev[key];
      next[key] = patch[key];
    }
  }
  if (patch.parent !== undefined && patch.parent !== prev.parent) {
    if (patch.parent !== null) {
      requireNode(scene, patch.parent);
      if (patch.parent === id || descendantIds(scene, id).includes(patch.parent)) {
        throw new OpError(`Cannot parent "${id}" under itself or one of its own children.`);
      }
    }
    undo.parent = prev.parent;
    next.parent = patch.parent;
  }
  if (patch.primitive !== undefined || patch.material !== undefined) {
    if (prev.kind !== "mesh" || next.kind !== "mesh") {
      throw new OpError(`"${id}" is a ${prev.kind}; only meshes have a primitive and a material.`);
    }
    if (patch.primitive !== undefined) {
      undo.primitive = prev.primitive;
      next.primitive = patch.primitive;
    }
  }
  if (patch.bevel !== undefined) {
    if (prev.kind !== "mesh" || next.kind !== "mesh") {
      throw new OpError(`"${id}" is a ${prev.kind}; only meshes can be beveled.`);
    }
    undo.bevel = prev.bevel;
    next.bevel = patch.bevel;
  }
  if (patch.array !== undefined) {
    if (prev.kind !== "mesh" || next.kind !== "mesh") {
      throw new OpError(`"${id}" is a ${prev.kind}; only meshes can be repeated in an array.`);
    }
    undo.array = prev.array;
    next.array = patch.array;
  }
  if (patch.taper !== undefined) {
    if (prev.kind !== "mesh" || next.kind !== "mesh") {
      throw new OpError(`"${id}" is a ${prev.kind}; only meshes can be tapered.`);
    }
    undo.taper = prev.taper;
    next.taper = patch.taper;
  }
  if (patch.material !== undefined) {
    if (prev.kind !== "mesh" || next.kind !== "mesh") {
      throw new OpError(`"${id}" is a ${prev.kind}; only meshes have a primitive and a material.`);
    }
    const before: NodePatch["material"] = {};
    for (const key of Object.keys(patch.material) as (keyof typeof patch.material)[]) {
      Object.assign(before, { [key]: prev.material[key] });
    }
    undo.material = before;
    next.material = { ...prev.material, ...patch.material };
  }
  if (patch.blend !== undefined) {
    if (prev.kind !== "group" || next.kind !== "group") {
      throw new OpError(`"${id}" is a ${prev.kind}; only groups can blend their parts.`);
    }
    undo.blend = prev.blend;
    next.blend = patch.blend;
  }
  if (patch.light !== undefined) {
    if (prev.kind !== "light" || next.kind !== "light") {
      throw new OpError(`"${id}" is a ${prev.kind}, not a light.`);
    }
    const before: NodePatch["light"] = {};
    for (const key of Object.keys(patch.light) as (keyof typeof patch.light)[]) {
      Object.assign(before, { [key]: prev.light[key] });
    }
    undo.light = before;
    next.light = { ...prev.light, ...patch.light };
  }

  // Remember which properties a human set by hand, so the planner can respect them.
  let pinned = patch.pinned;
  if (pinned === undefined && author === "user") {
    const touched = PINNABLE.filter((key) => patch[key] !== undefined);
    const added = touched.filter((key) => !prev.pinned.includes(key));
    if (added.length > 0) pinned = [...prev.pinned, ...added] as Pinnable[];
  }
  if (pinned !== undefined) {
    undo.pinned = prev.pinned;
    next.pinned = pinned;
  }

  return {
    scene: { ...scene, nodes: { ...scene.nodes, [id]: next } },
    inverse: [{ type: "update", id, patch: undo }],
  };
}

function applyRemove(scene: Scene, id: string): Applied {
  const node = requireNode(scene, id);
  const doomed = [id, ...descendantIds(scene, id)];
  const nodes = { ...scene.nodes };
  for (const gone of doomed) delete nodes[gone];
  // A removed node takes its animation with it.
  const gone = new Set(doomed);
  const lost = scene.clip.tracks.filter((track) => gone.has(track.node));
  const clip = lost.length > 0
    ? { ...scene.clip, tracks: scene.clip.tracks.filter((track) => !gone.has(track.node)) }
    : scene.clip;
  return {
    scene: { ...scene, nodes, clip },
    inverse: [
      // Parents first, so each re-add finds its parent.
      ...[node, ...doomed.slice(1).map((d) => scene.nodes[d])].map(
        (n): Op => ({ type: "add", node: n }),
      ),
      ...lost.map((track): Op => ({ type: "animate", id: track.node, property: track.property, keys: track.keys })),
    ],
  };
}

function applyEnv(scene: Scene, patch: EnvPatch): Applied {
  const prev = scene.environment;
  const next = { ...prev };
  const undo: EnvPatch = {};

  if (patch.background !== undefined) {
    undo.background = prev.background;
    next.background = patch.background;
  }
  if (patch.ambient !== undefined) {
    undo.ambient = prev.ambient;
    next.ambient = patch.ambient;
  }
  if (patch.sun !== undefined) {
    undo.sun = prev.sun;
    next.sun = { ...prev.sun, ...patch.sun };
  }
  if (patch.ground !== undefined) {
    undo.ground = prev.ground;
    next.ground = { ...prev.ground, ...patch.ground };
  }
  if (patch.fog !== undefined) {
    undo.fog = prev.fog;
    next.fog = patch.fog;
  }
  if (patch.grade !== undefined) {
    undo.grade = prev.grade;
    next.grade = { ...prev.grade, ...patch.grade };
  }
  return { scene: { ...scene, environment: next }, inverse: [{ type: "env", patch: undo }] };
}

function applyCamera(scene: Scene, patch: Partial<Camera>): Applied {
  const undo: Partial<Camera> = {};
  for (const key of Object.keys(patch) as (keyof Camera)[]) {
    Object.assign(undo, { [key]: scene.camera[key] });
  }
  return {
    scene: { ...scene, camera: { ...scene.camera, ...patch } },
    inverse: [{ type: "camera", patch: undo }],
  };
}

function applyClip(scene: Scene, patch: ClipPatch): Applied {
  const undo: ClipPatch = {};
  for (const key of Object.keys(patch) as (keyof ClipPatch)[]) {
    Object.assign(undo, { [key]: scene.clip[key] });
  }
  return {
    scene: { ...scene, clip: { ...scene.clip, ...patch } },
    inverse: [{ type: "clip", patch: undo }],
  };
}

function applyAnimate(scene: Scene, id: string, property: Animatable, keys: readonly Key[]): Applied {
  const node = requireNode(scene, id);
  // Motion lives on groups: a group is a joint, and everything inside it moves along.
  if (node.kind !== "group") {
    throw new OpError(
      `"${id}" is a ${node.kind}. Only groups can be animated; put it in a group and animate that.`,
    );
  }
  // One key per moment, in order.
  const byTime = new Map(keys.map((key) => [key.t, key]));
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
  const others = scene.clip.tracks.filter((t) => t.node !== id || t.property !== property);
  const before = scene.clip.tracks.find((t) => t.node === id && t.property === property);
  const tracks = sorted.length > 0 ? [...others, { node: id, property, keys: sorted }] : others;
  return {
    scene: { ...scene, clip: { ...scene.clip, tracks } },
    inverse: [{ type: "animate", id, property, keys: before?.keys ?? [] }],
  };
}

export function applyOp(scene: Scene, op: Op, author: Author = "ai"): Applied {
  switch (op.type) {
    case "add":
      return applyAdd(scene, op.node);
    case "update":
      return applyUpdate(scene, op.id, op.patch, author);
    case "remove":
      return applyRemove(scene, op.id);
    case "env":
      return applyEnv(scene, op.patch);
    case "camera":
      return applyCamera(scene, op.patch);
    case "clip":
      return applyClip(scene, op.patch);
    case "animate":
      return applyAnimate(scene, op.id, op.property, op.keys);
  }
}

/** Applies ops in order. All-or-nothing: if any op fails, nothing is applied. */
export function applyOps(scene: Scene, ops: readonly Op[], author: Author = "ai"): Applied {
  let current = scene;
  const inverse: Op[] = [];
  for (const op of ops) {
    const applied = applyOp(current, op, author);
    current = applied.scene;
    inverse.unshift(...applied.inverse);
  }
  return { scene: current, inverse };
}

/** Structural checks a schema can't express. Returns a problem description, or null if sound. */
export function findSceneProblem(scene: Scene): string | null {
  const ids = Object.keys(scene.nodes);
  if (ids.length > MAX_NODES) return `Too many objects (${ids.length}).`;
  for (const id of ids) {
    const node = scene.nodes[id];
    if (node.id !== id) return `Node stored under "${id}" has id "${node.id}".`;
    if (node.parent !== null && !scene.nodes[node.parent]) {
      return `"${id}" has a missing parent "${node.parent}".`;
    }
  }
  for (const track of scene.clip.tracks) {
    if (scene.nodes[track.node]?.kind !== "group") {
      return `The animation refers to "${track.node}", which is not a group in the scene.`;
    }
  }
  for (const id of ids) {
    const seen = new Set<string>([id]);
    for (let p = scene.nodes[id].parent; p !== null; p = scene.nodes[p].parent) {
      if (seen.has(p)) return `"${id}" is part of a parent cycle.`;
      seen.add(p);
    }
  }
  return null;
}

/** Returns `base` if it is free, otherwise `base_2`, `base_3`, … */
export function uniqueId(scene: Scene, base: string, taken?: ReadonlySet<string>): string {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "object";
  const root = /^[a-z_]/.test(clean) ? clean : `n_${clean}`;
  const used = (id: string) => id in scene.nodes || taken?.has(id);
  if (!used(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}_${n}`;
    if (!used(candidate)) return candidate;
  }
}
