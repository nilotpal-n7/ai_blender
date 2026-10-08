import { describe, expect, it } from "vitest";
import { emptyScene } from "@/scene/types";
import { TOOL_SPECS, ToolError, runTool, toolInputSchema } from "./tools";

const red = { color: "#ff0000" };

describe("runTool", () => {
  it("builds a group with parts from one add_object call", () => {
    const { scene, ops, result } = runTool(emptyScene(), "add_object", {
      id: "table_1",
      name: "Table",
      position: [1, 0, 2],
      parts: [
        { name: "top", primitive: "box", position: [0, 0.72, 0], scale: [1.4, 0.06, 0.8], material: red },
        { name: "leg", primitive: "box", position: [0.6, 0.35, 0.3], scale: [0.07, 0.7, 0.07], material: red },
        { name: "leg", primitive: "box", position: [-0.6, 0.35, 0.3], scale: [0.07, 0.7, 0.07], material: red },
      ],
    });
    expect(ops).toHaveLength(4);
    expect(scene.nodes.table_1).toMatchObject({
      kind: "group",
      parent: null,
      position: [1, 0, 2],
      author: "ai",
    });
    expect(Object.keys(scene.nodes)).toEqual([
      "table_1",
      "table_1__top",
      "table_1__leg",
      "table_1__leg_2",
    ]);
    expect(scene.nodes.table_1__top).toMatchObject({
      kind: "mesh",
      parent: "table_1",
      scale: [1.4, 0.06, 0.8],
    });
    // The model learns the ids it can edit later.
    expect(result).toContain("table_1__leg_2");
  });

  it("fills material defaults and keeps sizes positive", () => {
    const { scene } = runTool(emptyScene(), "add_object", {
      id: "floor",
      name: "Floor",
      position: [0, 0, 0],
      primitive: "plane",
      scale: [4, 0, -3],
      material: red,
    });
    expect(scene.nodes.floor).toMatchObject({
      scale: [4, 0.001, 3],
      material: { color: "#ff0000", roughness: 0.6, metalness: 0, opacity: 1 },
    });
  });

  it("reports problems as ToolError so the model can correct the call", () => {
    const box = { id: "a", name: "A", position: [0, 0, 0], primitive: "box" };
    const scene = runTool(emptyScene(), "add_object", box).scene;
    const fail = (name: string, input: unknown) => {
      try {
        runTool(scene, name, input);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        return (err as Error).message;
      }
      throw new Error("expected the call to fail");
    };
    expect(fail("add_object", box)).toMatch(/already exists/);
    expect(fail("add_object", { ...box, id: "b", position: [0, 0] })).toMatch(/Invalid input/);
    expect(fail("add_object", { ...box, id: "has space" })).toMatch(/Invalid input/);
    expect(fail("add_object", { id: "b", name: "B", position: [0, 0, 0] })).toMatch(
      /no primitive and no parts/,
    );
    expect(fail("update_object", { id: "ghost", position: [0, 0, 0] })).toMatch(
      /No object with id "ghost"/,
    );
    expect(fail("update_object", { id: "a" })).toMatch(/Nothing to change/);
    expect(fail("update_object", { id: "a", light: { intensity: 3 } })).toMatch(/not a light/);
    expect(fail("fly_to_moon", {})).toMatch(/Unknown tool/);
  });

  it("updates, lights, removes and sets the environment", () => {
    let scene = runTool(emptyScene(), "add_object", {
      id: "a",
      name: "A",
      position: [0, 0.5, 0],
      primitive: "box",
    }).scene;
    scene = runTool(scene, "add_light", {
      id: "lamp",
      name: "Lamp",
      type: "spot",
      position: [0, 3, 0],
      intensity: 40,
    }).scene;
    expect(scene.nodes.lamp).toMatchObject({
      kind: "light",
      light: { type: "spot", intensity: 40, angle: 35 },
    });

    scene = runTool(scene, "update_object", { id: "a", material: { metalness: 1 } }).scene;
    expect(scene.nodes.a).toMatchObject({ material: { metalness: 1, color: "#b8bcc8" } });

    scene = runTool(scene, "set_environment", {
      sun: { intensity: 0.2 },
      fog: { color: "#000000", near: 5, far: 30 },
    }).scene;
    expect(scene.environment).toMatchObject({ sun: { intensity: 0.2, elevation: 50 }, fog: { far: 30 } });
    scene = runTool(scene, "set_environment", { fog: null }).scene;
    expect(scene.environment.fog).toBeNull();

    scene = runTool(scene, "remove_objects", { ids: ["a", "lamp"] }).scene;
    expect(scene.nodes).toEqual({});
  });
});

describe("tool schemas", () => {
  it("are plain JSON Schema objects without tuple keywords", () => {
    for (const spec of TOOL_SPECS) {
      const schema = toolInputSchema(spec);
      expect(schema.type).toBe("object");
      expect(schema.$schema).toBeUndefined();
      expect(JSON.stringify(schema)).not.toContain("prefixItems");
    }
    const add = toolInputSchema(TOOL_SPECS[0]) as {
      required: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(add.required).toEqual(["id", "name", "position"]);
    expect(add.properties.scale.description).toMatch(/size in meters/);
  });
});

describe("hard surfaces", () => {
  it("passes bevel, wear and arrays through to parts", () => {
    const { scene } = runTool(emptyScene(), "add_object", {
      id: "vent",
      name: "Vent",
      position: [0, 1, 0],
      parts: [
        { name: "frame", primitive: "box", position: [0, 0, 0], scale: [1, 1, 0.1], bevel: 0.02, material: { ...red, wear: 0.4 } },
        { name: "slat", primitive: "box", position: [0, -0.3, 0.06], scale: [0.8, 0.03, 0.02], material: red, array: { count: 5, step: [0, 0.15, 0] } },
        { name: "bolt", primitive: "cylinder", position: [0.4, 0, 0.06], scale: [0.03, 0.02, 0.03], material: red, array: { count: 1 } },
      ],
    });
    expect(scene.nodes.vent__frame).toMatchObject({ bevel: 0.02, array: null, material: { wear: 0.4 } });
    expect(scene.nodes.vent__slat).toMatchObject({ bevel: 0, array: { count: 5, step: [0, 0.15, 0], turn: [0, 0, 0] } });
    // One copy is no array at all.
    expect(scene.nodes.vent__bolt).toMatchObject({ array: null });
  });

  it("changes and clears an array through update_object", () => {
    let scene = runTool(emptyScene(), "add_object", {
      id: "post", name: "Post", position: [0, 0.5, 0], primitive: "box", bevel: 0.01, array: { count: 3, step: [1, 0, 0] },
    }).scene;
    expect(scene.nodes.post).toMatchObject({ bevel: 0.01, array: { count: 3 } });
    scene = runTool(scene, "update_object", { id: "post", array: { count: 6, turn: [0, 60, 0] } }).scene;
    expect(scene.nodes.post).toMatchObject({ array: { count: 6, step: [0, 0, 0], turn: [0, 60, 0] } });
    scene = runTool(scene, "update_object", { id: "post", array: null }).scene;
    expect(scene.nodes.post).toMatchObject({ array: null, bevel: 0.01 });
  });
});

describe("animation tools", () => {
  const rig = () => {
    let scene = runTool(emptyScene(), "add_object", {
      id: "arm", name: "Arm", position: [0, 1, 0],
      parts: [{ name: "beam", primitive: "box", position: [0.5, 0, 0], scale: [1, 0.1, 0.1], material: red }],
    }).scene;
    scene = runTool(scene, "add_object", {
      id: "hand", name: "Hand", parent: "arm", position: [1, 0, 0],
      parts: [{ name: "palm", primitive: "box", position: [0.1, 0, 0], scale: [0.2, 0.2, 0.1], material: red }],
    }).scene;
    return scene;
  };

  it("keys several properties of a group in one call", () => {
    const { scene, ops, result } = runTool(rig(), "animate", {
      id: "hand",
      rotation: [{ t: 0, value: [0, 0, 0] }, { t: 2, value: [0, 0, 90], ease: "linear" }],
      position: [{ t: 0, value: [1, 0, 0] }],
    });
    expect(ops.map((op) => op.type === "animate" && op.property)).toEqual(["position", "rotation"]);
    expect(scene.clip.tracks.find((t) => t.property === "rotation")!.keys).toEqual([
      { t: 0, value: [0, 0, 0], ease: "smooth" },
      { t: 2, value: [0, 0, 90], ease: "linear" },
    ]);
    expect(result).toBe("Animated hand");
  });

  it("explains keys past the end of the clip, parts that can't move, and empty calls", () => {
    const late = () => runTool(rig(), "animate", { id: "hand", rotation: [{ t: 6, value: [0, 0, 0] }] });
    expect(late).toThrow(ToolError);
    expect(late).toThrow(/past the end of the clip \(4s\).*set_clip/);
    expect(() => runTool(rig(), "animate", { id: "hand__palm", rotation: [{ t: 0, value: [0, 0, 0] }] })).toThrow(
      /Only groups can be animated/,
    );
    expect(() => runTool(rig(), "animate", { id: "hand" })).toThrow(/Nothing to animate/);
  });

  it("sets the clip and refuses to cut off keys", () => {
    let scene = runTool(rig(), "set_clip", { duration: 8, loop: false }).scene;
    expect(scene.clip).toMatchObject({ duration: 8, fps: 24, loop: false });
    scene = runTool(scene, "animate", { id: "arm", rotation: [{ t: 7.5, value: [0, 10, 0] }] }).scene;
    expect(() => runTool(scene, "set_clip", { duration: 5 })).toThrow(/keys as late as 7.5s/);
    expect(() => runTool(scene, "set_clip", {})).toThrow(/Nothing to change/);
  });

  it("places the camera and grades the picture", () => {
    let scene = runTool(emptyScene(), "set_camera", { position: [3, 2, 5], fov: 35 }).scene;
    expect(scene.camera).toEqual({ position: [3, 2, 5], target: [0, 1, 0], fov: 35 });
    expect(() => runTool(scene, "set_camera", {})).toThrow(/Nothing to change/);
    scene = runTool(scene, "set_environment", { grade: { vignette: 0.3 } }).scene;
    expect(scene.environment.grade).toEqual({ bloom: 0.75, vignette: 0.3, saturation: 1, contrast: 0 });
  });
});

describe("taper and rust", () => {
  it("pass through add_object and update_object", () => {
    let scene = runTool(emptyScene(), "add_object", {
      id: "armor",
      name: "Armor",
      position: [0, 1, 0],
      parts: [
        { name: "plate", primitive: "box", position: [0, 0, 0], scale: [1, 1, 0.1], taper: [0.6, 1], material: { ...red, wear: 0.4, rust: 0.2 } },
        { name: "nozzle", primitive: "cylinder", position: [0, 1, 0], scale: [0.2, 0.3, 0.2], taper: [0.7, 0.7], material: red },
        { name: "brick", primitive: "box", position: [0, 2, 0], scale: [1, 1, 1], material: red },
      ],
    }).scene;
    expect(scene.nodes.armor__plate).toMatchObject({ taper: [0.6, 1], material: { wear: 0.4, rust: 0.2 } });
    expect(scene.nodes.armor__nozzle).toMatchObject({ taper: [0.7, 0.7], material: { rust: 0 } });
    expect(scene.nodes.armor__brick).toMatchObject({ taper: [1, 1] });
    scene = runTool(scene, "update_object", { id: "armor__brick", taper: [0.5, 0.5], material: { rust: 0.6 } }).scene;
    expect(scene.nodes.armor__brick).toMatchObject({ taper: [0.5, 0.5], material: { rust: 0.6 } });
    expect(() => runTool(scene, "update_object", { id: "armor", taper: [0.5, 0.5] })).toThrow(/only meshes/);
    expect(() => runTool(scene, "update_object", { id: "armor__brick", taper: [1.5, 1] })).toThrow(ToolError);
  });
});

describe("outlines", () => {
  it("builds lathes and extrudes from outlines in any units", () => {
    const { scene } = runTool(emptyScene(), "add_object", {
      id: "bench",
      name: "Bench",
      position: [0, 0, 0],
      parts: [
        { name: "bottle", primitive: "lathe", position: [0, 0.14, 0], scale: [0.08, 0.28, 0.08], outline: [[0.04, 0], [0.04, 0.16], [0.013, 0.22], [0.013, 0.28]], material: red },
        { name: "bracket", primitive: "extrude", position: [0.3, 0.15, 0], rotation: [90, 0, 0], scale: [0.2, 0.03, 0.3], outline: [[0, 0], [0.2, 0], [0.2, 0.05], [0.05, 0.05], [0.05, 0.3], [0, 0.3]], material: red },
        { name: "knob", primitive: "lathe", position: [0.6, 0.05, 0], scale: [0.1, 0.1, 0.1], material: red },
      ],
    });
    expect(scene.nodes.bench__bottle).toMatchObject({ primitive: "lathe", scale: [0.08, 0.28, 0.08] });
    expect((scene.nodes.bench__bottle as { outline: number[][] }).outline[0]).toEqual([0.5, -0.5]);
    expect((scene.nodes.bench__bracket as { outline: number[][] }).outline).toHaveLength(6);
    // Without an outline it is the stock shape.
    expect(scene.nodes.bench__knob).toMatchObject({ outline: null });
  });

  it("explains a bad outline, and one given to a shape that can't use it", () => {
    const add = (part: object) => () =>
      runTool(emptyScene(), "add_object", { id: "a", name: "A", position: [0, 0, 0], parts: [{ name: "p", position: [0, 0, 0], scale: [1, 1, 1], material: red, ...part }] });
    expect(add({ primitive: "extrude", outline: [[0, 0], [1, 1], [2, 2]] })).toThrow(/outline of "p" can't be used.*enclose some area/);
    expect(add({ primitive: "box", outline: [[0, 0], [1, 0], [1, 1]] })).toThrow(/only a lathe or an extrude takes an outline/);
    expect(add({ primitive: "lathe", outline: [[0.1, 0]] })).toThrow(ToolError);
  });

  it("redraws an existing shape through update_object", () => {
    let scene = runTool(emptyScene(), "add_object", { id: "vase", name: "Vase", position: [0, 0.2, 0], scale: [0.2, 0.4, 0.2], primitive: "lathe" }).scene;
    scene = runTool(scene, "update_object", { id: "vase", outline: [[0.05, 0], [0.1, 0.2], [0.04, 0.4]] }).scene;
    expect((scene.nodes.vase as { outline: number[][] }).outline).toEqual([[0.25, -0.5], [0.5, 0], [0.2, 0.5]]);
    expect(() => runTool(scene, "update_object", { id: "vase", primitive: "box", outline: [[0, 0], [1, 0], [1, 1]] })).toThrow(/only a lathe or an extrude/);
  });
});
