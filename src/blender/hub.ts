/**
 * The hub between the app and Blender.
 *
 * Each project's scene lives in a Blender process running `blender/engine.py`:
 * one with a window when the person wants to watch and work there, otherwise
 * one without. The engine keeps a request open to `/api/engine`; the hub
 * answers it with the next job (run this Python, render a look, save) and gets
 * the result with the engine's next request.
 *
 * A turn of the conversation runs here, not in the request that started it, so
 * the web page and Blender's sidebar can both start one and both watch it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PlannerError } from "@/planner/types";
import { createBrain, type Brain, type ToolOutcome } from "./brain";
import { blenderDir, deleteProject, loadProject, projectDir, saveProject } from "./projects";
import { BLENDER_TOOLS, LookInput, PythonInput } from "./tools";
import {
  StudioError,
  type EngineMode,
  type EngineSync,
  type Job,
  type JobResult,
  type JobSpec,
  type Message,
  type Project,
  type StudioState,
} from "./types";

/** How long a request from the engine or a page is held open waiting for news. */
const HOLD_MS = 20_000;
/** An engine that hasn't asked for work for this long is taken to be gone. */
const ENGINE_FRESH_MS = 10_000;
const START_TIMEOUT_MS = 120_000;
const JOB_TIMEOUT_MS = 10 * 60_000;
const RENDER_TIMEOUT_MS = 60 * 60_000;
const ANIMATION_TIMEOUT_MS = 24 * 60 * 60_000;

interface Waiting {
  resolve(result: JobResult): void;
  reject(err: Error): void;
}

interface Engine {
  id: string;
  mode: EngineMode;
  seenAt: number;
  /** A request from it is open, waiting for a job. */
  polling: boolean;
  /** The job it is doing. */
  working: string | null;
}

interface ActiveTurn {
  abort: AbortController;
  status: string;
  live: string;
  steps: number;
}

interface Runtime {
  /** The project as last read or written, so that showing it doesn't read the disk. */
  project: Project | null;
  rev: number;
  listeners: Set<() => void>;
  engine: Engine | null;
  queue: Job[];
  waiting: Map<string, Waiting>;
  /** Answers the engine's open request: a job has arrived, or the engine was replaced. */
  wake: (() => void) | null;
  starting: Promise<void> | null;
  turn: ActiveTurn | null;
  /** Work that isn't a conversation turn, such as a render. */
  task: string | null;
  /** The person asked for that work to stop. */
  stopTask: boolean;
  writes: Promise<unknown>;
  /** Where the engine reaches this app. */
  origin: string;
}

interface Hub {
  token: Promise<string> | null;
  projects: Map<string, Runtime>;
}

// On globalThis so every route, and every reload in development, shares one hub.
const hub = ((globalThis as { __aiBlenderHub?: Hub }).__aiBlenderHub ??= {
  token: null,
  projects: new Map(),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uid = () => randomBytes(6).toString("hex");
const exists = (file: string) => access(file).then(() => true, () => false);

function runtime(id: string): Runtime {
  let rt = hub.projects.get(id);
  if (!rt) {
    rt = {
      project: null,
      // Starts from the clock so that a page from before a restart sees a change.
      rev: Date.now(),
      listeners: new Set(),
      engine: null,
      queue: [],
      waiting: new Map(),
      wake: null,
      starting: null,
      turn: null,
      task: null,
      stopTask: false,
      writes: Promise.resolve(),
      origin: "http://localhost:3000",
    };
    hub.projects.set(id, rt);
  }
  return rt;
}

function touch(rt: Runtime): void {
  rt.rev++;
  for (const listener of [...rt.listeners]) listener();
}

function alive(rt: Runtime): boolean {
  const engine = rt.engine;
  return Boolean(engine && (engine.polling || engine.working || Date.now() - engine.seenAt < ENGINE_FRESH_MS));
}

/** Only a Blender this app started may take jobs: they are code to run. */
export function engineToken(): Promise<string> {
  return (hub.token ??= (async () => {
    const file = path.join(blenderDir(), "engine-token");
    try {
      return (await readFile(file, "utf8")).trim();
    } catch {
      const token = randomBytes(24).toString("hex");
      await mkdir(blenderDir(), { recursive: true });
      await writeFile(file, token, "utf8");
      return token;
    }
  })());
}

/** The project, read from disk the first time. Rejects with a 404 when there is none. */
async function current(id: string): Promise<Project> {
  const known = hub.projects.get(id)?.project;
  if (known) return known;
  const project = await loadProject(id);
  return (runtime(id).project ??= project);
}

/** Changes the stored project. Changes are applied one at a time. */
function updateProject(id: string, change: (project: Project) => void): Promise<Project> {
  const rt = runtime(id);
  const next = rt.writes.then(async () => {
    const project = structuredClone(await current(id));
    change(project);
    project.updatedAt = Date.now();
    await saveProject(project);
    rt.project = project;
    touch(rt);
    return project;
  });
  rt.writes = next.catch(() => undefined);
  return next;
}

// ─── What the page and the sidebar read ─────────────────────────────

export async function studioState(id: string): Promise<StudioState> {
  const project = await current(id);
  const rt = runtime(id);
  return {
    project,
    busy: Boolean(rt.turn || rt.task),
    status: rt.turn?.status ?? rt.task ?? "",
    live: rt.turn?.live ?? "",
    engine: alive(rt) ? rt.engine!.mode : "off",
    rev: rt.rev,
  };
}

/** Resolves when the project's state is no longer at `rev`, or after a while regardless. */
export function waitForChange(id: string, rev: number, signal: AbortSignal): Promise<void> {
  const rt = runtime(id);
  if (rt.rev !== rev || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      rt.listeners.delete(done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, HOLD_MS);
    rt.listeners.add(done);
    signal.addEventListener("abort", done);
  });
}

// ─── The engine's side ──────────────────────────────────────────────

function failJobs(rt: Runtime, message: string): void {
  for (const waiting of [...rt.waiting.values()]) waiting.reject(new StudioError(message, 502));
}

/**
 * One request from an engine: it reports the job it finished, if any, and is
 * answered with the next one, or with nothing after a while so it asks again.
 */
export async function engineSync(
  input: EngineSync,
  signal: AbortSignal,
): Promise<{ job?: Job; gone?: true; cancel?: true }> {
  if (input.token !== (await engineToken())) throw new StudioError("Unknown engine.", 403);
  await current(input.project);
  const rt = runtime(input.project);

  if (input.progress) {
    // A word from the middle of a job, not a request for the next one.
    if (rt.engine?.id === input.engine) rt.engine.seenAt = Date.now();
    if (rt.stopTask) return { cancel: true };
    if (rt.task && rt.task !== input.progress.text) {
      rt.task = input.progress.text;
      touch(rt);
    }
    return {};
  }

  if (input.done) {
    if (rt.engine?.working === input.done.job) rt.engine.working = null;
    rt.waiting.get(input.done.job)?.resolve(input.done);
  }
  if (input.bye) {
    if (rt.engine?.id === input.engine) {
      rt.engine = null;
      touch(rt);
    }
    return {};
  }

  if (rt.engine?.id !== input.engine) {
    // A Blender with a window outranks one without: the person is looking at it.
    if (rt.engine && alive(rt) && rt.engine.mode === "ui" && input.mode === "headless") return { gone: true };
    if (rt.engine?.working) failJobs(rt, "The Blender doing this was replaced by another.");
    rt.engine = { id: input.engine, mode: input.mode, seenAt: Date.now(), polling: false, working: null };
    rt.wake?.();
    touch(rt);
  }
  const engine = rt.engine;
  engine.seenAt = Date.now();
  engine.polling = true;
  try {
    if (rt.queue.length === 0) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          if (rt.wake === finish) rt.wake = null;
          resolve();
        };
        const timer = setTimeout(finish, HOLD_MS);
        signal.addEventListener("abort", finish);
        rt.wake = finish;
      });
      if (rt.engine !== engine) return { gone: true };
      // The engine hung up: a job handed to it now would be lost.
      if (signal.aborted) return {};
    }
    const job = rt.queue.shift();
    if (job) engine.working = job.id;
    return job ? { job } : {};
  } finally {
    engine.polling = false;
    engine.seenAt = Date.now();
  }
}

// ─── Starting Blender ───────────────────────────────────────────────

async function findBlender(): Promise<string> {
  if (process.env.BLENDER_PATH) return process.env.BLENDER_PATH;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      const dir = path.join(root, "Blender Foundation");
      const versions = await readdir(dir).catch(() => [] as string[]);
      // Newest first: "Blender 5.2" sorts after "Blender 4.5".
      for (const name of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        candidates.push(path.join(dir, name, "blender.exe"));
      }
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Blender.app/Contents/MacOS/Blender");
  }
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return "blender";
}

/** Starts a Blender on the project and resolves once it has asked for work. */
async function start(id: string, mode: EngineMode): Promise<void> {
  const rt = runtime(id);
  const dir = projectDir(id);
  const blend = path.join(dir, "scene.blend");
  const hasFile = await exists(blend);
  const args = [
    ...(mode === "headless" ? ["-b", "--factory-startup"] : []),
    ...(hasFile ? [blend] : []),
    "--python",
    path.join(process.cwd(), "blender", "engine.py"),
    "--",
    "--server",
    rt.origin,
    "--project",
    id,
    "--blend",
    blend,
    "--assets",
    path.join(blenderDir(), "assets"),
    ...(hasFile ? [] : ["--fresh"]),
  ];
  const env = { ...process.env, AI_BLENDER_TOKEN: await engineToken() };
  const exe = await findBlender();
  await mkdir(dir, { recursive: true });

  let child: ChildProcess;
  if (mode === "headless") {
    const log = await open(path.join(dir, "engine.log"), "a");
    child = spawn(exe, args, { env, stdio: ["ignore", log.fd, log.fd], windowsHide: true });
    child.once("close", () => void log.close().catch(() => undefined));
  } else {
    // A window the person owns: it outlives this server.
    child = spawn(exe, args, { env, stdio: "ignore", detached: true });
    child.unref();
  }
  let failure: string | null = null;
  child.once("error", () => {
    failure = "Blender could not be started. Install it, or set BLENDER_PATH in .env.local to its executable.";
  });
  child.once("exit", () => {
    failure ??= "Blender closed before it connected. The project's engine.log may say why.";
    if (rt.engine?.mode === mode) {
      rt.engine = null;
      failJobs(rt, "Blender was closed.");
      touch(rt);
    }
  });

  const since = Date.now();
  rt.engine = null;
  const connected = () => runtime(id).engine?.mode === mode;
  while (!connected()) {
    if (failure) throw new StudioError(failure, 502);
    if (Date.now() - since > START_TIMEOUT_MS) throw new StudioError("Blender did not connect in time.", 504);
    await sleep(150);
  }
  touch(rt);
}

function ensureEngine(id: string): Promise<void> {
  const rt = runtime(id);
  if (alive(rt)) return Promise.resolve();
  return (rt.starting ??= start(id, "headless").finally(() => {
    rt.starting = null;
  }));
}

/** Hands a job to the project's Blender, starting one if there is none. */
async function call(id: string, spec: JobSpec, timeoutMs = JOB_TIMEOUT_MS): Promise<JobResult> {
  const rt = runtime(id);
  await ensureEngine(id);
  const job = { ...spec, id: uid() } as Job;
  return new Promise<JobResult>((resolve, reject) => {
    const drop = () => {
      clearTimeout(timer);
      rt.waiting.delete(job.id);
      rt.queue = rt.queue.filter((queued) => queued.id !== job.id);
    };
    const timer = setTimeout(() => {
      drop();
      // An engine that sat on a job this long is not coming back.
      if (rt.engine?.working === job.id) rt.engine = null;
      reject(new StudioError("Blender did not finish that step in time.", 504));
    }, timeoutMs);
    rt.waiting.set(job.id, {
      resolve: (result) => (drop(), resolve(result)),
      reject: (err) => (drop(), reject(err)),
    });
    rt.queue.push(job);
    rt.wake?.();
  });
}

/** Opens the project in a Blender with a window, replacing a windowless one. */
export async function openInBlender(id: string, origin: string): Promise<void> {
  await current(id);
  const rt = runtime(id);
  rt.origin = origin;
  if (alive(rt) && rt.engine!.mode === "ui") return;
  if (rt.turn || rt.task) {
    throw new StudioError("Wait until the co-pilot has finished, then open Blender.", 409);
  }
  await rt.starting?.catch(() => undefined);
  if (alive(rt)) {
    // The windowless Blender saves and leaves, so the window opens the latest file.
    await call(id, { kind: "quit" }, 30_000).catch(() => undefined);
    rt.engine = null;
  }
  rt.starting = start(id, "ui").finally(() => {
    rt.starting = null;
  });
  await rt.starting;
}

// ─── Tools and turns ────────────────────────────────────────────────

const LOOK_SIZE = { one: [960, 720], tiled: [640, 480] } as const;

async function runTool(
  id: string,
  tool: string,
  input: unknown,
  job: (spec: JobSpec) => Promise<JobResult>,
): Promise<ToolOutcome> {
  const fail = (message: string): ToolOutcome => ({ ok: false, message, images: [] });
  const invalid = (error: z.ZodError) => fail(`Invalid input for ${tool}:\n${z.prettifyError(error)}`);

  if (tool === "python") {
    const parsed = PythonInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const result = await job({ kind: "python", code: parsed.data.code });
    const message = [result.output.trim(), result.error].filter(Boolean).join("\n");
    return { ok: result.ok, message: message || "Done.", images: [] };
  }
  if (tool === "look") {
    const parsed = LookInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const name = `looks/${Date.now().toString(36)}.png`;
    const out = path.join(projectDir(id), name);
    await mkdir(path.dirname(out), { recursive: true });
    const tiled = parsed.data.views.length > 1 || parsed.data.frames !== undefined;
    const size = tiled ? LOOK_SIZE.tiled : LOOK_SIZE.one;
    const result = await job({ kind: "look", ...parsed.data, size: [...size], out });
    if (!result.ok) return fail(result.error ?? "Blender could not render the look.");
    await updateProject(id, (project) => {
      project.image = name;
    });
    return { ok: true, message: result.output, images: [out] };
  }
  return fail(`There is no tool "${tool}". The tools are: ${BLENDER_TOOLS.map((t) => t.name).join(", ")}.`);
}

/** Saves the .blend and exports the preview the web page shows. */
async function checkpoint(id: string): Promise<unknown> {
  const dir = projectDir(id);
  const fresh = path.join(dir, "model.next.glb");
  const result = await call(id, { kind: "save", glb: fresh });
  if (result.files.length > 0) {
    // Renamed into place so the page never loads half a file.
    await rename(fresh, path.join(dir, "model.glb"));
    await updateProject(id, (project) => {
      project.model = Date.now();
    });
  }
  return result.summary;
}

function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\s+/).join(" ");
  const title = line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

const failureText = (err: unknown): string => {
  if (err instanceof PlannerError || err instanceof StudioError) return err.message;
  console.error("A Blender turn failed:", err);
  return "The co-pilot failed unexpectedly.";
};

async function runTurn(id: string, turn: ActiveTurn, prompt: string, history: Message[], brain: Brain): Promise<void> {
  const rt = runtime(id);
  const signal = turn.abort.signal;
  const status = (text: string) => {
    turn.status = text;
    touch(rt);
  };
  let scene: unknown = null;
  let unsaved = false;
  const job = async (spec: JobSpec) => {
    const result = await call(id, spec);
    if (result.summary) scene = result.summary;
    return result;
  };
  let error: string | undefined;

  try {
    await job({ kind: "python", code: "pass" });
    signal.throwIfAborted();
    status("Thinking");
    await brain.run({
      prompt,
      history: history.map(({ role, text }) => ({ role, text })),
      scene,
      async call(tool, input) {
        signal.throwIfAborted();
        status(tool === "look" ? "Looking at the result" : "Working in Blender");
        turn.steps++;
        unsaved = true;
        const outcome = await runTool(id, tool, input, job);
        status("Thinking");
        return outcome;
      },
      async checkpoint() {
        if (unsaved) {
          unsaved = false;
          scene = (await checkpoint(id)) ?? scene;
        }
        return scene;
      },
      say(delta) {
        turn.live += delta;
        touch(rt);
      },
      status,
      signal,
    });
  } catch (err) {
    error = signal.aborted ? "Stopped." : failureText(err);
  } finally {
    if (unsaved) await checkpoint(id).catch(() => undefined);
    await updateProject(id, (project) => {
      project.chat.push({
        id: uid(),
        role: "assistant",
        text: turn.live.trim(),
        at: Date.now(),
        error,
        steps: turn.steps || undefined,
        planner: brain.name,
      });
    }).catch((err) => console.error("Could not store the co-pilot's reply:", err));
    rt.turn = null;
    touch(rt);
  }
}

/** Adds a prompt to the conversation and starts answering it. Returns at once. */
export async function startTurn(
  id: string,
  text: string,
  from: "web" | "blender",
  origin: string,
  brain: Brain = createBrain(),
): Promise<void> {
  const rt = runtime(id);
  if (rt.turn || rt.task) throw new StudioError("The co-pilot is still working on the last request.", 409);
  const history = (await current(id)).chat;
  const turn: ActiveTurn = { abort: new AbortController(), status: "Starting Blender", live: "", steps: 0 };
  rt.turn = turn;
  rt.origin = origin;
  try {
    await updateProject(id, (project) => {
      if (project.chat.length === 0 && project.name === "Untitled") project.name = titleFrom(text);
      project.chat.push({ id: uid(), role: "user", text, at: Date.now(), from });
    });
  } catch (err) {
    rt.turn = null;
    throw err;
  }
  void runTurn(id, turn, text, history, brain);
}

/** Stops the turn after the step Blender is on, or a render after its current frame. What was built stays. */
export function stopTurn(id: string): void {
  const rt = runtime(id);
  if (rt.turn) {
    rt.turn.status = "Stopping";
    rt.turn.abort.abort();
  } else if (rt.task) {
    rt.stopTask = true;
    rt.task = "Stopping after this frame";
  } else return;
  touch(rt);
}

/** Deletes the project and lets go of the windowless Blender holding it. */
export async function removeProject(id: string): Promise<void> {
  await current(id);
  const rt = runtime(id);
  rt.turn?.abort.abort();
  if (alive(rt) && rt.engine!.mode === "headless") {
    await call(id, { kind: "quit" }, 15_000).catch(() => undefined);
  }
  failJobs(rt, "The project was deleted.");
  hub.projects.delete(id);
  await deleteProject(id);
  touch(rt);
}

export interface RenderOptions {
  /** Every frame of the scene's range, as an MP4, instead of the current frame as a picture. */
  animation: boolean;
  /** Half size and few samples, to see the motion without the wait. */
  draft: boolean;
}

/** Renders the scene from its camera with its own settings. Returns at once. */
export async function renderScene(id: string, origin: string, options: RenderOptions): Promise<void> {
  const rt = runtime(id);
  if (rt.turn || rt.task) throw new StudioError("Blender is busy. Try again when it has finished.", 409);
  await current(id);
  rt.origin = origin;
  rt.task = "Rendering";
  rt.stopTask = false;
  touch(rt);
  void (async () => {
    const stamp = Date.now().toString(36);
    const name = `renders/${stamp}.${options.animation ? "mp4" : "png"}`;
    const out = path.join(projectDir(id), name);
    let error: string | undefined;
    let frames = "";
    try {
      await mkdir(path.dirname(out), { recursive: true });
      const result = await call(
        id,
        { kind: "render", out, ...options, frames: path.join(projectDir(id), "renders", `${stamp}-frames`) },
        options.animation ? ANIMATION_TIMEOUT_MS : RENDER_TIMEOUT_MS,
      );
      if (!result.ok) error = result.error?.trim().split("\n").at(-1) ?? "The render failed.";
      frames = result.output;
    } catch (err) {
      error = failureText(err);
    }
    await updateProject(id, (project) => {
      if (!error) project.image = name;
      project.chat.push({
        id: uid(),
        role: "assistant",
        text: error ? "" : options.animation ? `Rendered the animation: ${frames}.` : "Rendered the scene from its camera.",
        at: Date.now(),
        error,
      });
    }).catch(() => undefined);
    rt.task = null;
    rt.stopTask = false;
    touch(rt);
  })();
}
