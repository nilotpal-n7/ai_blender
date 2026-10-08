import { describe, expect, it } from "vitest";
import { clipTime, frameCount, poseAt, sampleTrack, trackOf, withKey } from "./animate";
import { arrayCopies } from "./array";
import { describeScene } from "./describe";
import { OpError, applyOp, applyOps } from "./ops";
import { DEFAULT_CLIP, DEFAULT_MATERIAL, emptyScene, type Key, type Op, type Scene, type SceneNode, type Vec3 } from "./types";

const base = {
  position: [0, 0, 0] as Vec3,
  rotation: [0, 0, 0] as Vec3,
  scale: [1, 1, 1] as Vec3,
  visible: true,
  author: "ai" as const,
  pinned: [],
};
const group = (id: string, parent: string | null = null): SceneNode => ({ ...base, id, name: id, parent, kind: "group", blend: 0 });
const mesh = (id: string, parent: string | null = null): SceneNode => ({
  ...base, id, name: id, parent, kind: "mesh", primitive: "box", material: { ...DEFAULT_MATERIAL }, bevel: 0, array: null, taper: [1, 1],
});
const key = (t: number, value: Vec3, ease: Key["ease"] = "smooth"): Key => ({ t, value, ease });

/** An arm (group) holding a hand (group) holding a finger (mesh). */
function armScene(): Scene {
  return applyOps(emptyScene(), [
    { type: "add", node: group("arm") },
    { type: "add", node: group("hand", "arm") },
    { type: "add", node: mesh("finger", "hand") },
  ]).scene;
}

describe("sampleTrack", () => {
  const keys = [key(1, [0, 0, 0]), key(3, [10, 20, -30], "linear"), key(4, [0, 0, 0], "hold"), key(5, [7, 7, 7])];

  it("holds the first key before it and the last key after it", () => {
    expect(sampleTrack(keys, 0)).toEqual([0, 0, 0]);
    expect(sampleTrack(keys, 99)).toEqual([7, 7, 7]);
    expect(sampleTrack([key(2, [1, 2, 3])], 0.5)).toEqual([1, 2, 3]);
  });

  it("eases by the key a segment starts from", () => {
    // Smooth: slow away from the key, half way at the middle.
    expect(sampleTrack(keys, 2)[0]).toBeCloseTo(5);
    expect(sampleTrack(keys, 1.5)[0]).toBeCloseTo(10 * 0.15625);
    // Linear: a steady rate.
    expect(sampleTrack(keys, 3.25)).toEqual([7.5, 15, -22.5]);
    // Hold: stays put, then jumps.
    expect(sampleTrack(keys, 4.9)).toEqual([0, 0, 0]);
    expect(sampleTrack(keys, 5)).toEqual([7, 7, 7]);
  });

  it("lands exactly on each key", () => {
    for (const k of keys) expect(sampleTrack(keys, k.t)).toEqual(k.value);
  });
});

describe("clip helpers", () => {
  it("wraps time in a looping clip and clamps it otherwise", () => {
    const loop = { ...DEFAULT_CLIP, duration: 4, loop: true };
    expect(clipTime(loop, 9)).toBeCloseTo(1);
    expect(clipTime(loop, -1)).toBeCloseTo(3);
    const once = { ...loop, loop: false };
    expect(clipTime(once, 9)).toBe(4);
    expect(clipTime(once, -1)).toBe(0);
  });

  it("counts frames at both ends", () => {
    expect(frameCount({ ...DEFAULT_CLIP, duration: 4, fps: 24 })).toBe(97);
    expect(frameCount({ ...DEFAULT_CLIP, duration: 0.1, fps: 1 })).toBe(2);
  });

  it("withKey adds a key in order and replaces one at the same time", () => {
    const keys = [key(0, [0, 0, 0]), key(2, [2, 2, 2])];
    expect(withKey(keys, 1, [1, 1, 1]).map((k) => k.t)).toEqual([0, 1, 2]);
    const replaced = withKey(keys, 2.00004, [9, 9, 9]);
    expect(replaced).toHaveLength(2);
    expect(replaced[1].value).toEqual([9, 9, 9]);
  });
});

describe("the animate op", () => {
  const swing: Op = { type: "animate", id: "arm", property: "rotation", keys: [key(2, [0, 0, 90]), key(0, [0, 0, 0]), key(2, [0, 0, 45])] };

  it("stores keys in order, one per moment, and undoes cleanly", () => {
    const before = armScene();
    const { scene, inverse } = applyOp(before, swing);
    const track = trackOf(scene, "arm", "rotation")!;
    expect(track.keys.map((k) => [k.t, k.value[2]])).toEqual([[0, 0], [2, 45]]);
    expect(poseAt(scene, 1).get("arm")).toEqual({ rotation: [0, 0, 22.5] });
    expect(applyOps(scene, inverse).scene).toEqual(before);
  });

  it("replaces a track, and removes it when given no keys", () => {
    const first = applyOp(armScene(), swing).scene;
    const second = applyOp(first, { ...swing, keys: [key(1, [5, 5, 5])] });
    expect(second.scene.clip.tracks).toHaveLength(1);
    expect(applyOps(second.scene, second.inverse).scene).toEqual(first);

    const cleared = applyOp(first, { ...swing, keys: [] });
    expect(cleared.scene.clip.tracks).toEqual([]);
    expect(applyOps(cleared.scene, cleared.inverse).scene).toEqual(first);
  });

  it("only animates groups, and says what to do instead", () => {
    expect(() => applyOp(armScene(), { ...swing, id: "finger" })).toThrow(OpError);
    expect(() => applyOp(armScene(), { ...swing, id: "finger" })).toThrow(/put it in a group/);
    expect(() => applyOp(armScene(), { ...swing, id: "ghost" })).toThrow(/No object/);
  });

  it("removing an object takes its animation along, and undo brings both back", () => {
    let scene = applyOp(armScene(), swing).scene;
    scene = applyOp(scene, { type: "animate", id: "hand", property: "position", keys: [key(0, [0, 1, 0])] }).scene;
    const removed = applyOp(scene, { type: "remove", id: "arm" });
    expect(removed.scene.clip.tracks).toEqual([]);
    const restored = applyOps(removed.scene, removed.inverse).scene;
    expect(restored.nodes).toEqual(scene.nodes);
    expect(new Set(restored.clip.tracks)).toEqual(new Set(scene.clip.tracks));
  });

  it("clip and camera changes merge and undo", () => {
    const before = armScene();
    const clip = applyOp(before, { type: "clip", patch: { duration: 8, loop: false } });
    expect(clip.scene.clip).toMatchObject({ duration: 8, fps: 24, loop: false });
    expect(applyOps(clip.scene, clip.inverse).scene).toEqual(before);
    const camera = applyOp(before, { type: "camera", patch: { fov: 30, position: [1, 2, 3] } });
    expect(camera.scene.camera).toEqual({ position: [1, 2, 3], target: before.camera.target, fov: 30 });
    expect(applyOps(camera.scene, camera.inverse).scene).toEqual(before);
  });
});

describe("arrays and bevels", () => {
  it("places each copy by whole steps and turns, the original first", () => {
    expect(arrayCopies(null)).toEqual([{ position: [0, 0, 0], rotation: [0, 0, 0] }]);
    const copies = arrayCopies({ count: 4, step: [0, 0.5, 0], turn: [0, 90, 0] });
    expect(copies).toHaveLength(4);
    expect(copies[0]).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] });
    expect(copies[3]).toEqual({ position: [0, 1.5, 0], rotation: [0, 270, 0] });
  });

  it("are set and undone through update, on meshes only", () => {
    const before = armScene();
    const array = { count: 3, step: [1, 0, 0] as Vec3, turn: [0, 0, 0] as Vec3 };
    const { scene, inverse } = applyOp(before, { type: "update", id: "finger", patch: { array, bevel: 0.02 } });
    expect(scene.nodes.finger).toMatchObject({ array, bevel: 0.02 });
    expect(applyOps(scene, inverse).scene).toEqual(before);
    expect(() => applyOp(before, { type: "update", id: "arm", patch: { array } })).toThrow(/only meshes/);
    expect(() => applyOp(before, { type: "update", id: "arm", patch: { bevel: 0.1 } })).toThrow(/only meshes/);
  });
});

describe("describeScene with animation", () => {
  it("lists short tracks key by key and summarizes sampled ones", () => {
    let scene = applyOp(armScene(), {
      type: "animate", id: "arm", property: "rotation", keys: [key(0, [0, 0, 0]), key(2, [0, 0, 45], "linear")],
    }).scene;
    const dense = Array.from({ length: 49 }, (_, i) => key(i / 12, [0, i, 0], "linear"));
    scene = applyOp(scene, { type: "animate", id: "hand", property: "position", keys: dense }).scene;
    scene = applyOp(scene, { type: "update", id: "finger", patch: { bevel: 0.01, material: { wear: 0.4 } } }).scene;

    const described = JSON.parse(describeScene(scene));
    expect(described.clip).toEqual({ duration: 4, fps: 24, loop: true });
    expect(described.camera).toEqual(scene.camera);
    const [arm] = described.objects;
    expect(arm.animated).toEqual({ rotation: [[0, 0, 0, 0], [2, 0, 0, 45, "linear"]] });
    expect(arm.children[0].animated).toEqual({ position: "49 keys from 0s to 4s" });
    expect(arm.children[0].children[0]).toMatchObject({ bevel: 0.01, material: { wear: 0.4 } });
    // A scene with nothing moving doesn't mention the clip.
    expect(JSON.parse(describeScene(armScene())).clip).toBeUndefined();
  });
});
