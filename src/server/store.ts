/**
 * Scene persistence: one JSON file per scene under `.data/scenes/`.
 *
 * The browser owns a scene while it is open and autosaves the whole document,
 * so the server only needs whole-file reads and atomic whole-file writes.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { findSceneProblem } from "@/scene/ops";
import { MAX_HISTORY, SceneDocSchema, emptyScene, type SceneDoc } from "@/scene/types";
import { dataDir } from "./paths";

export interface SceneSummary {
  id: string;
  name: string;
  updatedAt: number;
  objects: number;
}

/** Thrown when a document fails validation; the message is safe to return to the client. */
export class InvalidDocError extends Error {}

const ID_PATTERN = /^[a-z0-9]{8,32}$/;

function scenesDir(): string {
  return path.join(dataDir(), "scenes");
}

function fileFor(id: string): string | null {
  // Ids come from URLs, so anything that isn't a plain id never reaches the filesystem.
  return ID_PATTERN.test(id) ? path.join(scenesDir(), `${id}.json`) : null;
}

export function parseDoc(raw: unknown): SceneDoc {
  const parsed = SceneDocSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InvalidDocError(`Invalid scene document at ${issue.path.join(".")}: ${issue.message}`);
  }
  const problem = findSceneProblem(parsed.data.scene);
  if (problem) throw new InvalidDocError(`Invalid scene document: ${problem}`);
  return parsed.data;
}

export async function loadDoc(id: string): Promise<SceneDoc | null> {
  const file = fileFor(id);
  if (!file) return null;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseDoc(JSON.parse(text));
}

export async function saveDoc(doc: SceneDoc): Promise<void> {
  const file = fileFor(doc.id);
  if (!file) throw new InvalidDocError("Invalid scene id.");
  const trimmed: SceneDoc = {
    ...doc,
    undo: doc.undo.slice(-MAX_HISTORY),
    redo: doc.redo.slice(-MAX_HISTORY),
  };
  await mkdir(scenesDir(), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a half-written scene.
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(trimmed), "utf8");
  await rename(temp, file);
}

export async function createDoc(name = "Untitled scene"): Promise<SceneDoc> {
  const now = Date.now();
  const doc: SceneDoc = {
    id: randomBytes(6).toString("hex"),
    name,
    createdAt: now,
    updatedAt: now,
    scene: emptyScene(),
    chat: [],
    undo: [],
    redo: [],
  };
  await saveDoc(doc);
  return doc;
}

let defaultSceneQueue: Promise<unknown> = Promise.resolve();

/**
 * The scene to open when none is named: the most recently edited one, or a new
 * one if the store is empty. Calls run one at a time, so several first visits
 * arriving together share one new scene instead of creating one each.
 */
export function defaultSceneId(): Promise<string> {
  const id = defaultSceneQueue.then(async () => {
    const [latest] = await listDocs();
    return latest?.id ?? (await createDoc()).id;
  });
  defaultSceneQueue = id.catch(() => undefined);
  return id;
}

export async function deleteDoc(id: string): Promise<boolean> {
  const file = fileFor(id);
  if (!file) return false;
  try {
    await rm(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Every stored scene, most recently edited first. Unreadable files are skipped. */
export async function listDocs(): Promise<SceneSummary[]> {
  let files: string[];
  try {
    files = await readdir(scenesDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const summaries = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f): Promise<SceneSummary | null> => {
        try {
          const doc = await loadDoc(f.slice(0, -".json".length));
          return doc && {
            id: doc.id,
            name: doc.name,
            updatedAt: doc.updatedAt,
            objects: Object.keys(doc.scene.nodes).length,
          };
        } catch {
          return null;
        }
      }),
  );
  return summaries.filter((s) => s !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}
