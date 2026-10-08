import { describe, expect, it } from "vitest";
import { applyOps, childIds } from "@/scene/ops";
import { emptyScene, type Scene } from "@/scene/types";
import { createOfflinePlanner } from "./offline";
import type { PlanEvent } from "./types";

const planner = createOfflinePlanner({ delayMs: 0 });

/** Runs a prompt and replays the streamed ops the way the browser does. */
async function run(prompt: string, scene: Scene = emptyScene(), selection: string[] = []) {
  const events: PlanEvent[] = [];
  await planner.run({ scene, prompt, chat: [], selection }, (e) => events.push(e), new AbortController().signal);
  let result = scene;
  for (const event of events) {
    if (event.type === "ops") result = applyOps(result, event.ops).scene;
  }
  const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  return { scene: result, text, events };
}

const roots = (scene: Scene) => childIds(scene, null).map((id) => scene.nodes[id]);

describe("offline planner", () => {
  it("builds the classic prompt: a cube standing on a table under a spotlight", async () => {
    const { scene, text } = await run("A red cube on a wooden table with a spotlight");

    const table = scene.nodes.table;
    expect(table).toMatchObject({ kind: "group", name: "Wooden table", position: [0, 0, 0] });
    expect(childIds(scene, "table")).toHaveLength(5); // top + four legs

    // The table top surface is at 0.75 m and the cube is 0.6 m tall.
    const cube = scene.nodes.cube;
    expect(cube).toMatchObject({ kind: "mesh", primitive: "box", material: { color: "#d6453d" } });
    expect(cube.position).toEqual([0, 1.05, 0]);

    const light = scene.nodes.spotlight_1;
    expect(light).toMatchObject({ kind: "light", light: { type: "spot" }, position: [0, 5, 0] });
    expect(text).toBe("Added a table, a cube and a spotlight.");
  });

  it("places several objects without overlapping each other or what is already there", async () => {
    const first = await run("a house");
    const { scene } = await run("three trees and two rocks", first.scene);
    const placed = roots(scene);
    expect(placed.map((n) => n.id)).toEqual(["house", "tree", "tree_2", "tree_3", "rock", "rock_2"]);
    for (const a of placed) {
      for (const b of placed) {
        if (a === b) continue;
        const gap = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
        expect(gap).toBeGreaterThan(1.4);
      }
    }
    // Natural objects vary in size and rotation.
    expect(new Set(placed.slice(1, 4).map((n) => n.rotation[1])).size).toBe(3);
  });

  it("is deterministic", async () => {
    const a = await run("five trees at sunset");
    const b = await run("five trees at sunset");
    expect(a.scene).toEqual(b.scene);
    expect(a.text).toBe("Added 5 trees. Set the mood to sunset.");
    expect(a.scene.environment.sun.elevation).toBe(8);
  });

  it("recolors only the parts that carry an object's color", async () => {
    const first = await run("a car");
    const { scene, text } = await run("make the car blue", first.scene);
    expect(scene.nodes.car__body).toMatchObject({ material: { color: "#3d6fd6" } });
    expect(scene.nodes.car__wheel_1).toMatchObject({ material: { color: "#22242b" } });
    expect(Object.keys(scene.nodes)).toEqual(Object.keys(first.scene.nodes)); // nothing added
    expect(text).toBe("Painted the car blue.");
  });

  it("adds instead of recoloring when the prompt asks for a new thing", async () => {
    const first = await run("a table");
    const { scene } = await run("make a blue table", first.scene);
    expect(roots(scene).map((n) => n.id)).toEqual(["table", "table_2"]);
  });

  it("recolors the selection for 'it'", async () => {
    const first = await run("a cube and a sphere");
    const { scene } = await run("paint it green", first.scene, ["sphere"]);
    expect(scene.nodes.sphere).toMatchObject({ material: { color: "#3fa35a" } });
    expect(scene.nodes.cube).toMatchObject({ material: { color: "#b8bcc8" } });
  });

  it("removes one named object, all of a kind, or everything", async () => {
    const base = (await run("three trees and a house")).scene;
    expect(roots((await run("remove the tree", base)).scene).map((n) => n.id)).toEqual(["tree", "tree_2", "house"]);
    expect(roots((await run("delete all trees", base)).scene).map((n) => n.id)).toEqual(["house"]);
    const cleared = await run("clear the scene", base);
    expect(cleared.scene.nodes).toEqual({});
    expect(cleared.text).toBe("Cleared the scene.");
  });

  it("gives lamps a light and scales sized objects", async () => {
    const { scene } = await run("a huge lamp");
    expect(scene.nodes.lamp).toMatchObject({ kind: "group", scale: [2, 2, 2] });
    expect(scene.nodes.lamp_light).toMatchObject({ kind: "light", parent: "lamp" });
  });

  it("explains itself instead of guessing when it recognizes nothing", async () => {
    const { scene, text, events } = await run("a baroque cathedral with flying buttresses");
    expect(scene.nodes).toEqual({});
    expect(events.filter((e) => e.type === "ops")).toHaveLength(0);
    expect(text).toMatch(/offline planner only knows/);
    expect(text).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const slow = createOfflinePlanner({ delayMs: 5 });
    const seen: PlanEvent[] = [];
    const running = slow.run(
      { scene: emptyScene(), prompt: "ten trees", chat: [], selection: [] },
      (e) => {
        seen.push(e);
        controller.abort();
      },
      controller.signal,
    );
    await expect(running).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
