/**
 * Offline planner — a keyword parser over a small library of objects.
 *
 * It exists so the editor works end to end with no API key, and so the
 * streaming path has a deterministic implementation to test against. It goes
 * through the same tools as Claude, so both planners produce the same ops.
 */

import { childIds, descendantIds, uniqueId } from "@/scene/ops";
import type { EnvPatch, Scene } from "@/scene/types";
import { COLORS, RECIPES, type Recipe } from "./recipes";
import { runTool } from "./tools";
import type { Emit, PlanInput, Planner } from "./types";

const COUNTS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, couple: 2, three: 3, few: 3, some: 3, four: 4,
  several: 4, five: 5, six: 6, many: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
};
const SIZES: Record<string, number> = {
  tiny: 0.4, small: 0.6, little: 0.6, big: 1.5, large: 1.5, huge: 2, giant: 2.5, enormous: 2.5,
};
const DETERMINERS = new Set(["the", "all", "every", "each", "this", "that", "these", "those", "my"]);
const REMOVE_VERBS = new Set(["delete", "remove", "erase"]);
const RECOLOR_VERBS = new Set(["make", "paint", "color", "colour", "recolor", "turn"]);
const POINTERS = new Set(["it", "this", "that", "selected", "selection", "them"]);
const MAX_COUNT = 24;

const MOODS: { words: string[]; label: string; patch: EnvPatch }[] = [
  {
    words: ["night", "midnight", "nighttime"],
    label: "night",
    patch: {
      background: "#070a14",
      ambient: 0.15,
      sun: { elevation: 35, intensity: 0.2, color: "#9db4ff" },
      ground: { color: "#151821" },
    },
  },
  {
    words: ["sunset", "dusk", "sunrise", "dawn"],
    label: "sunset",
    patch: {
      background: "#e2875a",
      ambient: 0.45,
      sun: { elevation: 8, intensity: 1.4, color: "#ffb070" },
    },
  },
  {
    words: ["day", "daytime", "noon", "sunny", "daylight"],
    label: "daylight",
    patch: {
      background: "#9cc4ee",
      ambient: 0.7,
      sun: { elevation: 55, intensity: 2.4, color: "#fff4e0" },
      ground: { color: "#5f7a4c" },
    },
  },
];

const NOUNS = new Map<string, Recipe>(RECIPES.flatMap((r) => r.words.map((w) => [w, r])));
const IRREGULAR_PLURALS: Record<string, string> = { snowman: "snowmen", person: "people" };
const isPlural = (word: string) =>
  word !== "torus" && (word.endsWith("s") || Object.values(IRREGULAR_PLURALS).includes(word));

interface Item {
  recipe: Recipe;
  index: number;
  count: number;
  color?: string;
  colorWord?: string;
  factor: number;
  glow: boolean;
  metal: boolean;
  glass: boolean;
  definite: boolean;
  /** Index into the item list of the thing this one stands on. */
  on?: number;
}

function tokenize(prompt: string): string[] {
  return prompt.toLowerCase().replace(/spot ?lights?/g, "spotlight").match(/[a-z]+|\d+/g) ?? [];
}

function parseItems(tokens: string[]): Item[] {
  const items: Item[] = [];
  tokens.forEach((token, index) => {
    const recipe = NOUNS.get(token);
    if (!recipe) return;
    const item: Item = {
      recipe, index, count: 1, factor: 1, glow: false, metal: false, glass: false, definite: false,
    };
    // Modifiers sit just before the noun: "three big red cubes".
    for (let i = index - 1; i >= Math.max(0, index - 5); i--) {
      const word = tokens[i];
      if (NOUNS.has(word) || word === "on" || word === "and" || word === "with") break;
      if (word in COLORS) {
        item.color ??= COLORS[word];
        item.colorWord ??= word;
      } else if (word in SIZES) item.factor = SIZES[word];
      else if (word in COUNTS) item.count = COUNTS[word];
      else if (/^\d+$/.test(word)) item.count = Number(word);
      else if (word === "glowing" || word === "neon") item.glow = true;
      else if (word === "metal" || word === "metallic") item.metal = true;
      else if (word === "glass") item.glass = true;
      if (DETERMINERS.has(word)) item.definite = true;
    }
    item.count = Math.min(Math.max(item.count, 1), MAX_COUNT);
    items.push(item);
  });

  // "a cube on a table": the earlier item stands on the later one.
  for (let i = 0; i + 1 < items.length; i++) {
    const between = tokens.slice(items[i].index + 1, items[i + 1].index);
    const on = between.findIndex((w) => w === "on" || w === "atop" || w === "onto");
    const sideways = between.some((w) => w === "left" || w === "right" || w === "side");
    if (on >= 0 && !sideways) items[i].on = i + 1;
  }
  return items;
}

// ─── Placement ──────────────────────────────────────────────────────

interface Footprint {
  x: number;
  z: number;
  r: number;
}

function footprintOf(scene: Scene, id: string): Footprint {
  const node = scene.nodes[id];
  const spread = Math.max(node.scale[0], node.scale[2]);
  let r = node.kind === "mesh" ? spread / 2 : 0.2;
  for (const childId of childIds(scene, id)) {
    const child = scene.nodes[childId];
    const reach =
      Math.hypot(child.position[0], child.position[2]) + Math.max(child.scale[0], child.scale[2]) / 2;
    r = Math.max(r, reach * (node.kind === "mesh" ? 1 : spread));
  }
  return { x: node.position[0], z: node.position[2], r };
}

/** First free spot on an outward spiral from the origin. */
function findSpot(taken: Footprint[], r: number): [number, number] {
  for (let k = 0; k < 600; k++) {
    const radius = 0.9 * Math.sqrt(k);
    const angle = k * 2.399963; // golden angle: even coverage with no rows
    const x = Math.round(radius * Math.sin(angle) * 100) / 100;
    const z = Math.round(radius * Math.cos(angle) * 100) / 100;
    if (taken.every((t) => Math.hypot(t.x - x, t.z - z) >= t.r + r + 0.25)) return [x, z];
  }
  return [0, 0];
}

// ─── Planner ────────────────────────────────────────────────────────

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (recipe: Recipe, n: number) =>
  n === 1 ? `a ${recipe.label}` : `${n} ${IRREGULAR_PLURALS[recipe.label] ?? `${recipe.label}s`}`;

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function matching(scene: Scene, recipe: Recipe): string[] {
  return childIds(scene, null).filter((id) =>
    scene.nodes[id].name.toLowerCase().includes(recipe.label),
  );
}

const HELP =
  "The offline planner only knows a few things: " +
  list(RECIPES.map((r) => r.label)) +
  ", plus spotlights, colors, sizes, counts, “on”, and moods like night or sunset. " +
  "Set ANTHROPIC_API_KEY in .env.local to describe anything in plain language.";

export function createOfflinePlanner({ delayMs = 90 }: { delayMs?: number } = {}): Planner {
  return {
    name: "offline",

    async run(input: PlanInput, emit: Emit, signal: AbortSignal) {
      let scene = input.scene;
      const call = async (name: string, toolInput: unknown) => {
        const outcome = runTool(scene, name, toolInput);
        scene = outcome.scene;
        emit({ type: "ops", ops: outcome.ops });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        signal.throwIfAborted();
      };

      const tokens = tokenize(input.prompt);
      const has = (words: Iterable<string>) => [...words].some((w) => tokens.includes(w));
      const items = parseItems(tokens);
      const added: string[] = [];
      const other: string[] = [];

      // Clear the scene.
      const everything = has(["everything", "all", "scene"]) && items.length === 0;
      if ((has(["clear", "reset", "empty"]) || (has(REMOVE_VERBS) && everything)) && items.length === 0) {
        const roots = [...childIds(scene, null)];
        if (roots.length > 0) await call("remove_objects", { ids: roots });
        emit({ type: "text", delta: roots.length > 0 ? "Cleared the scene." : "The scene is already empty." });
        return;
      }

      // Mood.
      for (const mood of MOODS) {
        if (!has(mood.words)) continue;
        await call("set_environment", mood.patch);
        other.push(`Set the mood to ${mood.label}.`);
        break;
      }
      if (has(["fog", "foggy", "mist", "misty"])) {
        await call("set_environment", {
          fog: { color: scene.environment.background, near: 8, far: 45 },
        });
        other.push("Added fog.");
      }

      // Remove named things.
      if (has(REMOVE_VERBS)) {
        const removed: string[] = [];
        for (const item of items) {
          const found = matching(scene, item.recipe);
          const all = isPlural(tokens[item.index]) || has(["all", "every"]);
          const ids = all ? found : found.slice(-1);
          if (ids.length === 0) continue;
          await call("remove_objects", { ids });
          removed.push(plural(item.recipe, ids.length));
        }
        emit({
          type: "text",
          delta: removed.length > 0 ? `Removed ${list(removed)}.` : "Nothing in the scene matches that.",
        });
        return;
      }

      // Recolor existing things: "make the table blue", "paint it red".
      const colorWord = tokens.find((t) => t in COLORS);
      if (has(RECOLOR_VERBS) && colorWord) {
        const tint = (rootId: string, recipe?: Recipe): string[] => {
          const names = recipe && new Set(recipe.parts.filter((p) => p.color === "tint").map((p) => p.name));
          return [rootId, ...descendantIds(scene, rootId)].filter((id) => {
            const node = scene.nodes[id];
            return node.kind === "mesh" && (!names || node.parent === null || names.has(node.name));
          });
        };
        let targets: string[] = [];
        const existing = items.filter((i) => i.definite && matching(scene, i.recipe).length > 0);
        if (existing.length > 0) {
          targets = existing.flatMap((item) =>
            matching(scene, item.recipe).flatMap((id) => tint(id, item.recipe)),
          );
        } else if (items.length === 0 && has(POINTERS)) {
          targets = input.selection.filter((id) => id in scene.nodes).flatMap((id) => tint(id));
        }
        if (targets.length > 0) {
          for (const id of targets) {
            await call("update_object", { id, material: { color: COLORS[colorWord] } });
          }
          emit({ type: "text", delta: `Painted ${existing.length > 0 ? list(existing.map((i) => `the ${i.recipe.label}`)) : "the selection"} ${colorWord}.` });
          return;
        }
      }

      // Add things. Supports go first so whatever stands on them knows where.
      const taken = childIds(scene, null).map((id) => footprintOf(scene, id));
      const placed = new Map<number, { x: number; z: number; top: number }[]>();
      const indices = items.map((_, i) => i);
      const order = [
        ...indices.filter((i) => items[i].on === undefined),
        ...indices.filter((i) => items[i].on !== undefined).reverse(),
      ];
      let firstSpot: { x: number; z: number } | null = null;
      let serial = Object.keys(scene.nodes).length;

      for (const i of order) {
        const item = items[i];
        const { recipe, factor } = item;
        const supports = item.on !== undefined ? placed.get(item.on) : undefined;
        const spots: { x: number; z: number; top: number }[] = [];

        for (let n = 0; n < item.count; n++) {
          // Natural things vary a little, deterministically, so reruns match.
          const vary = recipe.natural ? 0.8 + ((serial * 37) % 41) / 100 : 1;
          const f = factor * vary;
          const turn = recipe.natural ? (serial * 67) % 360 : 0;
          serial++;

          let x: number, z: number, y = 0;
          if (supports && supports.length > 0) {
            const support = supports[n % supports.length];
            const offset = (n - (item.count - 1) / 2) * recipe.radius * 2.2 * f;
            [x, y, z] = [support.x + offset, support.top, support.z];
          } else {
            [x, z] = findSpot(taken, recipe.radius * f);
            taken.push({ x, z, r: recipe.radius * f });
          }
          firstSpot ??= { x, z };
          spots.push({ x, z, top: y + recipe.top * f });

          const tintColor = item.color ?? recipe.tint;
          const material = (part: Recipe["parts"][number]) => {
            const tinted = part.color === "tint";
            const color = tinted ? tintColor : part.color;
            const glow = part.glow ?? (tinted && item.glow ? 2 : 0);
            return {
              color,
              ...(part.roughness !== undefined && { roughness: part.roughness }),
              ...(part.metalness !== undefined && { metalness: part.metalness }),
              ...(tinted && item.metal && { metalness: 1, roughness: 0.3 }),
              ...(tinted && item.glass && { opacity: 0.35, roughness: 0.1 }),
              ...(glow > 0 && { emissive: color, emissiveIntensity: glow }),
            };
          };
          const id = uniqueId(scene, recipe.label);
          const name = capitalize([item.colorWord, recipe.label].filter(Boolean).join(" "));

          if (recipe.single) {
            const part = recipe.parts[0];
            await call("add_object", {
              id, name,
              position: [x, y + (part.scale[1] * f) / 2, z],
              rotation: [0, turn, 0],
              scale: part.scale.map((s) => s * f),
              primitive: part.primitive,
              material: material(part),
            });
          } else {
            await call("add_object", {
              id, name,
              position: [x, y, z],
              rotation: [0, turn, 0],
              ...(f !== 1 && { scale: [f, f, f] }),
              parts: recipe.parts.map((part) => ({
                name: part.name,
                primitive: part.primitive,
                position: part.position,
                rotation: part.rotation,
                scale: part.scale,
                material: material(part),
              })),
            });
            if (recipe.light) {
              await call("add_light", {
                id: `${id}_light`, name: `${name} light`, parent: id,
                type: "point", position: recipe.light.position,
                color: recipe.light.color, intensity: recipe.light.intensity, distance: 12,
              });
            }
          }
        }
        placed.set(i, spots);
        added.push(plural(recipe, item.count));
      }

      if (tokens.includes("spotlight")) {
        const target = firstSpot ?? { x: 0, z: 0 };
        const n = Object.values(scene.nodes).filter((node) => node.kind === "light").length;
        await call("add_light", {
          id: `spotlight_${n + 1}`, name: "Spotlight", type: "spot",
          position: [target.x, 5, target.z], color: "#fff3d6", intensity: 120, angle: 28,
        });
        added.push("a spotlight");
      }

      if (added.length > 0) other.unshift(`Added ${list(added)}.`);
      emit({ type: "text", delta: other.length > 0 ? other.join(" ") : HELP });
    },
  };
}
