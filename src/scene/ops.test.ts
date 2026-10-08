import { describe, expect, it } from "vitest";
import { describeScene } from "./describe";
import {
  OpError,
  applyOp,
  applyOps,
  childIds,
  descendantIds,
  findSceneProblem,
  pathTo,
  uniqueId,
} from "./ops";
import { DEFAULT_MATERIAL, emptyScene, type Op, type Scene, type SceneNode, type Vec3 } from "./types";

const base = {
  position: [0, 0, 0] as Vec3,
  rotation: [0, 0, 0] as Vec3,
  scale: [1, 1, 1] as Vec3,
  visible: true,
  author: "ai" as const,
  pinned: [],
};
const group = (id: string, parent: string | null = null): SceneNode => ({
  ...base,
  id,
  name: id,
  parent,
  kind: "group",
  blend: 0,
});
const mesh = (id: string, parent: string | null = null): SceneNode => ({
  ...base,
  id,
  name: id,
  parent,
  kind: "mesh",
  primitive: "box",
  material: { ...DEFAULT_MATERIAL },
  bevel: 0,
  array: null,
  taper: [1, 1],
});
const add = (node: SceneNode): Op => ({ type: "add", node });

function tableScene(): Scene {
  return applyOps(emptyScene(), [
    add(group("table")),
    add(mesh("top", "table")),
    add(mesh("leg", "table")),
    add(mesh("cup")),
  ]).scene;
}

describe("applyOp", () => {
  it("adds nodes and indexes children in insertion order", () => {
    const scene = tableScene();
    expect(childIds(scene, null)).toEqual(["table", "cup"]);
    expect(childIds(scene, "table")).toEqual(["top", "leg"]);
    expect(pathTo(scene, "leg")).toEqual(["table", "leg"]);
  });

  it("does not mutate the scene it is given", () => {
    const scene = tableScene();
    const snapshot = structuredClone(scene);
    applyOps(scene, [
      { type: "update", id: "top", patch: { position: [1, 2, 3], material: { color: "#ff0000" } } },
      { type: "remove", id: "table" },
      { type: "env", patch: { ambient: 2 } },
    ]);
    expect(scene).toEqual(snapshot);
  });

  it("rejects duplicate ids, missing parents and unknown ids with OpError", () => {
    const scene = tableScene();
    expect(() => applyOp(scene, add(mesh("cup")))).toThrow(OpError);
    expect(() => applyOp(scene, add(mesh("x", "nope")))).toThrow(/Parent "nope" does not exist/);
    expect(() => applyOp(scene, { type: "update", id: "nope", patch: { name: "n" } })).toThrow(OpError);
    expect(() => applyOp(scene, { type: "remove", id: "nope" })).toThrow(OpError);
  });

  it("rejects parenting a node under itself or its descendants", () => {
    const scene = tableScene();
    expect(() => applyOp(scene, { type: "update", id: "table", patch: { parent: "leg" } })).toThrow(
      /under itself/,
    );
    expect(() => applyOp(scene, { type: "update", id: "table", patch: { parent: "table" } })).toThrow(
      OpError,
    );
  });

  it("lets only groups blend their parts", () => {
    const scene = tableScene();
    const blended = applyOp(scene, { type: "update", id: "table", patch: { blend: 0.08 } }).scene;
    expect(blended.nodes.table).toMatchObject({ kind: "group", blend: 0.08 });
    expect(() => applyOp(scene, { type: "update", id: "top", patch: { blend: 0.1 } })).toThrow(
      /only groups can blend/,
    );
  });

  it("rejects material patches on groups and light patches on meshes", () => {
    const scene = tableScene();
    expect(() =>
      applyOp(scene, { type: "update", id: "table", patch: { material: { color: "#000000" } } }),
    ).toThrow(/only meshes/);
    expect(() =>
      applyOp(scene, { type: "update", id: "top", patch: { light: { intensity: 2 } } }),
    ).toThrow(/not a light/);
  });

  it("merges partial material and environment patches", () => {
    let scene = tableScene();
    scene = applyOp(scene, { type: "update", id: "top", patch: { material: { color: "#112233" } } }).scene;
    const top = scene.nodes.top;
    expect(top.kind === "mesh" && top.material).toEqual({ ...DEFAULT_MATERIAL, color: "#112233" });

    const before = scene.environment.sun;
    scene = applyOp(scene, { type: "env", patch: { sun: { intensity: 0.2 } } }).scene;
    expect(scene.environment.sun).toEqual({ ...before, intensity: 0.2 });
  });

  it("removes a node together with everything under it", () => {
    const scene = applyOp(tableScene(), { type: "remove", id: "table" }).scene;
    expect(Object.keys(scene.nodes)).toEqual(["cup"]);
  });
});

describe("inverse ops", () => {
  const cases: Record<string, Op[]> = {
    add: [add(mesh("plate", "table"))],
    update: [
      {
        type: "update",
        id: "top",
        patch: {
          name: "Top",
          position: [1, 2, 3],
          visible: false,
          primitive: "sphere",
          material: { roughness: 0.1 },
        },
      },
    ],
    reparent: [{ type: "update", id: "cup", patch: { parent: "table" } }],
    blend: [{ type: "update", id: "table", patch: { blend: 0.1 } }],
    "remove subtree": [{ type: "remove", id: "table" }],
    environment: [
      {
        type: "env",
        patch: {
          background: "#000000",
          sun: { elevation: 5 },
          ground: { visible: false },
          fog: { color: "#ffffff", near: 1, far: 9 },
        },
      },
    ],
    "several ops": [
      add(mesh("a")),
      { type: "update", id: "a", patch: { scale: [2, 2, 2] } },
      add(mesh("b", "a")),
      { type: "remove", id: "cup" },
    ],
  };

  for (const [name, ops] of Object.entries(cases)) {
    it("undoes " + name, () => {
      const before = tableScene();
      const { scene: after, inverse } = applyOps(before, ops);
      expect(after).not.toEqual(before);
      const restored = applyOps(after, inverse).scene;
      // Re-added nodes move to the end of the outliner, so compare order-insensitively.
      expect(restored.environment).toEqual(before.environment);
      expect(new Map(Object.entries(restored.nodes))).toEqual(new Map(Object.entries(before.nodes)));
    });
  }

  it("applies nothing when one op in a batch fails", () => {
    const scene = tableScene();
    expect(() => applyOps(scene, [add(mesh("ok")), { type: "remove", id: "missing" }])).toThrow(OpError);
    expect(scene.nodes.ok).toBeUndefined();
  });
});

describe("pinning", () => {
  it("records properties a user edits, once each, and leaves AI edits unpinned", () => {
    let scene = tableScene();
    scene = applyOp(scene, { type: "update", id: "top", patch: { position: [1, 0, 0] } }, "ai").scene;
    expect(scene.nodes.top.pinned).toEqual([]);
    scene = applyOp(
      scene,
      { type: "update", id: "top", patch: { position: [2, 0, 0], material: { color: "#ff0000" } } },
      "user",
    ).scene;
    scene = applyOp(
      scene,
      { type: "update", id: "top", patch: { position: [3, 0, 0], name: "renamed" } },
      "user",
    ).scene;
    expect(scene.nodes.top.pinned).toEqual(["position", "material"]);
  });

  it("is undone together with the edit that caused it", () => {
    const before = tableScene();
    const { scene, inverse } = applyOp(
      before,
      { type: "update", id: "top", patch: { scale: [2, 2, 2] } },
      "user",
    );
    expect(scene.nodes.top.pinned).toEqual(["scale"]);
    expect(applyOps(scene, inverse).scene.nodes.top).toEqual(before.nodes.top);
  });

  it("is surfaced to the planner in the scene description", () => {
    const scene = applyOp(
      tableScene(),
      { type: "update", id: "cup", patch: { position: [4, 0.5, 0] } },
      "user",
    ).scene;
    const described = JSON.parse(describeScene(scene));
    const cup = described.objects.find((o: { id: string }) => o.id === "cup");
    expect(cup).toMatchObject({ position: [4, 0.5, 0], pinned: ["position"] });
    expect(cup.rotation).toBeUndefined(); // defaults are omitted
    expect(described.objects[0].children.map((c: { id: string }) => c.id)).toEqual(["top", "leg"]);
  });
});

describe("helpers", () => {
  it("uniqueId slugs names and avoids collisions", () => {
    const scene = tableScene();
    expect(uniqueId(scene, "Oak Tree!")).toBe("oak_tree");
    expect(uniqueId(scene, "table")).toBe("table_2");
    expect(uniqueId(scene, "table", new Set(["table_2"]))).toBe("table_3");
    expect(uniqueId(scene, "3d thing")).toBe("n_3d_thing");
    expect(uniqueId(scene, "!!!")).toBe("object");
  });

  it("descendantIds lists parents before children", () => {
    const scene = applyOp(tableScene(), add(mesh("foot", "leg"))).scene;
    expect(descendantIds(scene, "table")).toEqual(["top", "leg", "foot"]);
  });

  it("findSceneProblem catches missing parents, cycles and mismatched keys", () => {
    expect(findSceneProblem(tableScene())).toBeNull();
    const orphan = { ...emptyScene(), nodes: { a: mesh("a", "ghost") } };
    expect(findSceneProblem(orphan)).toMatch(/missing parent/);
    const cycle = { ...emptyScene(), nodes: { a: group("a", "b"), b: group("b", "a") } };
    expect(findSceneProblem(cycle)).toMatch(/cycle/);
    const mismatch = { ...emptyScene(), nodes: { a: mesh("b") } };
    expect(findSceneProblem(mismatch)).toMatch(/has id "b"/);
  });
});
