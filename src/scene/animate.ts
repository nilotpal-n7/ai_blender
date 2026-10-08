/**
 * Evaluating animation: what a clip's tracks say each group's transform is at
 * a given time. The viewport, the recorder and the exporters all sample through
 * here, so they agree on every frame.
 */

import type { Animatable, Clip, Key, Scene, Track, Vec3 } from "./types";

/** A node's animated properties at one moment; anything missing keeps its own value. */
export type Pose = Partial<Record<Animatable, Vec3>>;

const smooth = (u: number) => u * u * (3 - 2 * u);

/** The value of a track at time `t`. Holds the first key before it and the last key after it. */
export function sampleTrack(keys: readonly Key[], t: number): Vec3 {
  if (t <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.value;
  // Tracks are short, so a linear scan is fine.
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const [a, b] = [keys[i], keys[i + 1]];
  if (a.ease === "hold") return a.value;
  const linear = (t - a.t) / (b.t - a.t);
  const u = a.ease === "linear" ? linear : smooth(linear);
  return [
    a.value[0] + (b.value[0] - a.value[0]) * u,
    a.value[1] + (b.value[1] - a.value[1]) * u,
    a.value[2] + (b.value[2] - a.value[2]) * u,
  ];
}

/** Where in the clip a moment of wall-clock time falls: wrapped if it loops, clamped if not. */
export function clipTime(clip: Clip, seconds: number): number {
  if (!clip.loop) return Math.min(Math.max(seconds, 0), clip.duration);
  const wrapped = seconds % clip.duration;
  return wrapped < 0 ? wrapped + clip.duration : wrapped;
}

/** Every animated node's pose at time `t` (seconds into the clip). */
export function poseAt(scene: Scene, t: number): Map<string, Pose> {
  const poses = new Map<string, Pose>();
  for (const track of scene.clip.tracks) {
    let pose = poses.get(track.node);
    if (!pose) poses.set(track.node, (pose = {}));
    pose[track.property] = sampleTrack(track.keys, t);
  }
  return poses;
}

export function trackOf(scene: Scene, node: string, property: Animatable): Track | undefined {
  return scene.clip.tracks.find((track) => track.node === node && track.property === property);
}

/** Number of frames in the clip, counting both ends. */
export function frameCount(clip: Clip): number {
  return Math.max(1, Math.round(clip.duration * clip.fps)) + 1;
}

/** Returns `keys` with a key at `t` set to `value`, replacing one already there. */
export function withKey(keys: readonly Key[], t: number, value: Vec3): Key[] {
  const at = Math.round(t * 1000) / 1000;
  const kept = keys.filter((key) => Math.abs(key.t - at) > 1e-4);
  return [...kept, { t: at, value, ease: "smooth" as const }].sort((a, b) => a.t - b.t);
}
