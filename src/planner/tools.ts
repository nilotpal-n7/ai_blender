/**
 * The planner's tool surface.
 *
 * Each tool has a model-facing zod schema (also exported as JSON Schema) and a
 * `toOps` that turns a validated call into scene ops. Tools are friendlier
 * than raw ops: defaults are optional and one call can build a whole object
 * out of parts.
 */

import { z } from "zod";
import { round, roundVec } from "@/scene/math";
import { OpError, applyOps, uniqueId } from "@/scene/ops";
import {
  ANIMATABLE,
  ColorSchema,
  DEFAULT_LIGHT,
  DEFAULT_MATERIAL,
  IdSchema,
  PRIMITIVES,
  type ArrayCopies,
  type Op,
  type Scene,
  type SceneNode,
  type Vec3,
} from "@/scene/types";

/** Thrown for a bad tool call. The message goes back to the model so it can fix the call. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

// ─── Model-facing schemas ───────────────────────────────────────────

const vec3 = (description: string) => z.array(z.number()).length(3).describe(description);

const materialFields = {
  color: ColorSchema.describe('Base color as "#rrggbb".'),
  roughness: z.number().min(0).max(1).describe("0 = mirror-smooth, 1 = fully matte. Default 0.6."),
  metalness: z.number().min(0).max(1).describe("1 for bare metal, otherwise 0. Default 0."),
  emissive: ColorSchema.describe("Glow color. Needs emissiveIntensity above 0 to show."),
  emissiveIntensity: z.number().min(0).max(100).describe("Glow strength; 1–5 is typical."),
  opacity: z.number().min(0).max(1).describe("1 = solid; lower for glass or water."),
  wear: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How worn the finish is. Above 0 the color becomes paint that is chipped and scuffed in patches, " +
        "showing bare metal underneath: 0.15 lightly used, 0.4 battered. Default 0.",
    ),
};
const NewMaterial = z.object({
  ...materialFields,
  roughness: materialFields.roughness.optional(),
  metalness: materialFields.metalness.optional(),
  emissive: materialFields.emissive.optional(),
  emissiveIntensity: materialFields.emissiveIntensity.optional(),
  opacity: materialFields.opacity.optional(),
  wear: materialFields.wear.optional(),
});
const MaterialChange = z.object(materialFields).partial();

const primitive = z.enum(PRIMITIVES);
const blend = z
  .number()
  .min(0)
  .max(1)
  .describe(
    "Fuses this object's solid parts (box, sphere, cylinder, cone, pyramid, torus) into one smooth " +
      "surface, rounding the joins over about this many meters. Use 0.03–0.15 for bodies, limbs and " +
      "other organic forms; leave out for things with crisp edges.",
  );
const bevel = z
  .number()
  .min(0)
  .max(1)
  .describe(
    "Boxes only: rounds the edges and corners by this radius in meters. Machined and moulded parts " +
      "almost always want a little, 0.005–0.03; leave out for razor-sharp edges.",
  );
const array = z
  .object({
    count: z.number().int().min(1).max(64).describe("How many in total, the original included."),
    step: vec3("Meters from each copy to the next, along the parent's x, y, z.").optional(),
    turn: vec3(
      "Degrees from each copy to the next, turning about the parent's origin. " +
        "[0, 30, 0] with count 12 makes a full ring around the parent's Y axis.",
    ).optional(),
  })
  .describe(
    "Repeats the part in a row (`step`) or a ring (`turn`): slats, ribs, bolts, fins, teeth, fence posts. " +
      "Place the part where the first copy goes.",
  );
const SCALE_HELP =
  "For a primitive: its size in meters along x, y, z (primitives are unit-sized). " +
  "For a group: a multiplier, normally left out.";

const Part = z.object({
  name: z.string().min(1).max(80).describe('Short name, e.g. "leg front left".'),
  primitive,
  position: vec3("Center of the part, relative to the object it belongs to."),
  rotation: vec3("Euler XYZ in degrees.").optional(),
  scale: vec3("Size of the part in meters along x, y, z."),
  material: NewMaterial,
  bevel: bevel.optional(),
  array: array.optional(),
});

const AddObject = z.object({
  id: IdSchema.describe(
    'Unique snake_case id, e.g. "oak_tree_2". You refer to the object by this id later.',
  ),
  name: z.string().min(1).max(80).describe("Short display name."),
  parent: IdSchema.optional().describe(
    "Id of an existing group to nest under; position is then relative to it. Omit for a top-level object.",
  ),
  position: vec3("Center of the object in meters: [x, y, z]."),
  rotation: vec3("Euler XYZ in degrees.").optional(),
  scale: vec3(SCALE_HELP).optional(),
  primitive: primitive
    .optional()
    .describe("Shape of this object. Omit to create a group that only holds `parts`."),
  material: NewMaterial.optional().describe("Surface of the primitive. Not used by groups."),
  parts: z
    .array(Part)
    .max(64)
    .optional()
    .describe(
      "Primitives that make up this object, positioned relative to it, so the whole thing moves as one.",
    ),
  blend: blend.optional(),
  bevel: bevel.optional(),
  array: array.optional(),
});

const lightFields = {
  type: z.enum(["point", "spot"]),
  color: ColorSchema,
  intensity: z
    .number()
    .min(0)
    .max(100000)
    .describe("Brightness. About 5–50 reads well for lamps next to a sun of 1–3."),
  distance: z.number().min(0).describe("Cutoff distance in meters; 0 for none."),
  angle: z.number().min(1).max(89).describe("Spot cone half-angle in degrees."),
};

const AddLight = z.object({
  id: AddObject.shape.id,
  name: AddObject.shape.name,
  parent: AddObject.shape.parent,
  type: lightFields.type,
  position: vec3("Where the light is, in meters."),
  rotation: vec3(
    "Euler XYZ in degrees. A spot light shines straight down (−Y) until rotated.",
  ).optional(),
  color: lightFields.color.optional(),
  intensity: lightFields.intensity.optional(),
  distance: lightFields.distance.optional(),
  angle: lightFields.angle.optional(),
});

const UpdateObject = z.object({
  id: IdSchema.describe("Id of the object to change."),
  name: AddObject.shape.name.optional(),
  parent: IdSchema.nullable()
    .optional()
    .describe("New parent id, or null to move the object to the top level."),
  position: vec3("New center, relative to the parent.").optional(),
  rotation: vec3("New Euler XYZ rotation in degrees.").optional(),
  scale: vec3(SCALE_HELP).optional(),
  visible: z.boolean().optional(),
  primitive: primitive.optional(),
  blend: blend.optional(),
  bevel: bevel.optional(),
  array: array.nullable().optional().describe("New array for a part, or null to go back to a single copy."),
  material: MaterialChange.optional().describe("Only the material fields to change."),
  light: z.object(lightFields).partial().optional().describe("Only the light fields to change."),
});

const RemoveObjects = z.object({
  ids: z.array(IdSchema).min(1).describe("Objects to delete. Their parts and children go too."),
});

const SetEnvironment = z.object({
  background: ColorSchema.optional().describe("Sky / background color."),
  ambient: z.number().min(0).max(10).optional().describe("Soft fill light everywhere. Day ≈ 0.6."),
  sun: z
    .object({
      azimuth: z.number().describe("Direction the sun shines from, degrees. 0 = +Z, 90 = +X."),
      elevation: z.number().min(-90).max(90).describe("Height above the horizon, degrees."),
      intensity: z.number().min(0).max(20).describe("Day ≈ 2, dusk ≈ 0.8, night ≈ 0.2."),
      color: ColorSchema,
    })
    .partial()
    .optional(),
  ground: z
    .object({
      visible: z.boolean().describe("Show the infinite ground plane at y = 0."),
      color: ColorSchema,
    })
    .partial()
    .optional(),
  fog: z
    .object({
      color: ColorSchema,
      near: z.number().min(0).describe("Distance where fog starts, meters."),
      far: z.number().min(0).describe("Distance where fog is fully opaque, meters."),
    })
    .nullable()
    .optional()
    .describe("Distance fog, or null to turn it off."),
  grade: z
    .object({
      bloom: z.number().min(0).max(3).describe("Glow around lights and emissive surfaces. Default 0.75."),
      vignette: z.number().min(0).max(1).describe("Darkens the corners of the frame. 0.3 is cinematic."),
      saturation: z.number().min(0).max(2).describe("1 = as is, 0 = black and white, 1.2 = punchy."),
      contrast: z.number().min(-1).max(1).describe("0 = as is; 0.1–0.2 adds drama."),
    })
    .partial()
    .optional()
    .describe("The finishing pass over the picture, applied in the viewport and in renders."),
});

const keys = (what: string) =>
  z
    .array(
      z.object({
        t: z.number().min(0).describe("Seconds from the start of the clip."),
        value: vec3(what),
        ease: z
          .enum(["smooth", "linear", "hold"])
          .optional()
          .describe(
            "How the value travels to the next key: smooth eases out and in (default), linear keeps a " +
              "steady speed, hold stays put and then jumps.",
          ),
      }),
    )
    .max(400);

const Animate = z.object({
  id: IdSchema.describe("Id of the group to move. Everything inside the group moves with it."),
  position: keys("Position of the group at that moment, relative to its parent.")
    .optional()
    .describe("Keys for the group's position. An empty list removes its position animation."),
  rotation: keys("Euler XYZ rotation in degrees at that moment.")
    .optional()
    .describe("Keys for the group's rotation about its own origin, which acts as the joint."),
  scale: keys("Scale multiplier at that moment.").optional(),
});

const SetClip = z.object({
  duration: z.number().min(0.1).max(120).optional().describe("Length of the animation in seconds."),
  fps: z.number().int().min(1).max(60).optional().describe("Frames per second. Default 24."),
  loop: z
    .boolean()
    .optional()
    .describe("Whether it repeats. A loop needs every track to end where it began."),
});

const SetCamera = z.object({
  position: vec3("Where the camera is, in meters.").optional(),
  target: vec3("The point it looks at.").optional(),
  fov: z.number().min(5).max(120).optional().describe("Vertical field of view in degrees. Default 45."),
});

// ─── Conversion to ops ──────────────────────────────────────────────

const MIN_SCALE = 0.001;
/** Degenerate or mirrored scales break gizmos and normals, so sizes are kept positive. */
function size(v: readonly number[] | undefined): Vec3 {
  return roundVec((v ?? [1, 1, 1]).map((n) => Math.max(MIN_SCALE, Math.abs(n))));
}
const vec = (v: readonly number[] | undefined): Vec3 => roundVec(v ?? [0, 0, 0]);
/** A single copy is no array at all. */
function copies(input: z.infer<typeof array> | null | undefined): ArrayCopies | null {
  if (!input || input.count < 2) return null;
  return { count: input.count, step: vec(input.step), turn: vec(input.turn) };
}

type Planned = { ops: Op[]; result: string };

function addObject(input: z.infer<typeof AddObject>, scene: Scene): Planned {
  const base = {
    id: input.id,
    name: input.name,
    parent: input.parent ?? null,
    position: vec(input.position),
    rotation: vec(input.rotation),
    scale: size(input.scale),
    visible: true,
    author: "ai" as const,
    pinned: [] as never[],
  };
  // Children inherit their parent's scale, so a sized primitive can't also
  // hold parts. When both are given the primitive becomes one more part.
  const partInputs = [...(input.parts ?? [])];
  const asPart = input.primitive !== undefined && partInputs.length > 0;
  if (input.primitive && asPart) {
    partInputs.unshift({
      name: "body",
      primitive: input.primitive,
      position: [0, 0, 0],
      scale: input.scale ?? [1, 1, 1],
      material: input.material ?? { color: DEFAULT_MATERIAL.color },
      bevel: input.bevel,
      array: input.array,
    });
    base.scale = [1, 1, 1];
  }
  const root: SceneNode =
    input.primitive && !asPart
      ? {
          ...base,
          kind: "mesh",
          primitive: input.primitive,
          material: { ...DEFAULT_MATERIAL, ...input.material },
          bevel: input.bevel ?? 0,
          array: copies(input.array),
        }
      : { ...base, kind: "group", blend: input.blend ?? 0 };

  const taken = new Set([input.id]);
  const parts: SceneNode[] = partInputs.map((part) => {
    const id = uniqueId(scene, `${input.id}__${part.name}`, taken);
    taken.add(id);
    return {
      id,
      name: part.name,
      parent: input.id,
      position: vec(part.position),
      rotation: vec(part.rotation),
      scale: size(part.scale),
      visible: true,
      author: "ai",
      pinned: [],
      kind: "mesh",
      primitive: part.primitive,
      material: { ...DEFAULT_MATERIAL, ...part.material },
      bevel: part.bevel ?? 0,
      array: copies(part.array),
    };
  });

  if (root.kind === "group" && parts.length === 0) {
    throw new ToolError(
      `"${input.id}" has no primitive and no parts, so it would be invisible. Give it one or the other.`,
    );
  }
  return {
    ops: [root, ...parts].map((node) => ({ type: "add", node })),
    result:
      parts.length > 0
        ? `Added ${input.id} with parts: ${parts.map((p) => p.id).join(", ")}`
        : `Added ${input.id}`,
  };
}

function addLight(input: z.infer<typeof AddLight>): Planned {
  const node: SceneNode = {
    id: input.id,
    name: input.name,
    parent: input.parent ?? null,
    position: vec(input.position),
    rotation: vec(input.rotation),
    scale: [1, 1, 1],
    visible: true,
    author: "ai",
    pinned: [],
    kind: "light",
    light: {
      type: input.type,
      color: input.color ?? DEFAULT_LIGHT.color,
      intensity: input.intensity ?? DEFAULT_LIGHT.intensity,
      distance: input.distance ?? DEFAULT_LIGHT.distance,
      angle: input.angle ?? DEFAULT_LIGHT.angle,
    },
  };
  return { ops: [{ type: "add", node }], result: `Added ${input.id}` };
}

function updateObject(input: z.infer<typeof UpdateObject>): Planned {
  const { id, position, rotation, scale, array: repeat, ...rest } = input;
  const patch = {
    ...rest,
    ...(repeat !== undefined && { array: copies(repeat) }),
    ...(position && { position: vec(position) }),
    ...(rotation && { rotation: vec(rotation) }),
    ...(scale && { scale: size(scale) }),
  };
  if (Object.keys(patch).length === 0) {
    throw new ToolError(`Nothing to change on "${id}": give at least one property.`);
  }
  return { ops: [{ type: "update", id, patch }], result: `Updated ${id}` };
}

function animate(input: z.infer<typeof Animate>, scene: Scene): Planned {
  const ops: Op[] = [];
  for (const property of ANIMATABLE) {
    const list = input[property];
    if (!list) continue;
    const late = list.find((key) => key.t > scene.clip.duration + 1e-6);
    if (late) {
      throw new ToolError(
        `A ${property} key at ${late.t}s is past the end of the clip (${scene.clip.duration}s). ` +
          "Lengthen the clip with set_clip first, or move the key.",
      );
    }
    ops.push({
      type: "animate",
      id: input.id,
      property,
      keys: list.map((key) => ({
        t: round(key.t, 3),
        value: property === "scale" ? size(key.value) : vec(key.value),
        ease: key.ease ?? "smooth",
      })),
    });
  }
  if (ops.length === 0) {
    throw new ToolError(`Nothing to animate on "${input.id}": give position, rotation or scale keys.`);
  }
  return { ops, result: `Animated ${input.id}` };
}

function setClip(input: z.infer<typeof SetClip>, scene: Scene): Planned {
  if (Object.values(input).every((value) => value === undefined)) {
    throw new ToolError("Nothing to change: give duration, fps or loop.");
  }
  if (input.duration !== undefined) {
    const last = Math.max(0, ...scene.clip.tracks.flatMap((track) => track.keys.map((key) => key.t)));
    if (last > input.duration + 1e-6) {
      throw new ToolError(
        `There are keys as late as ${last}s, past the new length. Move or remove them first.`,
      );
    }
  }
  return { ops: [{ type: "clip", patch: input }], result: "Clip updated" };
}

function setCamera(input: z.infer<typeof SetCamera>): Planned {
  const patch = {
    ...(input.position && { position: vec(input.position) }),
    ...(input.target && { target: vec(input.target) }),
    ...(input.fov !== undefined && { fov: input.fov }),
  };
  if (Object.keys(patch).length === 0) {
    throw new ToolError("Nothing to change: give position, target or fov.");
  }
  return { ops: [{ type: "camera", patch }], result: "Camera updated" };
}

interface ToolSpec<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  toOps: (input: z.infer<S>, scene: Scene) => Planned;
}
const tool = <S extends z.ZodType>(spec: ToolSpec<S>) => spec as unknown as ToolSpec;

export const TOOL_SPECS: ToolSpec[] = [
  tool({
    name: "add_object",
    description:
      "Add one object to the scene: either a single primitive, or a group built from `parts`. " +
      "Build each real-world thing as one call so it stays one movable object.",
    schema: AddObject,
    toOps: addObject,
  }),
  tool({
    name: "add_light",
    description:
      "Add a point or spot light where a light source exists in the scene (a lamp, a fire, a screen). " +
      "Sunlight and overall mood belong to set_environment.",
    schema: AddLight,
    toOps: addLight,
  }),
  tool({
    name: "update_object",
    description:
      "Change properties of an existing object, part or light in place. Only the fields you pass change.",
    schema: UpdateObject,
    toOps: updateObject,
  }),
  tool({
    name: "remove_objects",
    description: "Delete objects by id, along with everything parented under them.",
    schema: RemoveObjects,
    toOps: (input) => ({
      ops: input.ids.map((id) => ({ type: "remove", id })),
      result: `Removed ${input.ids.join(", ")}`,
    }),
  }),
  tool({
    name: "set_environment",
    description:
      "Set the sky color, sun, ambient light, ground plane, fog and the finishing grade. " +
      "Only the fields you pass change.",
    schema: SetEnvironment,
    toOps: (input) => ({ ops: [{ type: "env", patch: input }], result: "Environment updated" }),
  }),
  tool({
    name: "animate",
    description:
      "Give a group motion by setting keys for its position, rotation or scale over the clip. " +
      "Only groups move, and a group turns about its own origin, so build anything that should move as " +
      "nested groups with each origin at the joint (hip, knee, hinge, axle). Each list you pass replaces " +
      "that property's keys; properties you leave out keep theirs.",
    schema: Animate,
    toOps: animate,
  }),
  tool({
    name: "set_clip",
    description: "Set how long the animation is, its frame rate and whether it loops.",
    schema: SetClip,
    toOps: setClip,
  }),
  tool({
    name: "set_camera",
    description:
      "Place the camera that renders and recorded videos are taken from. It does not move during the clip.",
    schema: SetCamera,
    toOps: setCamera,
  }),
];

/** JSON Schema for each tool's input, as sent to the model. */
export function toolInputSchema(spec: ToolSpec): Record<string, unknown> {
  const schema = z.toJSONSchema(spec.schema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export interface ToolOutcome {
  scene: Scene;
  ops: Op[];
  result: string;
}

/**
 * Validates and runs one tool call against `scene`.
 * @throws ToolError with a message the model can act on.
 */
export function runTool(scene: Scene, name: string, input: unknown): ToolOutcome {
  const spec = TOOL_SPECS.find((t) => t.name === name);
  if (!spec) throw new ToolError(`Unknown tool "${name}".`);

  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) throw new ToolError(`Invalid input:\n${z.prettifyError(parsed.error)}`);

  try {
    const { ops, result } = spec.toOps(parsed.data, scene);
    return { scene: applyOps(scene, ops).scene, ops, result };
  } catch (err) {
    if (err instanceof OpError) throw new ToolError(err.message);
    throw err;
  }
}
