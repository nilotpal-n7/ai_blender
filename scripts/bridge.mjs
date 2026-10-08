#!/usr/bin/env node
/**
 * The answering side of the bridge planner (src/planner/bridge.ts), for a
 * Claude Code session.
 *
 *   node scripts/bridge.mjs listen [--timeout <seconds>]
 *       Waits for a prompt from the app, prints the request, exits.
 *
 *   node scripts/bridge.mjs result <request id> <reply number> [--wait <seconds>] [--scene]
 *       Waits for the app to apply that reply and prints what happened.
 *       --scene also prints the scene as it is afterwards.
 *
 * How to answer a request is described in .data/bridge/GUIDE.md, or in
 * GUIDE-blender.md for a request whose kind is "blender".
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(process.env.DATA_DIR || path.join(repo, ".data"), "bridge");
const shown = (file) => path.relative(repo, file).replaceAll("\\", "/");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parsed JSON, or null while the file is missing or still being written. */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** The oldest request that nobody has picked up and that is still being waited on. */
async function nextRequest() {
  const names = await readdir(bridge).catch(() => []);
  for (const name of names.sort()) {
    const folder = path.join(bridge, name);
    const request = await readJson(path.join(folder, "request.json"));
    if (!request || request.expiresAt < Date.now()) continue;
    const taken =
      (await readJson(path.join(folder, "claimed.json"))) ||
      (await readJson(path.join(folder, "closed.json")));
    if (!taken) return { folder, request };
  }
  return null;
}

async function listen(timeoutSeconds) {
  await mkdir(bridge, { recursive: true });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastBeat = 0;

  while (Date.now() < deadline) {
    // The app reads this to tell the user whether anyone is listening.
    if (Date.now() - lastBeat > 2000) {
      lastBeat = Date.now();
      await writeFile(path.join(bridge, "listener.json"), JSON.stringify({ pid: process.pid, at: lastBeat }));
    }
    const found = await nextRequest();
    if (found) {
      const { folder, request } = found;
      await writeFile(path.join(folder, "claimed.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      console.log(`${request.kind === "blender" ? "BLENDER" : "SCENE"} REQUEST ${request.id}`);
      console.log(`prompt: ${request.prompt}`);
      if (request.selection?.length > 0) console.log(`selection: ${JSON.stringify(request.selection)}`);
      for (const message of request.history) console.log(`  earlier ${message.role}: ${message.text}`);
      console.log(`scene: ${JSON.stringify(request.scene)}`);
      console.log("");
      console.log(`Start listening again, then answer by writing ${shown(folder)}/reply-1.json:`);
      console.log('  {"calls":[{"tool":"…","input":{…}}],"text":"…","done":true}');
      console.log(`Check it with: node scripts/bridge.mjs result ${request.id} 1`);
      console.log(`Rules and tool schemas: ${shown(path.join(bridge, request.guide ?? "GUIDE.md"))}`);
      return;
    }
    await sleep(400);
  }
  console.log(`No scene requests in the last ${Math.round(timeoutSeconds / 60)} minutes.`);
}

async function result(id, number, waitSeconds, withScene) {
  const folder = path.join(bridge, id);
  const deadline = Date.now() + waitSeconds * 1000;

  while (Date.now() < deadline) {
    const outcome = await readJson(path.join(folder, `result-${number}.json`));
    if (outcome) {
      if (outcome.error) {
        console.log(`reply ${number} was rejected: ${outcome.error}`);
      } else {
        const applied = outcome.results.length - outcome.failed;
        console.log(`reply ${number}: ${applied} applied, ${outcome.failed} failed`);
        for (const r of outcome.results) {
          if (!r.ok) console.log(`  FAILED ${r.tool}: ${r.message}`);
          // A Blender call's output is the point of it, so it is shown even when it worked.
          else if (outcome.verbose) console.log(`  ${r.tool}: ${r.message}`);
          for (const image of r.images ?? []) console.log(`    picture: ${image}`);
        }
        if (outcome.scene && withScene) console.log(`scene: ${JSON.stringify(outcome.scene)}`);
        else if (outcome.scene?.objects) console.log(`scene: ${outcome.scene.objects.length} objects`);
      }
      console.log(
        outcome.closed
          ? "The request is finished."
          : `The request is still open: continue with reply-${Number(number) + 1}.json.`,
      );
      return;
    }
    const closed = await readJson(path.join(folder, "closed.json"));
    if (closed) {
      console.log(`The request ended before this reply was applied (${closed.reason}).`);
      return;
    }
    await sleep(200);
  }
  console.log("No result yet. The app may still be working, or may have stopped waiting for this request.");
  process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
if (command === "listen") {
  await listen(option("--timeout", 2 * 60 * 60));
} else if (command === "result" && args.length >= 2) {
  await result(args[0], args[1], option("--wait", 60), args.includes("--scene"));
} else {
  console.error(
    "usage: bridge.mjs listen [--timeout <seconds>] | bridge.mjs result <request id> <reply number> [--wait <seconds>] [--scene]",
  );
  process.exitCode = 2;
}
