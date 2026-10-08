import { z } from "zod";

export const PROJECT_ID = /^[a-z0-9]{8,32}$/;

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.number(),
  /** Where a prompt was typed. */
  from: z.enum(["web", "blender"]).optional(),
  error: z.string().optional(),
  /** How many things the co-pilot did in Blender for this reply. */
  steps: z.number().optional(),
  planner: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/** A scene that lives in a .blend file, with the conversation that built it. */
export const ProjectSchema = z.object({
  id: z.string().regex(PROJECT_ID),
  name: z.string().min(1).max(120),
  createdAt: z.number(),
  updatedAt: z.number(),
  chat: z.array(MessageSchema),
  /** Changes whenever the web preview (model.glb) is exported again; 0 before the first. */
  model: z.number().default(0),
  /** The latest picture from Blender, relative to the project folder. */
  image: z.string().nullable().default(null),
});
export type Project = z.infer<typeof ProjectSchema>;

export type EngineMode = "ui" | "headless";

/** What both the web page and Blender's sidebar show. */
export interface StudioState {
  project: Project;
  busy: boolean;
  /** What is happening right now, in a few words. */
  status: string;
  /** The reply as far as it has been written. */
  live: string;
  /** Which Blender is connected: one with a window, one without, or none yet. */
  engine: EngineMode | "off";
  /** Changes with every change to any of the above. */
  rev: number;
}

export const VIEWS = [
  "three-quarter",
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
  "rear-quarter",
  "camera",
] as const;

export type JobSpec =
  | { kind: "python"; code: string }
  | { kind: "look"; views: string[]; objects: string[]; shading: string; frame?: number; size: [number, number]; out: string }
  | { kind: "save"; glb: string }
  | { kind: "render"; out: string }
  | { kind: "quit" };
export type Job = JobSpec & { id: string };

export const JobResultSchema = z.object({
  job: z.string(),
  ok: z.boolean(),
  output: z.string().default(""),
  error: z.string().nullable().default(null),
  files: z.array(z.string()).default([]),
  summary: z.unknown(),
});
export type JobResult = z.infer<typeof JobResultSchema>;

export const EngineSyncSchema = z.object({
  project: z.string().regex(PROJECT_ID),
  engine: z.string().min(4).max(64),
  token: z.string(),
  mode: z.enum(["ui", "headless"]),
  version: z.string().max(40),
  done: JobResultSchema.optional(),
  bye: z.boolean().optional(),
});
export type EngineSync = z.infer<typeof EngineSyncSchema>;

/** A failure whose message is safe and useful to show to the user as-is. */
export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "StudioError";
  }
}
