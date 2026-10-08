/**
 * Compact, nested view of a scene for the planner's context.
 *
 * Children are nested under their parents and default values are dropped, so
 * the model reads the hierarchy directly and the scene costs few tokens.
 */

import { round, roundVec } from "./math";
import { childIds } from "./ops";
import { DEFAULT_MATERIAL, type ChatStats, type Op, type Scene, type Track } from "./types";

/** Tracks with more keys than this are summarized instead of listed. */
const KEYS_SHOWN = 16;

/** A track's keys as [time, x, y, z] rows, or a summary when there are many (sampled motion). */
function describeKeys(track: Track): unknown {
  const { keys } = track;
  if (keys.length > KEYS_SHOWN) return `${keys.length} keys from ${keys[0].t}s to ${keys[keys.length - 1].t}s`;
  return keys.map((key) => [key.t, ...roundVec(key.value, 2), ...(key.ease === "smooth" ? [] : [key.ease])]);
}

type Described = Record<string, unknown>;

const isZero = (v: readonly number[]) => v.every((n) => n === 0);
const isOne = (v: readonly number[]) => v.every((n) => n === 1);

function describeNode(scene: Scene, id: string): Described {
  const node = scene.nodes[id];
  const out: Described = { id: node.id, name: node.name };
  if (node.kind === "mesh") out.primitive = node.primitive;
  if (node.kind === "mesh" && node.bevel > 0) out.bevel = node.bevel;
  if (node.kind === "mesh" && (node.taper[0] !== 1 || node.taper[1] !== 1)) out.taper = node.taper;
  if (node.kind === "mesh" && node.outline) out.outline = node.outline.map(([a, b]) => [round(a, 3), round(b, 3)]);
  if (node.kind === "mesh" && node.array) {
    const { count, step, turn } = node.array;
    out.array = { count, ...(!isZero(step) && { step }), ...(!isZero(turn) && { turn }) };
  }
  if (node.kind === "group" && node.blend > 0) out.blend = node.blend;
  if (node.kind === "light") out.light = node.light.type;
  out.position = roundVec(node.position, 3);
  if (!isZero(node.rotation)) out.rotation = roundVec(node.rotation, 1);
  if (!isOne(node.scale)) out.scale = roundVec(node.scale, 3);
  if (!node.visible) out.visible = false;

  if (node.kind === "mesh") {
    const material: Described = { color: node.material.color };
    for (const key of ["roughness", "metalness", "emissive", "emissiveIntensity", "opacity", "wear", "rust"] as const) {
      if (node.material[key] !== DEFAULT_MATERIAL[key]) material[key] = node.material[key];
    }
    out.material = material;
  }
  if (node.kind === "light") {
    const { type, ...rest } = node.light;
    if (type === "point") delete (rest as Partial<typeof rest>).angle;
    Object.assign(out, rest);
  }

  if (node.author === "user") out.createdBy = "user";
  if (node.pinned.length > 0) out.pinned = node.pinned;
  const tracks = scene.clip.tracks.filter((track) => track.node === id);
  if (tracks.length > 0) {
    out.animated = Object.fromEntries(tracks.map((track) => [track.property, describeKeys(track)]));
  }

  const children = childIds(scene, id);
  if (children.length > 0) out.children = children.map((c) => describeNode(scene, c));
  return out;
}

export function describeScene(scene: Scene): string {
  const { tracks, ...clip } = scene.clip;
  return JSON.stringify({
    environment: scene.environment,
    camera: scene.camera,
    // The clip is only worth describing once something moves.
    ...(tracks.length > 0 && { clip }),
    objects: childIds(scene, null).map((id) => describeNode(scene, id)),
  });
}

/** Counts what a list of ops did, for the chat summary line. */
export function countOps(ops: readonly Op[]): ChatStats {
  const stats: ChatStats = { added: 0, updated: 0, removed: 0 };
  for (const op of ops) {
    if (op.type === "add") stats.added++;
    else if (op.type === "remove") stats.removed++;
    else stats.updated++;
  }
  return stats;
}
