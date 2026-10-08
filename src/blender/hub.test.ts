import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlannerError } from "@/planner/types";
import { blenderGuide, createBridgeBrain, type Brain, type ToolOutcome, type Turn } from "./brain";
import { refuseOutsiders } from "./http";
import { engineSync, engineToken, removeProject, startTurn, stopTurn, studioState, waitForChange } from "./hub";
import { createProject, listProjects, projectDir, servedFile } from "./projects";
import type { EngineMode, Job, JobResult, StudioState } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ORIGIN = "http://localhost:3000";

let dir: string;
const engines: { stop(): void }[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ai-blender-hub-"));
  process.env.DATA_DIR = dir;
});
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.stop();
  delete process.env.DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** Stands in for Blender: asks the hub for jobs and answers them. */
function fakeEngine(project: string, mode: EngineMode = "headless") {
  const abort = new AbortController();
  const jobs: Job[] = [];
  const finished = (async () => {
    const token = await engineToken();
    let done: JobResult | undefined;
    while (!abort.signal.aborted) {
      const reply = await engineSync({ project, engine: `fake-${mode}`, token, mode, version: "test", done }, abort.signal);
      done = undefined;
      if (reply.gone) return "gone";
      const job = reply.job;
      if (!job) continue;
      jobs.push(job);
      const files: string[] = [];
      if (job.kind === "look") files.push(job.out);
      if (job.kind === "save") files.push(job.glb);
      for (const file of files) await writeFile(file, job.kind);
      const broken = job.kind === "python" && job.code.includes("boom");
      done = {
        job: job.id,
        ok: !broken,
        output: job.kind === "python" ? "ran" : "shows what was asked",
        error: broken ? "NameError: name 'boom' is not defined" : null,
        files,
        summary: { objects: [], jobs: jobs.length },
      };
    }
    return "stopped";
  })();
  const engine = { jobs, finished, stop: () => abort.abort() };
  engines.push(engine);
  return engine;
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error("Waited too long.");
}

/** The project once an engine is connected and nothing is running. */
async function settled(id: string): Promise<StudioState> {
  await until(async () => !(await studioState(id)).busy);
  return studioState(id);
}

async function ready(mode: EngineMode = "headless") {
  const project = await createProject();
  const engine = fakeEngine(project.id, mode);
  await until(async () => (await studioState(project.id)).engine === mode);
  return { id: project.id, engine };
}

const brain = (run: (turn: Turn) => Promise<void>): Brain => ({ name: "test", run });

describe("a turn in Blender", () => {
  it("runs the brain's tools in the engine, saves, and records the reply", async () => {
    const { id, engine } = await ready();
    const outcomes: ToolOutcome[] = [];
    let scene: unknown;
    const builder = brain(async (turn) => {
      expect(turn.prompt).toBe("a lantern on a crate");
      expect(turn.scene).toEqual({ objects: [], jobs: 1 });
      outcomes.push(await turn.call("python", { code: "print(1)" }));
      outcomes.push(await turn.call("python", { code: "boom" }));
      outcomes.push(await turn.call("look", { views: ["front", "top"] }));
      outcomes.push(await turn.call("look", { views: ["sideways"] }));
      outcomes.push(await turn.call("paint", {}));
      turn.say("Built a lantern.");
      scene = await turn.checkpoint();
    });

    await startTurn(id, "a lantern on a crate", "blender", ORIGIN, builder);
    await expect(startTurn(id, "and another", "web", ORIGIN, builder)).rejects.toThrow(/still working/);
    const state = await settled(id);

    expect(state.project.name).toBe("A lantern on a crate");
    expect(state.project.chat).toMatchObject([
      { role: "user", text: "a lantern on a crate", from: "blender" },
      { role: "assistant", text: "Built a lantern.", steps: 5, planner: "test" },
    ]);
    expect(state.project.chat[1].error).toBeUndefined();
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true, false, false]);
    expect(outcomes[0].message).toBe("ran");
    expect(outcomes[1].message).toContain("NameError");
    expect(outcomes[3].message).toMatch(/Invalid input for look/);
    expect(outcomes[4].message).toMatch(/no tool "paint"/);

    // The look's picture is what the page shows next, and only a known file is served.
    expect(state.project.image).toMatch(/^looks\/[a-z0-9]+\.png$/);
    expect(outcomes[2].images).toEqual([servedFile(id, state.project.image!)]);
    expect(servedFile(id, "../project.json")).toBeNull();

    // Invalid calls never reach Blender; a save follows the work.
    expect(engine.jobs.map((job) => job.kind)).toEqual(["python", "python", "python", "look", "save"]);
    expect(engine.jobs[3]).toMatchObject({ views: ["front", "top"], shading: "clay", size: [640, 480] });
    expect(scene).toEqual({ objects: [], jobs: 5 });
    expect(state.project.model).toBeGreaterThan(0);
    expect(await readFile(path.join(projectDir(id), "model.glb"), "utf8")).toBe("save");
    expect(await readdir(projectDir(id))).not.toContain("model.next.glb");
  });

  it("stops after the current step and keeps what was built", async () => {
    const { id, engine } = await ready();
    await startTurn(
      id,
      "a tower",
      "web",
      ORIGIN,
      brain(async (turn) => {
        await turn.call("python", { code: "first()" });
        stopTurn(id);
        await turn.call("python", { code: "second()" });
      }),
    );
    const state = await settled(id);
    expect(state.project.chat[1]).toMatchObject({ role: "assistant", error: "Stopped.", steps: 1 });
    expect(engine.jobs.map((job) => job.kind)).toEqual(["python", "python", "save"]);
  });

  it("shows a failure the person can act on, and hides one they can't", async () => {
    const { id } = await ready();
    await startTurn(id, "one", "web", ORIGIN, brain(async () => {
      throw new PlannerError("No reply from the session.");
    }));
    expect((await settled(id)).project.chat.at(-1)).toMatchObject({ text: "", error: "No reply from the session." });
    await startTurn(id, "two", "web", ORIGIN, brain(async () => {
      throw new TypeError("x is undefined");
    }));
    expect((await settled(id)).project.chat.at(-1)!.error).toBe("The co-pilot failed unexpectedly.");
  });

  it("tells a waiting page as soon as something changes", async () => {
    const { id } = await ready();
    const { rev } = await studioState(id);
    const abort = new AbortController();
    let woke = false;
    const waiting = waitForChange(id, rev, abort.signal).then(() => (woke = true));
    await sleep(20);
    expect(woke).toBe(false);
    await startTurn(id, "a cube", "web", ORIGIN, brain(async () => undefined));
    await waiting;
    expect((await settled(id)).rev).toBeGreaterThan(rev);
    // Someone already behind is answered at once.
    await waitForChange(id, rev, abort.signal);
  });
});

describe("engines", () => {
  it("only accepts a Blender that knows the token", async () => {
    const project = await createProject();
    const sync = { project: project.id, engine: "intruder", token: "guess", mode: "headless" as const, version: "x" };
    await expect(engineSync(sync, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect((await studioState(project.id)).engine).toBe("off");
  });

  it("lets a Blender with a window take over from one without", async () => {
    const { id, engine: windowless } = await ready("headless");
    fakeEngine(id, "ui");
    expect(await windowless.finished).toBe("gone");
    expect((await studioState(id)).engine).toBe("ui");
    // And a windowless one can't take it back while the window is there.
    expect(await fakeEngine(id, "headless").finished).toBe("gone");
  });

  it("forgets a deleted project", async () => {
    const { id, engine } = await ready();
    await removeProject(id);
    expect(engine.jobs.map((job) => job.kind)).toEqual(["quit"]);
    expect(await listProjects()).toEqual([]);
    await expect(studioState(id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("the studio's routes", () => {
  const from = (host: string, origin?: string) =>
    refuseOutsiders({ headers: new Headers({ host, ...(origin ? { origin } : {}) }) } as Request);

  it("answer this computer and nobody else", () => {
    expect(from("localhost:3000")).toBeNull();
    expect(from("127.0.0.1:3000", "http://127.0.0.1:3000")).toBeNull();
    expect(from("192.168.1.20:3000")?.status).toBe(403);
    // A page on another site, or one whose name was pointed at this machine.
    expect(from("localhost:3000", "https://example.com")?.status).toBe(403);
    expect(from("evil.example:3000", "http://evil.example:3000")?.status).toBe(403);
  });
});

describe("a Claude Code session as the brain", () => {
  it("passes calls to Blender and writes back what they did", async () => {
    const bridge = path.join(dir, "bridge");
    const calls: [string, unknown][] = [];
    const said: string[] = [];
    const finished = createBridgeBrain({ dir: bridge, timeoutMs: 5000, pollMs: 5, stepDelayMs: 0 }).run({
      prompt: "a teapot",
      history: [{ role: "user", text: "earlier" }],
      scene: { objects: [] },
      async call(tool, input) {
        calls.push([tool, input]);
        return tool === "look"
          ? { ok: true, message: "shows front", images: ["C:/looks/1.png"] }
          : { ok: false, message: "SyntaxError", images: [] };
      },
      checkpoint: async () => ({ objects: [{ name: "Teapot" }] }),
      say: (delta) => said.push(delta),
      status: () => undefined,
      signal: new AbortController().signal,
    });

    let folder = "";
    await until(async () => {
      const names = (await readdir(bridge).catch(() => [] as string[])).filter((n) => !n.includes("."));
      folder = names[0] ? path.join(bridge, names[0]) : "";
      return folder !== "";
    });
    // Retried, because a file can be seen before it has been written in full.
    const read = async (name: string) => {
      let parsed: unknown;
      await until(async () => {
        parsed = await readFile(path.join(folder, name), "utf8").then(JSON.parse, () => undefined);
        return parsed !== undefined;
      });
      return parsed;
    };
    expect(await read("request.json")).toMatchObject({
      kind: "blender",
      guide: "GUIDE-blender.md",
      prompt: "a teapot",
      scene: { objects: [] },
    });
    expect(await readFile(path.join(bridge, "GUIDE-blender.md"), "utf8")).toBe(blenderGuide());

    await writeFile(
      path.join(folder, "reply-1.json"),
      JSON.stringify({
        calls: [{ tool: "python", input: { code: "(" } }, { tool: "look", input: {} }],
        text: "A teapot.",
        done: true,
      }),
    );
    await finished;
    expect(calls).toEqual([["python", { code: "(" }], ["look", {}]]);
    expect(said).toEqual(["A teapot."]);
    expect(await read("result-1.json")).toEqual({
      reply: 1,
      results: [
        { tool: "python", ok: false, message: "SyntaxError", images: [] },
        { tool: "look", ok: true, message: "shows front", images: ["C:/looks/1.png"] },
      ],
      failed: 1,
      verbose: true,
      scene: { objects: [{ name: "Teapot" }] },
      closed: true,
    });
  });
});
