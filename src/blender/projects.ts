/**
 * Blender projects on disk: one folder each under `.data/blender/`, holding
 * project.json (name and conversation), scene.blend (the scene itself),
 * model.glb (what the web page shows) and the pictures Blender has made.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/server/paths";
import { PROJECT_ID, ProjectSchema, StudioError, type Project } from "./types";

export function blenderDir(): string {
  return path.join(dataDir(), "blender");
}

/** The project's folder. Ids come from URLs, so anything else never reaches the filesystem. */
export function projectDir(id: string): string {
  if (!PROJECT_ID.test(id)) throw new StudioError("Project not found.", 404);
  return path.join(blenderDir(), id);
}

/** Files the web page may ask for, relative to the project folder. */
const SERVED = /^(model\.glb|(looks|renders)\/[a-z0-9-]+\.png)$/;

export function servedFile(id: string, name: string): string | null {
  return SERVED.test(name) ? path.join(projectDir(id), name) : null;
}

export async function loadProject(id: string): Promise<Project> {
  let text: string;
  try {
    text = await readFile(path.join(projectDir(id), "project.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StudioError("Project not found.", 404);
    throw err;
  }
  return ProjectSchema.parse(JSON.parse(text));
}

export async function saveProject(project: Project): Promise<void> {
  const dir = projectDir(project.id);
  await mkdir(dir, { recursive: true });
  // Write-then-rename so a crash mid-write can't leave half a project.
  const temp = path.join(dir, `project.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(project), "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(temp, path.join(dir, "project.json"));
    } catch (err) {
      // Windows refuses to replace a file while someone is reading it. They won't be for long.
      const busy = ["EPERM", "EBUSY", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "");
      if (!busy || attempt >= 20) {
        await rm(temp, { force: true });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function createProject(name = "Untitled"): Promise<Project> {
  const now = Date.now();
  const project: Project = {
    id: randomBytes(6).toString("hex"),
    name,
    createdAt: now,
    updatedAt: now,
    chat: [],
    model: 0,
    image: null,
  };
  await saveProject(project);
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  await rm(projectDir(id), { recursive: true, force: true });
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
}

/** Every project, most recently changed first. Unreadable folders are skipped. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const names = await readdir(blenderDir()).catch(() => [] as string[]);
  const projects = await Promise.all(
    names
      .filter((name) => PROJECT_ID.test(name))
      .map((name) =>
        loadProject(name).then(
          ({ id, name, updatedAt }): ProjectSummary => ({ id, name, updatedAt }),
          () => null,
        ),
      ),
  );
  return projects.filter((p) => p !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}
