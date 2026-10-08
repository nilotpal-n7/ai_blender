/**
 * Scene model — the single source of truth for a scene.
 *
 * Conventions (shared by the viewport, the planner prompt and every exporter):
 *   - Right-handed, Y up, meters.
 *   - `position` is the object's center, relative to its parent.
 *   - `rotation` is Euler XYZ in degrees.
 *   - Primitives are unit-sized (see PRIMITIVE_INFO), so a mesh's `scale` is
 *     its size in meters.
 */

import { z } from "zod";

export const PRIMITIVES = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "pyramid",
  "torus",
  "plane",
  "wedge",
  "pine",
  "canopy",
  "rock",
] as const;
export type Primitive = (typeof PRIMITIVES)[number];

/** What a unit-scale primitive looks like. Used in the UI and the planner prompt. */
export const PRIMITIVE_INFO: Record<Primitive, string> = {
  box: "1×1×1 cube",
  sphere: "diameter 1",
  cylinder: "diameter 1, height 1, axis along Y",
  cone: "base diameter 1, height 1, apex up (+Y)",
  pyramid: "1×1 square base, height 1, apex up (+Y)",
  torus: "ring lying flat, outer diameter 1, tube thickness 0.25",
  plane: "1×1 flat square facing up (+Y); scale.y is ignored",
  wedge: "a ramp 1×1×1: full height at the back (−Z), sloping down to nothing at the front (+Z)",
  pine: "the needles of a conifer: drooping boughs in whorls, 1 wide and 1 tall, tapering to a tip",
  canopy: "a billowing mass of leaves 1×1×1, for the crown of a broadleaf tree or a bush",
  rock: "a weathered boulder 1×1×1, flatter underneath",
};

export const IdSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const MaterialSchema = z.object({
  color: ColorSchema,
  roughness: z.number().min(0).max(1),
  metalness: z.number().min(0).max(1),
  emissive: ColorSchema,
  emissiveIntensity: z.number().min(0).max(100),
  opacity: z.number().min(0).max(1),
  /**
   * How worn the finish is: 0 is factory-fresh; higher chips more of the
   * color away in patches to show bare metal underneath.
   */
  wear: z.number().min(0).max(1).default(0),
});
export type Material = z.infer<typeof MaterialSchema>;

export const LightSchema = z.object({
  type: z.enum(["point", "spot"]),
  color: ColorSchema,
  /** three.js units (candela). Roughly 5–50 reads well next to a sun of 1–3. */
  intensity: z.number().min(0).max(100000),
  /** Cutoff distance in meters; 0 means no cutoff. */
  distance: z.number().min(0),
  /** Spot half-angle in degrees. Ignored by point lights. */
  angle: z.number().min(1).max(89),
});
export type Light = z.infer<typeof LightSchema>;

/** Properties a user can hand-edit; edits are remembered in `node.pinned`. */
export const PINNABLE = [
  "position",
  "rotation",
  "scale",
  "material",
  "primitive",
  "light",
] as const;
export type Pinnable = (typeof PINNABLE)[number];

export const AuthorSchema = z.enum(["ai", "user"]);
export type Author = z.infer<typeof AuthorSchema>;

const nodeBase = {
  id: IdSchema,
  name: z.string().min(1).max(80),
  parent: IdSchema.nullable(),
  position: Vec3Schema,
  rotation: Vec3Schema,
  scale: Vec3Schema,
  visible: z.boolean(),
  /** Who created the node. */
  author: AuthorSchema,
  /** Properties the user set by hand on a node (the "human override layer"). */
  pinned: z.array(z.enum(PINNABLE)),
};

/**
 * Copies of a mesh laid out in a row or around a ring. Copy number i (counting
 * from 0, the mesh itself) is the mesh turned by i × `turn` about its parent's
 * origin and then moved by i × `step`.
 */
export const ArraySchema = z.object({
  /** How many there are in total, the original included. */
  count: z.number().int().min(1).max(64),
  /** Meters between one copy and the next, along the parent's axes. */
  step: Vec3Schema,
  /** Degrees between one copy and the next, about the parent's axes (Euler XYZ). */
  turn: Vec3Schema,
});
export type ArrayCopies = z.infer<typeof ArraySchema>;

export const GroupNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("group"),
  /**
   * Above zero, the group's solid primitive children are fused into one
   * surface, with the joins rounded over about this many meters.
   */
  blend: z.number().min(0).max(1).default(0),
});
export const MeshNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("mesh"),
  primitive: z.enum(PRIMITIVES),
  material: MaterialSchema,
  /** Radius, in meters, that a box's edges and corners are rounded by. */
  bevel: z.number().min(0).max(1).default(0),
  /** Repeats the mesh in a row or a ring. */
  array: ArraySchema.nullable().default(null),
});
export const LightNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("light"),
  light: LightSchema,
});
export const NodeSchema = z.discriminatedUnion("kind", [
  GroupNodeSchema,
  MeshNodeSchema,
  LightNodeSchema,
]);
export type GroupNode = z.infer<typeof GroupNodeSchema>;
export type MeshNode = z.infer<typeof MeshNodeSchema>;
export type LightNode = z.infer<typeof LightNodeSchema>;
export type SceneNode = z.infer<typeof NodeSchema>;

export const SunSchema = z.object({
  /** Compass direction the light comes from, degrees. 0 = from +Z, 90 = from +X. */
  azimuth: z.number(),
  /** Height above the horizon, degrees. */
  elevation: z.number().min(-90).max(90),
  intensity: z.number().min(0).max(20),
  color: ColorSchema,
});
export const GroundSchema = z.object({ visible: z.boolean(), color: ColorSchema });
export const FogSchema = z.object({
  color: ColorSchema,
  near: z.number().min(0),
  far: z.number().min(0),
});
/** The finishing pass over the rendered picture (compositing). */
export const GradeSchema = z.object({
  /** Glow around anything brighter than white. */
  bloom: z.number().min(0).max(3),
  /** Darkening toward the corners of the frame. */
  vignette: z.number().min(0).max(1),
  /** 1 leaves colors as they are; 0 is black and white. */
  saturation: z.number().min(0).max(2),
  /** 0 leaves contrast as it is. */
  contrast: z.number().min(-1).max(1),
});
export type Grade = z.infer<typeof GradeSchema>;

export const DEFAULT_GRADE: Grade = { bloom: 0.75, vignette: 0, saturation: 1, contrast: 0 };

export const EnvironmentSchema = z.object({
  background: ColorSchema,
  ambient: z.number().min(0).max(10),
  sun: SunSchema,
  ground: GroundSchema,
  fog: FogSchema.nullable(),
  grade: GradeSchema.default(() => ({ ...DEFAULT_GRADE })),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/** The camera a render or a recording is taken from. */
export const CameraSchema = z.object({
  position: Vec3Schema,
  target: Vec3Schema,
  /** Vertical field of view in degrees. */
  fov: z.number().min(5).max(120),
});
export type Camera = z.infer<typeof CameraSchema>;

export const DEFAULT_CAMERA: Camera = { position: [7, 5, 9], target: [0, 1, 0], fov: 45 };

// ─── Animation ──────────────────────────────────────────────────────

export const ANIMATABLE = ["position", "rotation", "scale"] as const;
export type Animatable = (typeof ANIMATABLE)[number];

export const KeySchema = z.object({
  /** Time in seconds from the start of the clip. */
  t: z.number().min(0),
  value: Vec3Schema,
  /** How the value travels from this key to the next one. */
  ease: z.enum(["smooth", "linear", "hold"]).default("smooth"),
});
export type Key = z.infer<typeof KeySchema>;

/** The motion of one property of one group over the clip. */
export const TrackSchema = z.object({
  node: IdSchema,
  property: z.enum(ANIMATABLE),
  /** Sorted by time, at least one. */
  keys: z.array(KeySchema).min(1).max(2000),
});
export type Track = z.infer<typeof TrackSchema>;

export const ClipSchema = z.object({
  /** Length in seconds. */
  duration: z.number().min(0.1).max(120),
  fps: z.number().int().min(1).max(60),
  loop: z.boolean(),
  tracks: z.array(TrackSchema),
});
export type Clip = z.infer<typeof ClipSchema>;

export const DEFAULT_CLIP: Clip = { duration: 4, fps: 24, loop: true, tracks: [] };

export const SceneSchema = z.object({
  environment: EnvironmentSchema,
  /** Keyed by node id. Insertion order is the outliner order. */
  nodes: z.record(IdSchema, NodeSchema),
  camera: CameraSchema.default(() => structuredClone(DEFAULT_CAMERA)),
  clip: ClipSchema.default(() => structuredClone(DEFAULT_CLIP)),
});
export type Scene = z.infer<typeof SceneSchema>;

// ─── Operations ─────────────────────────────────────────────────────

export const NodePatchSchema = z
  .object({
    name: nodeBase.name,
    parent: nodeBase.parent,
    position: Vec3Schema,
    rotation: Vec3Schema,
    scale: Vec3Schema,
    visible: z.boolean(),
    primitive: z.enum(PRIMITIVES),
    material: MaterialSchema.partial(),
    light: LightSchema.partial(),
    blend: z.number().min(0).max(1),
    bevel: z.number().min(0).max(1),
    array: ArraySchema.nullable(),
    pinned: nodeBase.pinned,
  })
  .partial();
export type NodePatch = z.infer<typeof NodePatchSchema>;

export const EnvPatchSchema = z
  .object({
    background: ColorSchema,
    ambient: EnvironmentSchema.shape.ambient,
    sun: SunSchema.partial(),
    ground: GroundSchema.partial(),
    fog: FogSchema.nullable(),
    grade: GradeSchema.partial(),
  })
  .partial();
export type EnvPatch = z.infer<typeof EnvPatchSchema>;

export const ClipPatchSchema = ClipSchema.pick({ duration: true, fps: true, loop: true }).partial();
export type ClipPatch = z.infer<typeof ClipPatchSchema>;

export const OpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), node: NodeSchema }),
  z.object({ type: z.literal("update"), id: IdSchema, patch: NodePatchSchema }),
  /** Removes the node and everything parented under it. */
  z.object({ type: z.literal("remove"), id: IdSchema }),
  z.object({ type: z.literal("env"), patch: EnvPatchSchema }),
  z.object({ type: z.literal("camera"), patch: CameraSchema.partial() }),
  z.object({ type: z.literal("clip"), patch: ClipPatchSchema }),
  /** Replaces the keys of one property of a group; no keys removes the track. */
  z.object({
    type: z.literal("animate"),
    id: IdSchema,
    property: z.enum(ANIMATABLE),
    keys: z.array(KeySchema).max(2000),
  }),
]);
export type Op = z.infer<typeof OpSchema>;

// ─── Document ───────────────────────────────────────────────────────

/** One undoable step: everything a single prompt or a single hand edit did. */
export const TurnSchema = z.object({
  id: z.string(),
  author: AuthorSchema,
  label: z.string(),
  ops: z.array(OpSchema),
  /** Applying these in order undoes `ops`. */
  inverse: z.array(OpSchema),
  at: z.number(),
  /** Rapid edits with the same key merge into one step. */
  key: z.string().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const ChatStatsSchema = z.object({
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
});
export type ChatStats = z.infer<typeof ChatStatsSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.number(),
  stats: ChatStatsSchema.optional(),
  planner: z.string().optional(),
  error: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const SceneDocSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{8,32}$/),
  name: z.string().min(1).max(120),
  createdAt: z.number(),
  updatedAt: z.number(),
  scene: SceneSchema,
  chat: z.array(ChatMessageSchema),
  undo: z.array(TurnSchema),
  redo: z.array(TurnSchema),
});
export type SceneDoc = z.infer<typeof SceneDocSchema>;

// ─── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_MATERIAL: Material = {
  color: "#b8bcc8",
  roughness: 0.6,
  metalness: 0,
  emissive: "#000000",
  emissiveIntensity: 0,
  opacity: 1,
  wear: 0,
};

export const DEFAULT_LIGHT: Light = {
  type: "point",
  color: "#fff1d6",
  intensity: 20,
  distance: 0,
  angle: 35,
};

export const DEFAULT_ENVIRONMENT: Environment = {
  background: "#151823",
  ambient: 0.6,
  sun: { azimuth: 35, elevation: 50, intensity: 2.2, color: "#fff4e0" },
  ground: { visible: true, color: "#2a2d3a" },
  fog: null,
  grade: DEFAULT_GRADE,
};

export function emptyScene(): Scene {
  return {
    environment: structuredClone(DEFAULT_ENVIRONMENT),
    nodes: {},
    camera: structuredClone(DEFAULT_CAMERA),
    clip: structuredClone(DEFAULT_CLIP),
  };
}

export const MAX_NODES = 2000;
export const MAX_HISTORY = 100;
