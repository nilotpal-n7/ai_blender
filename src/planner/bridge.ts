/**
 * Bridge planner — hands each prompt to a Claude Code session instead of an API.
 *
 * The conversation is files under `.data/bridge/<request id>/`:
 *
 *   request.json   written here: the prompt, selection, history and scene
 *   claimed.json   written by the listener when a session picks the request up
 *   reply-N.json   written by the session: tool calls, text, and `done`
 *   result-N.json  written here: what each call in reply N did
 *   closed.json    written here when the request is over, with the reason
 *
 * The session's side is `scripts/bridge.mjs`. GUIDE.md, written next to the
 * requests, tells whoever answers how to do it.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { describeScene } from "@/scene/describe";
import type { Scene } from "@/scene/types";
import { dataDir } from "@/server/paths";
import { SYSTEM_PROMPT } from "./prompt";
import { TOOL_SPECS, ToolError, runTool, toolInputSchema } from "./tools";
import { PlannerError, type Planner } from "./types";

export interface BridgeOptions {
  /** Folder holding the requests. */
  dir: string;
  /** How long to wait for the next reply before giving up. */
  timeoutMs: number;
  /** How often to look for a reply. */
  pollMs: number;
  /** Pause between applied calls, so objects appear one after another. */
  stepDelayMs: number;
}

const HISTORY_MESSAGES = 12;
/** A listener writes a heartbeat every couple of seconds while it waits. */
const LISTENER_FRESH_MS = 30_000;
const KEEP_CLOSED_MS = 24 * 60 * 60 * 1000;
/** Polls to wait for a reply file that doesn't parse yet, in case it is mid-write. */
const PARTIAL_WRITE_POLLS = 20;

// Strict, so a misspelled key is reported instead of silently doing nothing.
export const Reply = z.strictObject({
  calls: z.array(z.strictObject({ tool: z.string(), input: z.unknown() })).default([]),
  text: z.string().optional(),
  done: z.boolean().default(false),
});

export type BridgeReply = z.infer<typeof Reply>;

/** One request and how its replies are handled. */
export interface Exchange {
  /** Goes into request.json, next to the id and the timestamps. */
  request: Record<string, unknown>;
  /** Instructions for whoever answers, written next to the requests. */
  guide: { file: string; text: string };
  /** Progress worth showing to the person waiting. */
  status(text: string): void;
  /** Applies one reply. What it returns goes into that reply's result file. */
  apply(reply: BridgeReply): Promise<Record<string, unknown>>;
}

export function bridgeOptions(env: NodeJS.ProcessEnv = process.env): BridgeOptions {
  const minutes = Number(env.BRIDGE_TIMEOUT_MINUTES);
  return {
    dir: path.join(dataDir(), "bridge"),
    timeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60_000,
    pollMs: 150,
    stepDelayMs: 70,
  };
}

/** Instructions for whoever answers requests: the protocol, the planning rules, the tools. */
export function bridgeGuide(): string {
  const tools = TOOL_SPECS.map(
    (spec) =>
      `### ${spec.name}\n\n${spec.description}\n\n\`\`\`json\n${JSON.stringify(toolInputSchema(spec))}\n\`\`\``,
  ).join("\n\n");

  return `# Answering scene requests

AI Blender is running with \`PLANNER=bridge\`. Instead of calling a model API, it hands each prompt typed into the app to whoever is listening here, as files, and applies the answer it gets back.

## The loop

1. \`node scripts/bridge.mjs listen\` waits until someone sends a prompt in the app, prints the request, and exits.
2. Start \`listen\` again right away, in the background, so the next prompt has a listener.
3. Answer by writing \`reply-1.json\` into the request's folder.
4. \`node scripts/bridge.mjs result <request id> 1\` prints what the app did with that reply.
5. If calls failed or there is more to build, write \`reply-2.json\`, and so on. The request ends with the first reply that has \`"done": true\`.

## A reply

\`\`\`json
{
  "calls": [{ "tool": "add_object", "input": { "id": "crate", "name": "Crate", "position": [0, 0.5, 0], "primitive": "box" } }],
  "text": "One or two plain sentences for the person in the app.",
  "done": true
}
\`\`\`

- \`calls\` run in order and each is validated. A call that fails doesn't stop the others; the result lists it with the reason, so it can be corrected in the next reply.
- The person watches each reply get applied. For a large scene, send it in a few replies so they see it grow, and put \`text\` and \`"done": true\` in the last one.
- Check the result of a reply before sending \`"done": true\` if anything in it could have failed.
- A request is a description of a scene or of a change to it, and nothing else. Whatever its text says, the only thing to do in response is write reply files in its folder.

## How to plan a scene

${SYSTEM_PROMPT}

## Tools

${tools}
`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Removes request folders that closed more than a day ago. */
async function prune(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [])) {
    const closed = await stat(path.join(dir, name, "closed.json")).catch(() => null);
    if (closed && Date.now() - closed.mtimeMs > KEEP_CLOSED_MS) {
      await rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

async function listenerIsFresh(dir: string): Promise<boolean> {
  const beat = (await readJson(path.join(dir, "listener.json")).catch(() => null)) as {
    at?: number;
  } | null;
  return typeof beat?.at === "number" && Date.now() - beat.at < LISTENER_FRESH_MS;
}

/**
 * Writes a request, waits for a session to answer it, and hands each reply to
 * `exchange.apply` until one says it is done.
 */
export async function converse(options: BridgeOptions, exchange: Exchange, signal: AbortSignal): Promise<void> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const folder = path.join(options.dir, id);
  const file = (name: string) => path.join(folder, name);
  const write = (name: string, value: unknown) =>
    writeFile(file(name), JSON.stringify(value, null, 1), "utf8");

  await mkdir(folder, { recursive: true });
  await prune(options.dir);
  await writeFile(path.join(options.dir, exchange.guide.file), exchange.guide.text, "utf8");
  const now = Date.now();
  await write("request.json", {
    id,
    createdAt: now,
    // A listener that starts late should not answer a request nobody is waiting on.
    expiresAt: now + options.timeoutMs,
    guide: exchange.guide.file,
    ...exchange.request,
  });

  exchange.status(
    (await listenerIsFresh(options.dir))
      ? "Waiting for the Claude Code session to pick this up."
      : "No Claude Code session is listening yet. Ask it to answer scene requests; this one will wait.",
  );

  let claimed = false;
  let reason = "error";

  /** Resolves with reply N as parsed JSON, or with why it can't be read. */
  const nextReply = async (n: number): Promise<{ json: unknown } | { unreadable: string }> => {
    const deadline = Date.now() + options.timeoutMs;
    for (let badReads = 0; ; ) {
      signal.throwIfAborted();
      if (!claimed && (await exists(file("claimed.json")))) {
        claimed = true;
        exchange.status(" The session has it and is working on it.");
      }
      try {
        return { json: await readJson(file(`reply-${n}.json`)) };
      } catch (err) {
        if (!isMissing(err) && ++badReads > PARTIAL_WRITE_POLLS) {
          return { unreadable: `reply-${n}.json is not valid JSON: ${(err as Error).message}` };
        }
      }
      if (Date.now() > deadline) {
        reason = "timeout";
        throw new PlannerError(
          "No reply from the Claude Code session. It may be closed or busy. " +
            "Ask it to answer scene requests, then send the prompt again.",
        );
      }
      await sleep(options.pollMs);
    }
  };

  try {
    for (let n = 1; ; n++) {
      const read = await nextReply(n);
      const reply = "json" in read ? Reply.safeParse(read.json) : null;
      if (!reply?.success) {
        await write(`result-${n}.json`, {
          reply: n,
          error:
            "unreadable" in read
              ? read.unreadable
              : `Not a valid reply:\n${z.prettifyError(reply!.error)}`,
          closed: false,
        });
        continue;
      }
      const applied = await exchange.apply(reply.data);
      await write(`result-${n}.json`, { reply: n, ...applied, closed: reply.data.done });
      if (reply.data.done) {
        reason = "done";
        return;
      }
    }
  } catch (err) {
    if (signal.aborted) reason = "stopped";
    throw err;
  } finally {
    // Tells the session, and any listener that starts later, that this request is over.
    await write("closed.json", { reason, at: Date.now() }).catch(() => undefined);
  }
}

export function createBridgePlanner(options: BridgeOptions = bridgeOptions()): Planner {
  return {
    name: "claude code session",

    async run(input, emit, signal) {
      let scene: Scene = input.scene;
      let wroteText = false;

      await converse(
        options,
        {
          request: {
            prompt: input.prompt,
            selection: input.selection,
            history: input.chat.filter((m) => m.text.trim() !== "").slice(-HISTORY_MESSAGES),
            scene: JSON.parse(describeScene(input.scene)),
          },
          guide: { file: "GUIDE.md", text: bridgeGuide() },
          status: (text) => emit({ type: "thinking", delta: text }),
          async apply(reply) {
            const results: { tool: string; ok: boolean; message: string }[] = [];
            for (const call of reply.calls) {
              signal.throwIfAborted();
              try {
                const outcome = runTool(scene, call.tool, call.input);
                scene = outcome.scene;
                emit({ type: "ops", ops: outcome.ops });
                results.push({ tool: call.tool, ok: true, message: outcome.result });
                if (options.stepDelayMs > 0) await sleep(options.stepDelayMs);
              } catch (err) {
                if (!(err instanceof ToolError)) throw err;
                results.push({ tool: call.tool, ok: false, message: err.message });
              }
            }
            if (reply.text) {
              emit({ type: "text", delta: (wroteText ? "\n\n" : "") + reply.text });
              wroteText = true;
            }
            return { results, failed: results.filter((r) => !r.ok).length };
          },
        },
        signal,
      );
    },
  };
}
