import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { applyOps } from "@/scene/ops";
import { emptyScene } from "@/scene/types";
import { createClaudePlanner, type MessagesApi, type PlannerStream } from "./claude";
import { PlannerError, type PlanEvent, type PlanInput } from "./types";

type Message = Anthropic.Beta.BetaMessage;
type Block = Anthropic.Beta.BetaContentBlock;
type Body = Parameters<MessagesApi["stream"]>[0];

/** One scripted model reply: content blocks in order, then a stop reason. */
interface Reply {
  blocks: ({ text: string } | { tool: string; input: unknown })[];
  stop: Message["stop_reason"];
}

/** Stands in for the SDK: replays scripted replies and records what was sent. */
function scripted(replies: Reply[]) {
  const requests: Body[] = [];
  let toolCount = 0;
  const api: MessagesApi = {
    stream(body) {
      requests.push(structuredClone(body));
      const reply = replies[requests.length - 1];
      const listeners: Record<string, ((arg: never) => void)[]> = {};
      const fire = (event: string, arg: unknown) =>
        listeners[event]?.forEach((listener) => (listener as (a: unknown) => void)(arg));
      const stream: PlannerStream = {
        on(event: string, listener: (arg: never) => void) {
          (listeners[event] ??= []).push(listener);
          return stream;
        },
        async finalMessage() {
          const content = reply.blocks.map((block) => {
            if ("text" in block) {
              fire("text", block.text);
              return { type: "text", text: block.text, citations: null } as Block;
            }
            const use = { type: "tool_use", id: "toolu_" + ++toolCount, name: block.tool, input: block.input } as Block;
            fire("contentBlock", use);
            return use;
          });
          return {
            content,
            stop_reason: reply.stop,
            usage: { input_tokens: 100, output_tokens: 20 },
          } as unknown as Message;
        },
      };
      return stream;
    },
  };
  return { api, requests };
}

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  scene: emptyScene(),
  prompt: "a red box",
  chat: [],
  selection: [],
  ...overrides,
});

async function run(replies: Reply[], planInput = input()) {
  const { api, requests } = scripted(replies);
  const planner = createClaudePlanner(api, { model: "claude-opus-5-5", effort: "medium" });
  const events: PlanEvent[] = [];
  const outcome = await planner
    .run(planInput, (e) => events.push(e), new AbortController().signal)
    .then((usage) => ({ usage }), (error: unknown) => ({ error }));
  let scene = planInput.scene;
  for (const event of events) if (event.type === "ops") scene = applyOps(scene, event.ops).scene;
  const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  return { ...outcome, requests, events, scene, text } as {
    usage?: { inputTokens: number; outputTokens: number };
    error?: unknown;
    requests: Body[];
    events: PlanEvent[];
    scene: typeof planInput.scene;
    text: string;
  };
}

const box = (id: string) => ({
  tool: "add_object",
  input: { id, name: id, position: [0, 0.5, 0], primitive: "box", material: { color: "#ff0000" } },
});
const toolResults = (body: Body) => {
  const last = body.messages[body.messages.length - 1];
  return last.content as Anthropic.Beta.BetaToolResultBlockParam[];
};

describe("claude planner", () => {
  it("applies tool calls, returns their results, and finishes on the model's summary", async () => {
    const result = await run([
      { blocks: [box("crate"), { tool: "update_object", input: { id: "ghost", visible: false } }], stop: "tool_use" },
      { blocks: [{ text: "Added a red crate." }], stop: "end_turn" },
    ]);

    expect(result.error).toBeUndefined();
    expect(Object.keys(result.scene.nodes)).toEqual(["crate"]);
    expect(result.text).toBe("Added a red crate.");
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });

    // Round two carries the assistant turn plus one result per call, in order.
    expect(result.requests).toHaveLength(2);
    const [ok, failed] = toolResults(result.requests[1]);
    expect(ok).toMatchObject({ tool_use_id: "toolu_1", content: "Added crate" });
    expect(ok.is_error).toBeUndefined();
    expect(failed).toMatchObject({ tool_use_id: "toolu_2", is_error: true });
    expect(failed.content).toMatch(/No object with id "ghost"/);
  });

  it("sends the scene, selection and request, with history ahead of them", async () => {
    const scene = applyOps(emptyScene(), [
      {
        type: "add",
        node: {
          id: "rug", name: "Rug", parent: null, kind: "group", blend: 0, visible: true, author: "user",
          position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pinned: ["position"],
        },
      },
    ]).scene;
    const { requests } = await run(
      [{ blocks: [{ text: "Done." }], stop: "end_turn" }],
      input({
        scene,
        prompt: "make it bigger",
        selection: ["rug"],
        chat: [
          { role: "assistant", text: "orphaned reply" },
          { role: "user", text: "a rug" },
          { role: "assistant", text: "Added a rug." },
          { role: "assistant", text: "" },
        ],
      }),
    );
    const body = requests[0];
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(body.tools?.map((t) => "name" in t && t.name)).toEqual([
      "add_object", "add_light", "update_object", "remove_objects", "set_environment",
      "animate", "set_clip", "set_camera",
    ]);
    // History starts at a user message and drops empty turns.
    expect(body.messages.slice(0, 2)).toEqual([
      { role: "user", content: "a rug" },
      { role: "assistant", content: "Added a rug." },
    ]);
    const request = body.messages[2].content as string;
    expect(request).toContain('"pinned":["position"]');
    expect(request).toContain('"createdBy":"user"');
    expect(request).toContain('<selection>["rug"]</selection>');
    expect(request).toContain("<request>\nmake it bigger\n</request>");
  });

  it("does not run a call that was cut off by the output limit, and asks for it again", async () => {
    const result = await run([
      { blocks: [box("one"), box("two")], stop: "max_tokens" },
      { blocks: [box("two")], stop: "tool_use" },
      { blocks: [{ text: "Two boxes." }], stop: "end_turn" },
    ]);
    const [first, second] = toolResults(result.requests[1]);
    expect(first.is_error).toBeUndefined();
    expect(second).toMatchObject({ is_error: true });
    expect(second.content).toMatch(/cut off/);
    expect(Object.keys(result.scene.nodes)).toEqual(["one", "two"]);
  });

  it("separates text from different rounds", async () => {
    const result = await run([
      { blocks: [{ text: "Starting." }, box("a")], stop: "tool_use" },
      { blocks: [{ text: "Finished." }], stop: "end_turn" },
    ]);
    expect(result.text).toBe("Starting.\n\nFinished.");
  });

  it("reports a refusal without running that turn's calls", async () => {
    const result = await run([{ blocks: [box("a")], stop: "refusal" }]);
    expect(result.error).toBeInstanceOf(PlannerError);
    expect((result.error as Error).message).toMatch(/declined/);
    expect(result.scene.nodes).toEqual({});
  });

  it("gives up after a bounded number of rounds, keeping what was built", async () => {
    const replies = Array.from({ length: 20 }, (_, i): Reply => ({ blocks: [box("b" + i)], stop: "tool_use" }));
    const result = await run(replies);
    expect((result.error as Error).message).toMatch(/Stopped after 12 rounds/);
    expect(result.requests).toHaveLength(12);
    expect(Object.keys(result.scene.nodes)).toHaveLength(12);
  });
});
