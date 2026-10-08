import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MATERIAL, type SceneDoc } from "@/scene/types";
import {
  InvalidDocError,
  createDoc,
  defaultSceneId,
  deleteDoc,
  listDocs,
  loadDoc,
  parseDoc,
  saveDoc,
} from "./store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ai-blender-"));
  process.env.DATA_DIR = dir;
});
afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function withBox(doc: SceneDoc, parent: string | null = null): SceneDoc {
  return {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: {
        box: {
          id: "box", name: "Box", parent, kind: "mesh", primitive: "box", visible: true,
          position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
          author: "user", pinned: [], material: { ...DEFAULT_MATERIAL }, bevel: 0, array: null, taper: [1, 1], outline: null,
        },
      },
    },
  };
}

describe("scene store", () => {
  it("round-trips a document through disk", async () => {
    const created = await createDoc("My scene");
    const edited = withBox(created);
    await saveDoc(edited);
    expect(await loadDoc(created.id)).toEqual(edited);
    // No temp files are left behind by the atomic write.
    expect(await readdir(path.join(dir, "scenes"))).toEqual([created.id + ".json"]);
  });

  it("lists scenes newest first and skips unreadable files", async () => {
    const older = await createDoc("Older");
    const newer = await createDoc("Newer");
    await saveDoc({ ...withBox(newer), updatedAt: older.updatedAt + 1000 });
    await writeFile(path.join(dir, "scenes", "deadbeef0000.json"), "{ not json", "utf8");

    expect(await listDocs()).toEqual([
      { id: newer.id, name: "Newer", updatedAt: older.updatedAt + 1000, objects: 1 },
      { id: older.id, name: "Older", updatedAt: older.updatedAt, objects: 0 },
    ]);
  });

  it("returns nothing for unknown ids and never touches paths outside the store", async () => {
    expect(await listDocs()).toEqual([]);
    expect(await loadDoc("0123456789ab")).toBeNull();
    expect(await loadDoc("../../etc/passwd")).toBeNull();
    expect(await deleteDoc("..\\..\\secrets")).toBe(false);
  });

  it("creates one scene, not several, when first visits arrive together", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => defaultSceneId()));
    expect(new Set(ids).size).toBe(1);
    expect(await listDocs()).toHaveLength(1);

    // Afterwards it opens the most recently edited scene and creates nothing.
    const newer = await createDoc("Newer");
    await saveDoc({ ...newer, updatedAt: Date.now() + 1000 });
    expect(await defaultSceneId()).toBe(newer.id);
    expect(await listDocs()).toHaveLength(2);
  });

  it("deletes scenes", async () => {
    const doc = await createDoc();
    expect(await deleteDoc(doc.id)).toBe(true);
    expect(await deleteDoc(doc.id)).toBe(false);
    expect(await loadDoc(doc.id)).toBeNull();
  });

  it("rejects malformed documents and broken hierarchies", async () => {
    const doc = await createDoc();
    expect(() => parseDoc({ ...doc, name: "" })).toThrow(InvalidDocError);
    expect(() => parseDoc({ ...doc, id: "../x" })).toThrow(InvalidDocError);
    expect(() => parseDoc(withBox(doc, "ghost"))).toThrow(/missing parent/);
    expect(parseDoc(withBox(doc))).toBeTruthy();
  });
});
