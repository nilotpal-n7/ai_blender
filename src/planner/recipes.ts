/**
 * Parametric objects for the offline planner. Dimensions are meters; a
 * recipe's origin is on the ground at its center, like the groups Claude builds.
 */

import type { Primitive, Vec3 } from "@/scene/types";

export interface RecipePart {
  name: string;
  primitive: Primitive;
  position: Vec3;
  rotation?: Vec3;
  scale: Vec3;
  /** A hex color, or "tint" to take the color the user asked for. */
  color: string;
  roughness?: number;
  metalness?: number;
  /** Makes the part emissive in its own color. */
  glow?: number;
}

export interface Recipe {
  label: string;
  words: string[];
  /** Color of the "tint" parts when the prompt names none. */
  tint: string;
  /** Footprint radius, used to keep objects from overlapping. */
  radius: number;
  /** Height of the surface other things can stand on. */
  top: number;
  /** Trees and rocks get a varied rotation and size. */
  natural?: boolean;
  /** One bare primitive instead of a group of parts. */
  single?: boolean;
  parts: RecipePart[];
  light?: { position: Vec3; intensity: number; color: string };
}

const WOOD = "#8a5a2b";
const DARK = "#22242b";

const legs = (x: number, z: number, size: Vec3, color = "tint"): RecipePart[] =>
  [
    [x, z],
    [-x, z],
    [x, -z],
    [-x, -z],
  ].map(([lx, lz], i) => ({
    name: `leg ${i + 1}`,
    primitive: "box",
    position: [lx, size[1] / 2, lz],
    scale: size,
    color,
    roughness: 0.8,
  }));

const shape = (
  label: string,
  words: string[],
  primitive: Primitive,
  scale: Vec3,
  tint = "#b8bcc8",
): Recipe => ({
  label,
  words,
  tint,
  radius: Math.max(scale[0], scale[2]) / 2,
  top: scale[1],
  single: true,
  parts: [{ name: label, primitive, position: [0, scale[1] / 2, 0], scale, color: "tint" }],
});

export const RECIPES: Recipe[] = [
  shape("cube", ["cube", "cubes", "box", "boxes", "block", "blocks", "crate", "crates"], "box", [0.6, 0.6, 0.6]),
  shape("sphere", ["sphere", "spheres", "ball", "balls", "orb", "orbs"], "sphere", [0.7, 0.7, 0.7]),
  shape("cylinder", ["cylinder", "cylinders", "pillar", "pillars", "column", "columns"], "cylinder", [0.6, 1.6, 0.6]),
  shape("cone", ["cone", "cones"], "cone", [0.8, 1.2, 0.8]),
  shape("pyramid", ["pyramid", "pyramids"], "pyramid", [1.6, 1.3, 1.6], "#d8b56a"),
  shape("ring", ["ring", "rings", "torus", "donut", "donuts"], "torus", [1, 1, 1], "#d9a441"),
  {
    label: "table",
    words: ["table", "tables", "desk", "desks"],
    tint: WOOD,
    radius: 0.9,
    top: 0.75,
    parts: [
      { name: "top", primitive: "box", position: [0, 0.72, 0], scale: [1.4, 0.06, 0.8], color: "tint", roughness: 0.7 },
      ...legs(0.62, 0.32, [0.07, 0.69, 0.07]),
    ],
  },
  {
    label: "chair",
    words: ["chair", "chairs", "stool", "stools"],
    tint: WOOD,
    radius: 0.42,
    top: 0.475,
    parts: [
      { name: "seat", primitive: "box", position: [0, 0.45, 0], scale: [0.45, 0.05, 0.45], color: "tint", roughness: 0.7 },
      { name: "back", primitive: "box", position: [0, 0.74, -0.2], scale: [0.45, 0.53, 0.05], color: "tint", roughness: 0.7 },
      ...legs(0.19, 0.19, [0.05, 0.43, 0.05]),
    ],
  },
  {
    label: "tree",
    words: ["tree", "trees", "pine", "pines", "fir", "firs"],
    tint: "#2f6b3a",
    radius: 1.2,
    top: 4.6,
    natural: true,
    parts: [
      { name: "trunk", primitive: "cone", position: [0, 2.2, 0], scale: [0.36, 4.4, 0.36], color: "#5b3a22", roughness: 0.9 },
      { name: "needles", primitive: "pine", position: [0, 2.75, 0], scale: [2.4, 3.9, 2.4], color: "tint", roughness: 0.85 },
    ],
  },
  {
    label: "rock",
    words: ["rock", "rocks", "boulder", "boulders", "stone", "stones"],
    tint: "#7d8088",
    radius: 0.7,
    top: 0.7,
    natural: true,
    single: true,
    parts: [
      { name: "rock", primitive: "rock", position: [0, 0.35, 0], scale: [1.25, 0.7, 1.05], color: "tint", roughness: 0.95 },
    ],
  },
  {
    label: "house",
    words: ["house", "houses", "cabin", "cabins", "hut", "huts", "cottage", "cottages"],
    tint: "#d9c7a3",
    radius: 3,
    top: 4.2,
    parts: [
      { name: "walls", primitive: "box", position: [0, 1.3, 0], scale: [4, 2.6, 3.5], color: "tint", roughness: 0.9 },
      { name: "roof", primitive: "pyramid", position: [0, 3.4, 0], scale: [4.7, 1.6, 4.2], color: "#9c3d2e", roughness: 0.8 },
      { name: "door", primitive: "box", position: [0, 0.95, 1.76], scale: [0.9, 1.9, 0.08], color: "#5a3a22", roughness: 0.7 },
      { name: "window left", primitive: "box", position: [-1.25, 1.5, 1.76], scale: [0.8, 0.8, 0.06], color: "#ffd98a", glow: 1.5 },
      { name: "window right", primitive: "box", position: [1.25, 1.5, 1.76], scale: [0.8, 0.8, 0.06], color: "#ffd98a", glow: 1.5 },
    ],
  },
  {
    label: "car",
    words: ["car", "cars", "truck", "trucks", "vehicle", "vehicles"],
    tint: "#c0392b",
    radius: 2.4,
    top: 1.55,
    parts: [
      { name: "body", primitive: "box", position: [0, 0.62, 0], scale: [4.2, 0.6, 1.8], color: "tint", roughness: 0.3, metalness: 0.4 },
      { name: "cabin", primitive: "box", position: [-0.2, 1.2, 0], scale: [2.2, 0.6, 1.6], color: "tint", roughness: 0.3, metalness: 0.4 },
      ...[
        [1.35, 0.92],
        [-1.35, 0.92],
        [1.35, -0.92],
        [-1.35, -0.92],
      ].map(
        ([x, z], i): RecipePart => ({
          name: `wheel ${i + 1}`,
          primitive: "cylinder",
          position: [x, 0.35, z],
          rotation: [90, 0, 0],
          scale: [0.7, 0.25, 0.7],
          color: DARK,
          roughness: 0.9,
        }),
      ),
    ],
  },
  {
    label: "snowman",
    words: ["snowman", "snowmen"],
    tint: "#f4f6fa",
    radius: 0.6,
    top: 2,
    parts: [
      { name: "base", primitive: "sphere", position: [0, 0.5, 0], scale: [1, 1, 1], color: "tint", roughness: 0.9 },
      { name: "torso", primitive: "sphere", position: [0, 1.2, 0], scale: [0.72, 0.72, 0.72], color: "tint", roughness: 0.9 },
      { name: "head", primitive: "sphere", position: [0, 1.75, 0], scale: [0.48, 0.48, 0.48], color: "tint", roughness: 0.9 },
      { name: "nose", primitive: "cone", position: [0, 1.75, 0.32], rotation: [90, 0, 0], scale: [0.08, 0.26, 0.08], color: "#f08a24" },
      { name: "eye left", primitive: "sphere", position: [-0.09, 1.83, 0.21], scale: [0.05, 0.05, 0.05], color: DARK },
      { name: "eye right", primitive: "sphere", position: [0.09, 1.83, 0.21], scale: [0.05, 0.05, 0.05], color: DARK },
    ],
  },
  {
    label: "person",
    words: ["person", "people", "character", "characters", "man", "woman", "figure", "figures"],
    tint: "#3f6fb5",
    radius: 0.4,
    top: 1.75,
    parts: [
      { name: "leg left", primitive: "box", position: [-0.1, 0.42, 0], scale: [0.15, 0.84, 0.17], color: "#2b2f3a", roughness: 0.8 },
      { name: "leg right", primitive: "box", position: [0.1, 0.42, 0], scale: [0.15, 0.84, 0.17], color: "#2b2f3a", roughness: 0.8 },
      { name: "torso", primitive: "box", position: [0, 1.14, 0], scale: [0.42, 0.6, 0.24], color: "tint", roughness: 0.8 },
      { name: "arm left", primitive: "box", position: [-0.28, 1.12, 0], scale: [0.11, 0.6, 0.13], color: "tint", roughness: 0.8 },
      { name: "arm right", primitive: "box", position: [0.28, 1.12, 0], scale: [0.11, 0.6, 0.13], color: "tint", roughness: 0.8 },
      { name: "head", primitive: "sphere", position: [0, 1.6, 0], scale: [0.26, 0.3, 0.26], color: "#e2b48c", roughness: 0.7 },
    ],
  },
  {
    label: "lamp",
    words: ["lamp", "lamps", "lantern", "lanterns", "streetlight", "streetlights"],
    tint: "#3a3d47",
    radius: 0.3,
    top: 1.8,
    parts: [
      { name: "base", primitive: "cylinder", position: [0, 0.02, 0], scale: [0.36, 0.04, 0.36], color: "tint", metalness: 1, roughness: 0.4 },
      { name: "pole", primitive: "cylinder", position: [0, 0.78, 0], scale: [0.04, 1.5, 0.04], color: "tint", metalness: 1, roughness: 0.4 },
      { name: "shade", primitive: "cylinder", position: [0, 1.65, 0], scale: [0.42, 0.3, 0.42], color: "#ffe2a8", glow: 2.5 },
    ],
    light: { position: [0, 1.6, 0], intensity: 12, color: "#ffd9a0" },
  },
];

export const COLORS: Record<string, string> = {
  red: "#d6453d",
  green: "#3fa35a",
  blue: "#3d6fd6",
  yellow: "#f0c93a",
  orange: "#f08a24",
  purple: "#8e55d9",
  pink: "#f27fb2",
  white: "#f2f3f5",
  black: "#1c1d21",
  gray: "#8a8d96",
  grey: "#8a8d96",
  brown: "#7a4a23",
  gold: "#d9a441",
  golden: "#d9a441",
  silver: "#c3c7cf",
  cyan: "#35c2d6",
  teal: "#2a9d8f",
  wooden: WOOD,
  wood: WOOD,
};
