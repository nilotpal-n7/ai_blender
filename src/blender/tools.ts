import { z } from "zod";
import { VIEWS } from "./types";

/**
 * What the co-pilot can do in Blender. The descriptions are prompt text: they
 * are what the model reads to decide how to use each tool.
 */

export const PythonInput = z.strictObject({
  code: z.string().min(1).max(200_000).describe("Python to run in Blender."),
});

export const LookInput = z.strictObject({
  views: z
    .array(z.enum(VIEWS))
    .min(1)
    .max(4)
    .default(["three-quarter"])
    .describe("Where to look from. Several views come back as one picture, tiled two across in this order."),
  objects: z
    .array(z.string().max(120))
    .max(50)
    .default([])
    .describe("Names of objects to frame; their children are included. Empty frames the whole scene, minus a ground or backdrop."),
  shading: z
    .enum(["clay", "parts", "render"])
    .default("clay")
    .describe("clay: plain grey, fast, shows form. parts: every object its own colour. render: the real materials, lights and render engine, slower."),
  frame: z.number().int().optional().describe("Look at this frame of the animation instead of the current one."),
});

export interface BlenderTool {
  name: "python" | "look";
  description: string;
  schema: z.ZodType;
}

export const BLENDER_TOOLS: BlenderTool[] = [
  {
    name: "python",
    description:
      "Runs Python inside Blender, on the open scene. `bpy`, `bmesh`, `mathutils`, `math`, `Vector`, `Matrix`, `Euler` and `Quaternion` are already imported, `assets` is the library of scanned surfaces and HDRI skies, and whatever you define stays defined for later calls. Returns what the code printed, or the error with the line it happened on.",
    schema: PythonInput,
  },
  {
    name: "look",
    description:
      'Renders the scene and returns the picture, so you can check your work. The view "camera" is the scene\'s own camera; the others frame the subject for you. "front" looks at the side facing −Y.',
    schema: LookInput,
  },
];

export function blenderToolSchema(tool: BlenderTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
