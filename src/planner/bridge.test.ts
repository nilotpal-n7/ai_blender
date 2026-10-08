import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps } from "@/scene/ops";
import { emptyScene, type Scene } from "@/scene/types";
import { bridgeGuide, createBridgePlanner, type BridgeOptions } from "./bridge";
import { PlannerError, type PlanEvent } from "./types";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ai-blender-bridge-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const options = (overrides: Partial<BridgeOptions> = {}): BridgeOptions => ({
  dir,
  timeoutMs: 5000,
  pollMs: 5,
  stepDelayMs: 0,
  ...overrides,
});

const box = (id: string) => ({
  tool: "add_object",
  input: { id, name: id, position: [0, 0.5, 0], primitive: "box" },
});

/** Starts a request the way the app does and exposes what a session would see. */
function start(prompt = "a box", overrides: Partial<BridgeOptions> = {}, scene: Scene = emptyScene()) {
  const events: PlanEvent[] = [];
  const controller = new AbortController();
  // Folders from earlier requests in the same test are not this request's.
  const earlier = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const finished = createBridgePlanner(options(overrides))
    .run({ scene, prompt, chat: [{ role: "user", text: "earlier" }], selection: [] }, (e) => events.push(e), controller.signal)
    .then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error }),
    );

  const folder = async () => {
    for (;;) {
      const names = (await readdir(dir).catch(() => [] as string[])).filter(
        (n) => !earlier.has(n) && n !== "GUIDE.md" && n !== "listener.json",
      );
      if (names.length > 0) return path.join(dir, names[0]);
      await sleep(5);
    }
  };
  const read = async (name: string) => {
    const file = path.join(await folder(), name);
    for (;;) {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch {
        await sleep(5);
      }
    }
  };
  const reply = async (n: number, body: unknown) =>
    writeFile(path.join(await folder(), `reply-${n}.json`), typeof body === "string" ? body : JSON.stringify(body));
  const built = () => {
    let result = scene;
    for (const event of events) if (event.type === "ops") result = applyOps(result, event.ops).scene;
    return result;
  };
  const text = () => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  const notes = () => events.flatMap((e) => (e.type === "thinking" ? [e.delta] : [])).join("");
  /** Resolves once a status note matching `pattern` has been emitted. */
  const notesMatching = async (pattern: RegExp) => {
    while (!pattern.test(notes())) await sleep(5);
  };
  return {
    notesMatching, finished, folder, read, reply, built, text, notes, abort: () => controller.abort(), events };
}

describe("bridge planner", () => {
  it("hands over the request, applies the reply, and reports each call", async () => {
    const session = start("a box on the floor");

    const request = await session.read("request.json");
    expect(request).toMatchObject({
      prompt: "a box on the floor",
      selection: [],
      history: [{ role: "user", text: "earlier" }],
      scene: { objects: [] },
    });
    expect(request.expiresAt).toBeGreaterThan(request.createdAt);

    await session.reply(1, { calls: [box("crate"), box("barrel")], text: "Added two boxes.", done: true });
    expect((await session.finished).error).toBeUndefined();

    expect(Object.keys(session.built().nodes)).toEqual(["crate", "barrel"]);
    expect(session.text()).toBe("Added two boxes.");
    expect(await session.read("result-1.json")).toEqual({
      reply: 1,
      results: [
        { tool: "add_object", ok: true, message: "Added crate" },
        { tool: "add_object", ok: true, message: "Added barrel" },
      ],
      failed: 0,
      closed: true,
    });
    expect(await session.read("closed.json")).toMatchObject({ reason: "done" });
  });

  it("stays open across replies so a failed call can be corrected", async () => {
    const session = start();
    await session.reply(1, {
      calls: [box("a"), { tool: "update_object", input: { id: "ghost", visible: false } }, box("b")],
    });
    const first = await session.read("result-1.json");
    expect(first).toMatchObject({ failed: 1, closed: false });
    expect(first.results[1]).toMatchObject({ ok: false });
    expect(first.results[1].message).toMatch(/No object with id "ghost"/);
    // The calls around the failed one still ran.
    expect(Object.keys(session.built().nodes)).toEqual(["a", "b"]);

    await session.reply(2, { calls: [{ tool: "update_object", input: { id: "a", visible: false } }], text: "Done.", done: true });
    await session.finished;
    expect(session.built().nodes.a.visible).toBe(false);
    expect(await session.read("result-2.json")).toMatchObject({ failed: 0, closed: true });
  });

  it("rejects a malformed reply and accepts the next one", async () => {
    const session = start();
    await session.reply(1, { calls: "all of them" });
    expect((await session.read("result-1.json")).error).toMatch(/Not a valid reply/);

    // A misspelled key is an error, not a reply that quietly does nothing.
    await session.reply(2, { call: [box("typo")], done: true });
    expect((await session.read("result-2.json")).error).toMatch(/Not a valid reply/);

    await session.reply(3, "{ this is not json");
    expect((await session.read("result-3.json")).error).toMatch(/not valid JSON/);

    await session.reply(4, { calls: [box("ok")], done: true });
    expect((await session.finished).error).toBeUndefined();
    expect(Object.keys(session.built().nodes)).toEqual(["ok"]);
  });

  it("tells the user whether a session is listening, and when one takes the request", async () => {
    const nobody = start();
    await nobody.notesMatching(/No Claude Code session is listening yet/);
    nobody.abort();
    await nobody.finished;

    await writeFile(path.join(dir, "listener.json"), JSON.stringify({ at: Date.now() }));
    const session = start();
    await session.notesMatching(/Waiting for the Claude Code session/);
    await writeFile(path.join(await session.folder(), "claimed.json"), "{}");
    await session.notesMatching(/has it and is working on it/);
    await session.reply(1, { done: true });
    expect((await session.finished).error).toBeUndefined();
  });

  it("gives up with an explanation when nobody answers", async () => {
    const session = start("hello?", { timeoutMs: 40 });
    const { error } = await session.finished;
    expect(error).toBeInstanceOf(PlannerError);
    expect((error as Error).message).toMatch(/No reply from the Claude Code session/);
    expect(await session.read("closed.json")).toMatchObject({ reason: "timeout" });
  });

  it("closes the request when the user stops it", async () => {
    const session = start();
    await session.read("request.json");
    session.abort();
    expect((await session.finished).error).toBeDefined();
    expect(await session.read("closed.json")).toMatchObject({ reason: "stopped" });
  });

  it("writes a guide that covers the protocol, the planning rules and every tool", () => {
    const guide = bridgeGuide();
    expect(guide).toContain("node scripts/bridge.mjs listen");
    expect(guide).toContain("## How to plan a scene");
    for (const tool of ["add_object", "add_light", "update_object", "remove_objects", "set_environment"]) {
      expect(guide).toContain(`### ${tool}`);
    }
  });
});

describe("bridge CLI", () => {
  const cli = (...args: string[]) =>
    run(process.execPath, [path.join(process.cwd(), "scripts", "bridge.mjs"), ...args], {
      // The CLI appends "bridge" to DATA_DIR, as the app does.
      env: { ...process.env, DATA_DIR: path.dirname(dir) },
    }).then((r) => r.stdout);

  beforeEach(async () => {
    // Give the CLI a DATA_DIR whose "bridge" folder is this test's folder.
    await rm(dir, { recursive: true, force: true });
    dir = path.join(await mkdtemp(path.join(tmpdir(), "ai-blender-data-")), "bridge");
  });
  afterEach(async () => {
    await rm(path.dirname(dir), { recursive: true, force: true });
  });

  it("listens for a request, claims it, and reports the result of a reply", async () => {
    const listening = cli("listen", "--timeout", "20");
    // Wait for the listener's first heartbeat, however long the process takes to start.
    while (!existsSync(path.join(dir, "listener.json"))) await sleep(20);
    const session = start("a red box");

    const printed = await listening;
    const request = await session.read("request.json");
    expect(printed).toContain(`SCENE REQUEST ${request.id}`);
    expect(printed).toContain("prompt: a red box");
    expect(printed).toContain('scene: {"environment"');
    expect(printed).toContain(`bridge/${request.id}/reply-1.json`);
    expect(await session.read("claimed.json")).toHaveProperty("pid");
    await session.notesMatching(/Waiting for the Claude Code session/);

    // A second listener must not pick up a request that is already taken.
    expect(await cli("listen", "--timeout", "1")).toMatch(/No scene requests/);

    await session.reply(1, { calls: [box("a"), box("a")] });
    const first = await cli("result", request.id, "1");
    expect(first).toContain("reply 1: 1 applied, 1 failed");
    expect(first).toMatch(/FAILED add_object: An object with id "a" already exists/);
    expect(first).toContain("continue with reply-2.json");

    await session.reply(2, { text: "One box.", done: true });
    expect(await cli("result", request.id, "2")).toContain("The request is finished.");
    expect((await session.finished).error).toBeUndefined();
  }, 30_000);

  it("ignores requests that expired before anyone listened", async () => {
    const session = start("too late", { timeoutMs: 30 });
    await session.finished;
    expect(await cli("listen", "--timeout", "1")).toMatch(/No scene requests/);
  }, 15_000);

  it("says so when a request ended before the reply was applied", async () => {
    const session = start();
    const request = await session.read("request.json");
    session.abort();
    await session.finished;
    expect(await cli("result", request.id, "1")).toContain("ended before this reply was applied (stopped)");
  }, 15_000);
});
