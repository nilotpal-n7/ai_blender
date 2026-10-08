// The spider mech from ./spidyrobo, as the planner tool calls that build it: a
// rig of nested groups whose origins are the joints, and a short performance
// (walk in, square up, look around, rear a leg) with the legs solved by IK.
//
// This is how the mech was planned through the bridge. It is kept as a worked
// example of a rig, and so the scene can be rebuilt:
//
//   1. run the app with PLANNER=bridge and `npm run bridge`
//   2. send any prompt in an empty scene; the listener prints the request id
//   3. node scripts/examples/spider-mech.mjs .data/bridge/<request id>
//
// With no argument it only prints what it would build.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEG = Math.PI / 180;
const r4 = (n) => Math.round(n * 1e4) / 1e4 + 0;
const v = (a) => a.map(r4);

// ─── Materials ──────────────────────────────────────────────────────
// Paint that has been knocked about for years, over steel that has started to rust.
const ORANGE = { color: "#f04c12", roughness: 0.5, metalness: 0, wear: 0.5, rust: 0.14 };
const GREY = { color: "#5d6165", roughness: 0.52, metalness: 0.75, wear: 0.36, rust: 0.2 };
const PLATE = { color: "#7f8488", roughness: 0.56, metalness: 0.7, wear: 0.3, rust: 0.12 };
const DARK = { color: "#1b1c1e", roughness: 0.66, metalness: 0.6, rust: 0.1 };
const RUBBER = { color: "#141414", roughness: 0.92, metalness: 0 };
const STEEL = { color: "#c9cdd1", roughness: 0.2, metalness: 1 };
const BLUE = { color: "#07202e", emissive: "#2fb4ff", emissiveIntensity: 8, roughness: 0.3 };
const RED = { color: "#2c0603", emissive: "#ff2a12", emissiveIntensity: 6, roughness: 0.3 };
const GLASS = { color: "#0a0d10", roughness: 0.08, metalness: 0.9 };

// ─── Part helpers ───────────────────────────────────────────────────
const part = (primitive) => (name, position, scale, material, extra = {}) => ({
  name,
  primitive,
  position: v(position),
  scale: v(scale),
  material,
  ...(extra.rotation && { rotation: v(extra.rotation) }),
  ...(extra.bevel && { bevel: extra.bevel }),
  ...(extra.taper && { taper: extra.taper }),
  ...(extra.array && { array: extra.array }),
});
const box = part("box");
const cyl = part("cylinder");
const torus = part("torus");
const wedge = part("wedge");
/** A cylinder lying along X or Z: `size` is [diameter, length]. */
const rod = (axis) => (name, position, [d, length], material, extra = {}) =>
  cyl(name, position, [d, length, d], material, {
    ...extra,
    rotation: extra.rotation ?? (axis === "x" ? [0, 0, -90] : [90, 0, 0]),
  });
const rodX = rod("x");
const rodZ = rod("z");
/**
 * A plate lying along X, `size` = [length, height, thickness], whose height
 * (and thickness) can narrow toward +X: the angular armour of the legs.
 */
const plateX = (name, position, [length, height, thickness], material, extra = {}) =>
  box(name, position, [height, length, thickness], material, { ...extra, rotation: [0, 0, -90] });
/** A block that narrows toward the ground instead of the sky. */
const hanging = (name, position, scale, material, extra = {}) =>
  box(name, position, scale, material, { ...extra, rotation: [extra.pitch ?? 0, 0, 180] });
const pair = (step) => ({ count: 2, step });
const EDGE = 0.008; // machined edges are tight; anything softer reads as plastic

const calls = [];
const add = (id, name, parent, position, rotation, parts) =>
  calls.push({
    tool: "add_object",
    input: { id, name, ...(parent && { parent }), position: v(position), rotation: v(rotation), parts },
  });

// ─── Dimensions ─────────────────────────────────────────────────────
const HUB_Y = 1.05;
const HIP = 0.34; // hip joints sit this far out along x and z
const SHOULDER = 0.2; // hip yaw axis → shoulder pitch axis
const L1 = 0.85; // shoulder → knee
const FOOT = [0.14, -1.1]; // sole of the foot in the lower leg's frame
const HOME = 1.1; // feet rest this far out along x and z
const LEGS = [
  { key: "fl", label: "front left", sx: 1, sz: 1 },
  { key: "br", label: "back right", sx: -1, sz: -1 },
  { key: "fr", label: "front right", sx: -1, sz: 1 },
  { key: "bl", label: "back left", sx: 1, sz: -1 },
];

// ─── Leg IK ─────────────────────────────────────────────────────────
const L2 = Math.hypot(...FOOT);
const PHI0 = Math.atan2(FOOT[1], FOOT[0]);

/** Rows of the rotation matrix for Euler XYZ degrees (the editor's convention). */
function rotation([x, y, z]) {
  const [a, b] = [Math.cos(x * DEG), Math.sin(x * DEG)];
  const [c, d] = [Math.cos(y * DEG), Math.sin(y * DEG)];
  const [e, f] = [Math.cos(z * DEG), Math.sin(z * DEG)];
  return [
    [c * e, -c * f, d],
    [a * f + b * e * d, a * e - b * f * d, -b * c],
    [b * f - a * e * d, b * e + a * f * d, a * c],
  ];
}
const apply = (m, p) => m.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
const transpose = (m) => m[0].map((_, i) => m.map((row) => row[i]));

/** Joint angles (degrees) that put a leg's foot at `target`, given in the hub's frame. */
function solveLeg(leg, target) {
  const rel = [target[0] - leg.sx * HIP, target[1], target[2] - leg.sz * HIP];
  const yaw = Math.atan2(-rel[2], rel[0]);
  const r = Math.hypot(rel[0], rel[2]) - SHOULDER;
  const h = rel[1];
  const reach = Math.min(Math.max(Math.hypot(r, h), Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);
  const alpha = Math.atan2(h, r) + Math.acos((L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach));
  const knee = [L1 * Math.cos(alpha), L1 * Math.sin(alpha)];
  const phi = Math.atan2(h - knee[1], r - knee[0]);
  let beta = phi - alpha - PHI0;
  while (beta > Math.PI) beta -= 2 * Math.PI;
  while (beta < -Math.PI) beta += 2 * Math.PI;
  return { yaw: yaw / DEG, upper: alpha / DEG, lower: beta / DEG };
}

/** Where the foot ends up for given joint angles: the check on solveLeg. */
function footOf(leg, { yaw, upper, lower }) {
  const a = upper * DEG;
  const b = (upper + lower) * DEG;
  const r = SHOULDER + L1 * Math.cos(a) + FOOT[0] * Math.cos(b) - FOOT[1] * Math.sin(b);
  const h = L1 * Math.sin(a) + FOOT[0] * Math.sin(b) + FOOT[1] * Math.cos(b);
  return [leg.sx * HIP + r * Math.cos(yaw * DEG), h, leg.sz * HIP - r * Math.sin(yaw * DEG)];
}

// ─── The model ──────────────────────────────────────────────────────
function buildModel(start) {
  // Hub: the root of the rig. Everything else hangs off it.
  add("spider", "Spider mech", null, [0, HUB_Y, start], [0, 0, 0], [
    cyl("core", [0, 0, 0], [0.6, 0.3, 0.6], GREY),
    cyl("deck", [0, 0.17, 0], [0.76, 0.08, 0.76], ORANGE, { taper: [0.86, 0.86] }),
    cyl("deck ring", [0, 0.125, 0], [0.8, 0.03, 0.8], DARK),
    cyl("skirt", [0, -0.13, 0], [0.7, 0.06, 0.7], ORANGE, { rotation: [180, 0, 0], taper: [0.8, 0.8] }),
    box("shoulder block", [0.262, 0, 0.262], [0.36, 0.24, 0.3], ORANGE, {
      rotation: [0, -45, 0],
      bevel: EDGE,
      taper: [0.82, 0.8],
      array: { count: 4, turn: [0, 90, 0] },
    }),
    box("shoulder cap", [0.3, 0.135, 0.3], [0.26, 0.03, 0.22], PLATE, {
      rotation: [0, -45, 0],
      bevel: 0.004,
      array: { count: 4, turn: [0, 90, 0] },
    }),
    box("side armor", [0.345, -0.01, 0], [0.07, 0.2, 0.3], GREY, {
      bevel: EDGE,
      taper: [1, 0.7],
      array: { count: 4, turn: [0, 90, 0] },
    }),
    box("side vent", [0.383, 0.02, -0.08], [0.008, 0.016, 0.16], DARK, {
      array: { count: 3, step: [0, -0.03, 0] },
    }),
    cyl("deck bolt", [0.31, 0.215, 0], [0.034, 0.02, 0.034], STEEL, { array: { count: 12, turn: [0, 30, 0] } }),
    cyl("neck seat", [0, 0.23, 0], [0.46, 0.05, 0.46], GREY, { taper: [0.9, 0.9] }),
    // The pelvis: an orange block slung under the hub.
    hanging("pelvis", [0, -0.27, 0.02], [0.36, 0.24, 0.4], ORANGE, { bevel: EDGE, taper: [0.72, 0.8] }),
    box("pelvis plate", [0, -0.27, 0.225], [0.2, 0.14, 0.012], PLATE, { bevel: 0.003 }),
    cyl("belly", [0, -0.2, 0], [0.5, 0.1, 0.5], DARK),
    cyl("drain", [0, -0.405, 0.02], [0.12, 0.04, 0.12], DARK),
  ]);

  // Neck: turns the turret left and right.
  add("spider_neck", "Neck", "spider", [0, 0.25, 0], [0, 0, 0], [
    cyl("neck core", [0, 0.14, 0], [0.25, 0.3, 0.25], DARK),
    cyl("neck rib", [0, 0.03, 0], [0.37, 0.026, 0.37], GREY, { array: { count: 7, step: [0, 0.04, 0] } }),
    cyl("neck collar", [0, 0.285, 0], [0.42, 0.03, 0.42], PLATE),
    rodX("hose clamp", [0.15, 0.1, -0.1], [0.05, 0.03], STEEL, { array: pair([-0.3, 0, 0]) }),
    cyl("hose", [0.15, 0.14, -0.1], [0.04, 0.3, 0.04], RUBBER, { rotation: [-12, 0, 0], array: pair([-0.3, 0, 0]) }),
  ]);

  // Head: nods up and down on top of the neck. Its nose points a little down.
  add("spider_head", "Head", "spider_neck", [0, 0.31, 0], [11, 0, 0], [
    cyl("turntable", [0, 0.035, 0], [0.52, 0.07, 0.52], GREY),
    box("skull", [0, 0.36, 0.06], [0.86, 0.52, 1.12], GREY, { bevel: 0.012 }),
    box("underside", [0, 0.085, 0.1], [0.6, 0.06, 0.8], DARK, { bevel: EDGE }),
    // Roof: two long orange plates with a channel between, dropping away at the front.
    box("roof plate left", [0.25, 0.655, -0.02], [0.37, 0.06, 0.98], ORANGE, { bevel: EDGE, rotation: [0, 0, -3] }),
    box("roof plate right", [-0.25, 0.655, -0.02], [0.37, 0.06, 0.98], ORANGE, { bevel: EDGE, rotation: [0, 0, 3] }),
    box("roof nose left", [0.25, 0.612, 0.6], [0.37, 0.06, 0.34], ORANGE, { bevel: EDGE, rotation: [15, 0, -3], taper: [1, 1] }),
    box("roof nose right", [-0.25, 0.612, 0.6], [0.37, 0.06, 0.34], ORANGE, { bevel: EDGE, rotation: [15, 0, 3] }),
    box("roof edge left", [0.448, 0.6, 0.02], [0.05, 0.13, 1.1], ORANGE, { bevel: 0.006, rotation: [0, 0, -24] }),
    box("roof edge right", [-0.448, 0.6, 0.02], [0.05, 0.13, 1.1], ORANGE, { bevel: 0.006, rotation: [0, 0, 24] }),
    box("roof channel", [0, 0.632, 0.05], [0.16, 0.04, 1.06], DARK),
    box("roof grille slat", [0, 0.66, 0.16], [0.13, 0.02, 0.016], PLATE, { array: { count: 9, step: [0, 0, 0.032] } }),
    box("roof spine", [0, 0.668, -0.27], [0.075, 0.035, 0.44], ORANGE, { bevel: 0.005, taper: [0.7, 1] }),
    box("roof hatch", [0, 0.652, 0.52], [0.13, 0.016, 0.16], GREY, { bevel: 0.003 }),
    // Brow: the roof overhangs the face.
    box("brow", [0, 0.585, 0.745], [0.94, 0.055, 0.2], ORANGE, { bevel: 0.006, rotation: [28, 0, 0], taper: [1, 0.7] }),
    wedge("brow cheek left", [0.445, 0.48, 0.6], [0.045, 0.2, 0.22], ORANGE, { rotation: [0, 180, 0] }),
    wedge("brow cheek right", [-0.445, 0.48, 0.6], [0.045, 0.2, 0.22], ORANGE, { rotation: [0, 180, 0] }),
    // Sides: grey above, an angular orange cheek below, two bars running back to the vent.
    hanging("cheek left", [0.442, 0.25, 0.22], [0.04, 0.33, 0.7], ORANGE, { bevel: 0.006, taper: [1, 0.62] }),
    hanging("cheek right", [-0.442, 0.25, 0.22], [0.04, 0.33, 0.7], ORANGE, { bevel: 0.006, taper: [1, 0.62] }),
    box("cheek bar", [-0.445, 0.5, 0.2], [0.03, 0.026, 0.5], ORANGE, { bevel: 0.004, array: pair([0.89, 0, 0]) }),
    box("cheek bar low", [-0.445, 0.445, 0.14], [0.03, 0.026, 0.38], ORANGE, { bevel: 0.004, array: pair([0.89, 0, 0]) }),
    box("side panel", [-0.434, 0.33, -0.34], [0.012, 0.36, 0.3], PLATE, { bevel: 0.003, array: pair([0.868, 0, 0]) }),
    rodX("side rivet", [-0.44, 0.14, 0.44], [0.03, 0.016], STEEL, { array: { count: 4, step: [0, 0, -0.16] } }),
    rodX("side rivet far", [0.44, 0.14, 0.44], [0.03, 0.016], STEEL, { array: { count: 4, step: [0, 0, -0.16] } }),
    // Chin: an orange jaw, narrower underneath, with two blue lamps.
    hanging("chin", [0, 0.16, 0.49], [0.66, 0.2, 0.34], ORANGE, { bevel: EDGE, taper: [0.8, 0.7], pitch: 6 }),
    box("lamp housing", [-0.16, 0.175, 0.662], [0.2, 0.06, 0.02], DARK, { bevel: 0.004, array: pair([0.32, 0, 0]) }),
    box("chin lamp", [-0.16, 0.175, 0.674], [0.16, 0.026, 0.012], BLUE, { array: pair([0.32, 0, 0]) }),
    box("jaw", [0, 0.07, 0.3], [0.44, 0.06, 0.4], DARK, { bevel: EDGE }),
  ]);

  // Face: a dark recess with a ribbed grille and a gun pod on each side.
  add("spider_face", "Face", "spider_head", [0, 0.41, 0.6], [0, 0, 0], [
    box("recess", [0, 0, 0], [0.8, 0.32, 0.05], DARK),
    box("grille frame", [0, 0.005, 0.02], [0.3, 0.28, 0.04], GREY, { bevel: 0.006 }),
    box("grille rib", [-0.1, 0.005, 0.045], [0.016, 0.23, 0.03], PLATE, { array: { count: 9, step: [0.025, 0, 0] } }),
    box("gun pod", [-0.29, 0, 0.03], [0.2, 0.28, 0.08], GREY, { bevel: 0.006, array: pair([0.58, 0, 0]) }),
    box("pod plate", [-0.29, -0.115, 0.075], [0.16, 0.03, 0.012], PLATE, { array: pair([0.58, 0, 0]) }),
    // Upper barrels, the long ones.
    rodZ("barrel sleeve upper", [-0.27, 0.06, 0.12], [0.092, 0.14], GREY, { array: pair([0.54, 0, 0]) }),
    rodZ("barrel upper", [-0.27, 0.06, 0.38], [0.05, 0.5], DARK, { array: pair([0.54, 0, 0]) }),
    rodZ("barrel band upper", [-0.27, 0.06, 0.3], [0.064, 0.018], STEEL, { array: pair([0.54, 0, 0]) }),
    rodZ("muzzle upper", [-0.27, 0.06, 0.655], [0.07, 0.09], ORANGE, { taper: [0.82, 0.82], array: pair([0.54, 0, 0]) }),
    rodZ("bore upper", [-0.27, 0.06, 0.7], [0.036, 0.006], RUBBER, { array: pair([0.54, 0, 0]) }),
    // Lower barrels, shorter and set wider.
    rodZ("barrel sleeve lower", [-0.33, -0.05, 0.11], [0.092, 0.12], GREY, { array: pair([0.66, 0, 0]) }),
    rodZ("barrel lower", [-0.33, -0.05, 0.32], [0.05, 0.4], DARK, { array: pair([0.66, 0, 0]) }),
    rodZ("barrel band lower", [-0.33, -0.05, 0.26], [0.064, 0.018], STEEL, { array: pair([0.66, 0, 0]) }),
    rodZ("muzzle lower", [-0.33, -0.05, 0.545], [0.07, 0.09], ORANGE, { taper: [0.82, 0.82], array: pair([0.66, 0, 0]) }),
    rodZ("bore lower", [-0.33, -0.05, 0.59], [0.036, 0.006], RUBBER, { array: pair([0.66, 0, 0]) }),
  ]);

  // Back of the head: two round sensors, a slatted exhaust and a pair of handles.
  add("spider_tail", "Head rear", "spider_head", [0, 0.4, -0.5], [0, 0, 0], [
    box("back plate", [0, 0, 0.005], [0.82, 0.48, 0.04], DARK, { bevel: EDGE }),
    rodZ("sensor housing", [-0.21, 0.01, -0.05], [0.3, 0.12], GREY, { array: pair([0.42, 0, 0]) }),
    torus("sensor bezel", [-0.21, 0.01, -0.11], [0.3, 0.2, 0.3], ORANGE, { rotation: [90, 0, 0], array: pair([0.42, 0, 0]) }),
    rodZ("sensor well", [-0.21, 0.01, -0.108], [0.22, 0.02], DARK, { array: pair([0.42, 0, 0]) }),
    rodZ("sensor eye", [0.21, 0.01, -0.118], [0.15, 0.012], RED),
    rodZ("sensor lens", [-0.21, 0.01, -0.118], [0.15, 0.012], GLASS),
    box("exhaust slat", [0, -0.14, -0.022], [0.14, 0.018, 0.02], PLATE, { array: { count: 5, step: [0, 0.035, 0] } }),
    box("handle", [-0.25, 0.31, 0.07], [0.17, 0.05, 0.11], ORANGE, {
      bevel: 0.006,
      rotation: [-26, 0, 0],
      taper: [0.8, 1],
      array: pair([0.5, 0, 0]),
    }),
    box("handle post", [-0.25, 0.275, 0.035], [0.13, 0.05, 0.03], ORANGE, { array: pair([0.5, 0, 0]) }),
    box("aerial base", [0.36, 0.26, 0.12], [0.05, 0.04, 0.05], DARK, { bevel: 0.004 }),
    cyl("aerial", [0.36, 0.5, 0.12], [0.012, 0.46, 0.012], STEEL, { taper: [0.5, 0.5] }),
  ]);

  // Vents: a turbine on each side of the head, with a fan that spins behind fixed vanes.
  for (const [side, x] of [["left", 0.455], ["right", -0.455]]) {
    const out = Math.sign(x);
    add(`spider_vent_${side}`, `Vent ${side}`, "spider_head", [x, 0.41, -0.28], [0, 0, 0], [
      rodX("housing", [out * 0.015, 0, 0], [0.46, 0.15], GREY),
      torus("shroud", [out * 0.085, 0, 0], [0.52, 0.42, 0.52], ORANGE, { rotation: [0, 0, 90] }),
      rodX("well", [out * 0.06, 0, 0], [0.37, 0.08], DARK),
      box("vane", [out * 0.098, 0.135, 0], [0.012, 0.07, 0.012], PLATE, { array: { count: 20, turn: [18, 0, 0] } }),
      rodX("vane ring", [out * 0.098, 0, 0], [0.21, 0.012], PLATE),
      rodX("bearing", [out * 0.11, 0, 0], [0.11, 0.03], STEEL, { taper: [0.6, 0.6], rotation: [0, 0, out > 0 ? -90 : 90] }),
    ]);
    add(`spider_fan_${side}`, `Fan ${side}`, `spider_vent_${side}`, [out * 0.07, 0, 0], [0, 0, 0], [
      rodX("hub", [0, 0, 0], [0.1, 0.04], DARK),
      box("blade", [0, 0.1, 0], [0.02, 0.13, 0.05], GREY, {
        rotation: [0, 28, 0],
        array: { count: 9, turn: [40, 0, 0] },
      }),
    ]);
  }

  for (const leg of LEGS) {
    const home = solveLeg(leg, [leg.sx * HOME, -HUB_Y, leg.sz * HOME]);
    const id = `spider_leg_${leg.key}`;
    // Hip: swings the whole leg forward and back about a vertical pin.
    add(`${id}_hip`, `Hip ${leg.label}`, "spider", [leg.sx * HIP, 0, leg.sz * HIP], [0, home.yaw, 0], [
      cyl("pin", [0, 0, 0], [0.12, 0.36, 0.12], STEEL),
      cyl("pin cap", [0, 0.19, 0], [0.16, 0.03, 0.16], DARK, { taper: [0.8, 0.8] }),
      plateX("clevis", [0.1, -0.125, 0], [0.34, 0.05, 0.24], ORANGE, { bevel: 0.006, taper: [1, 0.6], array: pair([0, 0.25, 0]) }),
      box("yoke", [SHOULDER, 0, 0], [0.13, 0.2, 0.11], GREY, { bevel: EDGE }),
      rodZ("shoulder axle", [SHOULDER, 0, 0], [0.085, 0.32], STEEL),
      rodZ("axle nut", [SHOULDER, 0, -0.165], [0.12, 0.02], DARK, { array: pair([0, 0, 0.33]) }),
    ]);
    // Upper leg: raises and lowers the knee. A grey beam between two angular orange plates.
    add(`${id}_upper`, `Upper leg ${leg.label}`, `${id}_hip`, [SHOULDER, 0, 0], [0, 0, home.upper], [
      box("beam", [0.4, -0.01, 0], [0.7, 0.1, 0.11], GREY, { bevel: EDGE }),
      plateX("armor", [0.36, 0, -0.085], [0.62, 0.24, 0.03], ORANGE, { bevel: 0.006, taper: [0.5, 1], array: pair([0, 0, 0.17]) }),
      rodZ("armor bolt", [0.18, 0.06, -0.104], [0.03, 0.012], STEEL, { array: { count: 3, step: [0.16, -0.025, 0] } }),
      rodZ("armor bolt far", [0.18, 0.06, 0.104], [0.03, 0.012], STEEL, { array: { count: 3, step: [0.16, -0.025, 0] } }),
      // The ram that drives the knee.
      rodX("ram", [0.26, 0.135, 0], [0.09, 0.32], GREY),
      rodX("ram gland", [0.43, 0.135, 0], [0.105, 0.04], DARK),
      rodX("ram base", [0.09, 0.135, 0], [0.1, 0.03], DARK),
      rodX("piston", [0.61, 0.135, 0], [0.04, 0.34], STEEL),
      box("piston eye", [0.79, 0.135, 0], [0.07, 0.075, 0.06], GREY, { bevel: 0.006 }),
      box("ram mount", [0.12, 0.09, 0], [0.08, 0.08, 0.09], DARK, { bevel: 0.005 }),
      cyl("line", [0.3, 0.075, 0.05], [0.018, 0.4, 0.018], RUBBER, { rotation: [0, 0, -90] }),
      // Elbow: orange cheeks around the knee axle.
      plateX("elbow", [0.79, 0.02, -0.105], [0.3, 0.34, 0.034], ORANGE, {
        bevel: 0.006,
        taper: [0.55, 1],
        array: pair([0, 0, 0.21]),
      }),
      rodZ("knee axle", [L1, 0, 0], [0.075, 0.32], STEEL),
    ]);
    // Lower leg: the armoured shin, hinged at the knee.
    add(`${id}_lower`, `Lower leg ${leg.label}`, `${id}_upper`, [L1, 0, 0], [0, 0, home.lower], [
      rodZ("knee wheel", [0, 0, 0], [0.29, 0.12], GREY),
      torus("knee tyre", [0, 0, 0], [0.31, 0.28, 0.31], DARK, { rotation: [90, 0, 0] }),
      rodZ("knee cap", [0, 0, 0], [0.13, 0.16], STEEL),
      box("knee bracket", [0.08, -0.07, 0], [0.2, 0.22, 0.15], GREY, { bevel: EDGE }),
      // The frame the armour bolts to.
      box("spine", [0.105, -0.5, 0], [0.12, 1.1, 0.24], DARK, { bevel: EDGE }),
      rodZ("spine pin", [0.1, -0.22, 0], [0.05, 0.3], STEEL, { array: { count: 3, step: [0, -0.3, 0] } }),
      cyl("strut", [0.02, -0.5, 0.08], [0.03, 0.6, 0.03], STEEL, { array: pair([0, 0, -0.16]) }),
      cyl("strut sleeve", [0.02, -0.3, 0.08], [0.046, 0.2, 0.046], DARK, { array: pair([0, 0, -0.16]) }),
      // Thigh armour: the big orange block, chamfered toward the top, with vents and a grab handle.
      box("thigh armor", [0.175, 0.06, 0], [0.26, 0.5, 0.39], ORANGE, { bevel: 0.01, taper: [0.72, 0.8] }),
      box("thigh flange", [0.175, -0.2, 0], [0.275, 0.03, 0.4], PLATE, { bevel: 0.004 }),
      box("vent slit", [0.302, 0.05, 0.02], [0.02, 0.018, 0.19], DARK, { array: { count: 4, step: [0, -0.042, 0] } }),
      box("handle post", [0.175, 0.325, -0.08], [0.03, 0.06, 0.028], ORANGE, { array: pair([0, 0, 0.16]) }),
      box("handle bar", [0.175, 0.362, 0], [0.036, 0.028, 0.2], ORANGE, { bevel: 0.005 }),
      rodX("thigh bolt", [0.305, -0.14, -0.15], [0.03, 0.014], STEEL, { array: pair([0, 0, 0.3]) }),
      // Shin: a grey plate with an inset panel and two cut lines.
      box("shin plate", [0.17, -0.43, 0], [0.2, 0.44, 0.36], GREY, { bevel: EDGE }),
      box("shin panel", [0.272, -0.42, 0], [0.012, 0.3, 0.24], PLATE, { bevel: 0.004 }),
      box("shin groove", [0.273, -0.33, 0], [0.016, 0.01, 0.34], DARK, { array: pair([0, -0.19, 0]) }),
      rodX("shin bolt", [0.279, -0.29, -0.095], [0.022, 0.01], STEEL, { array: pair([0, 0, 0.19]) }),
      rodX("shin bolt low", [0.279, -0.55, -0.095], [0.022, 0.01], STEEL, { array: pair([0, 0, 0.19]) }),
      // Guard and flaps: orange again toward the foot.
      hanging("shin guard", [0.175, -0.79, 0], [0.24, 0.3, 0.39], ORANGE, { bevel: 0.01, taper: [0.8, 0.86] }),
      box("side flap", [0.07, -0.62, -0.2], [0.2, 0.56, 0.03], ORANGE, { bevel: 0.006, taper: [0.6, 1], array: pair([0, 0, 0.4]) }),
      // Foot.
      hanging("toe", [0.19, -0.99, 0], [0.22, 0.14, 0.27], ORANGE, { bevel: EDGE, taper: [0.86, 0.9] }),
      box("ankle", [0.12, -0.93, 0], [0.14, 0.08, 0.2], DARK, { bevel: 0.005 }),
      box("sole", [0.15, -1.08, 0], [0.27, 0.045, 0.31], RUBBER, { bevel: 0.01 }),
      box("tread", [0.04, -1.1, 0], [0.03, 0.012, 0.29], RUBBER, { array: { count: 5, step: [0.055, 0, 0] } }),
    ]);
  }
}

// ─── The performance ────────────────────────────────────────────────
const DURATION = 8;
const RATE = 12; // IK is sampled this many times a second and played back linearly
const START_Z = -1.8;
const END_Z = 1.0;
const WALK = [0.4, 5.2];
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const span = (t, a, b) => smooth((t - a) / (b - a));

/** How far along the walk the body is, 0..1, easing in and out. */
const progress = (t) => {
  const u = Math.min(Math.max((t - WALK[0]) / (WALK[1] - WALK[0]), 0), 1);
  // Gentle ends, steady middle.
  return u < 0.15 ? (u * u) / 0.255 : u > 0.85 ? 1 - ((1 - u) * (1 - u)) / 0.255 : (u - 0.075) / 0.85;
};
const striding = (t) => span(t, WALK[0], WALK[0] + 0.5) * (1 - span(t, WALK[1] - 0.5, WALK[1]));

/** The hub's position and rotation at time `t`. */
function body(t) {
  const walk = striding(t);
  // Weight shifts back and away from the leg that lifts at the end (the front right one).
  const brace = span(t, 6.2, 6.6) * (1 - span(t, 7.5, 7.9));
  const beat = (2 * Math.PI * t) / 1.2;
  return {
    position: [
      0.07 * brace + 0.025 * walk * Math.sin(beat),
      HUB_Y + 0.022 * walk * Math.sin(beat * 2) - 0.03 * brace,
      START_Z + (END_Z - START_Z) * progress(t) - 0.06 * brace,
    ],
    rotation: [1.6 * walk * Math.sin(beat * 2 + 0.6) - 2.5 * brace, 0, 2.2 * walk * Math.sin(beat) + 2 * brace],
  };
}

/** Each leg's steps: when the foot leaves the ground, when it lands, and where. */
function footSteps() {
  const cycle = 1.2;
  const swing = 0.3;
  const stance = cycle - swing;
  const steps = LEGS.map(() => []);
  const homeAt = (leg, t) => {
    const at = body(t).position;
    return [leg.sx * HOME + at[0], 0, leg.sz * HOME + at[2]];
  };
  // The walk: one leg at a time, in a diagonal order, each landing where it will be mid-stride.
  for (let k = 0; k < 4; k++) {
    LEGS.forEach((leg, i) => {
      const t0 = 0.3 + (k + i / 4) * cycle;
      const mid = homeAt(leg, Math.min(t0 + swing + stance / 2, WALK[1] + 0.2));
      steps[i].push({ t0, t1: t0 + swing, to: [leg.sx * HOME, 0, mid[2]], lift: 0.24 });
    });
  }
  // Squaring up after the stop.
  LEGS.forEach((leg, i) => {
    const t0 = 5.25 + i * 0.24;
    steps[i].push({ t0, t1: t0 + 0.22, to: [leg.sx * HOME, 0, leg.sz * HOME + END_Z], lift: 0.14 });
  });
  // The front right leg (the one away from the camera) rears up, holds, and stamps down.
  const rearing = LEGS.findIndex((leg) => leg.key === "fr");
  steps[rearing].push({ t0: 6.5, t1: 6.95, to: [-1.5, 0.62, 1.55 + END_Z], lift: 0.12 });
  steps[rearing].push({ t0: 7.25, t1: 7.5, to: [-HOME, 0, HOME + END_Z], lift: 0 });
  return steps;
}

/** Where a foot is at time `t`, in the world. */
function footAt(leg, steps, t) {
  let at = [leg.sx * HOME, 0, leg.sz * HOME + START_Z];
  for (const step of steps) {
    if (t >= step.t1) {
      at = step.to;
      continue;
    }
    if (t > step.t0) {
      const u = (t - step.t0) / (step.t1 - step.t0);
      const e = smooth(u);
      return [
        at[0] + (step.to[0] - at[0]) * e,
        at[1] + (step.to[1] - at[1]) * e + step.lift * Math.sin(Math.PI * u),
        at[2] + (step.to[2] - at[2]) * e,
      ];
    }
    break;
  }
  return at;
}

function buildAnimation() {
  const steps = footSteps();
  const times = Array.from({ length: DURATION * RATE + 1 }, (_, i) => i / RATE);
  const key = (t, value) => ({ t: r4(t), value: value.map((n) => Math.round(n * 100) / 100), ease: "linear" });
  let worst = 0;

  calls.push({ tool: "set_clip", input: { duration: DURATION, fps: 24, loop: false } });
  calls.push({
    tool: "animate",
    input: {
      id: "spider",
      position: times.map((t) => ({ ...key(t, body(t).position), value: v(body(t).position) })),
      rotation: times.map((t) => key(t, body(t).rotation)),
    },
  });

  LEGS.forEach((leg, i) => {
    const tracks = { hip: [], upper: [], lower: [] };
    for (const t of times) {
      const { position, rotation: turn } = body(t);
      const world = footAt(leg, steps[i], t);
      // Into the hub's frame, where the hips are fixed.
      const local = apply(transpose(rotation(turn)), world.map((n, a) => n - position[a]));
      const angles = solveLeg(leg, local);
      const reached = footOf(leg, angles);
      worst = Math.max(worst, Math.hypot(...reached.map((n, a) => n - local[a])));
      tracks.hip.push(key(t, [0, angles.yaw, 0]));
      tracks.upper.push(key(t, [0, 0, angles.upper]));
      tracks.lower.push(key(t, [0, 0, angles.lower]));
    }
    for (const joint of ["hip", "upper", "lower"]) {
      calls.push({ tool: "animate", input: { id: `spider_leg_${leg.key}_${joint}`, rotation: tracks[joint] } });
    }
  });

  // The turret looks around once the mech has stopped; it nods a little as it walks.
  const yaw = (t) =>
    4 * striding(t) * Math.sin((2 * Math.PI * t) / 2.4) +
    -30 * span(t, 6.3, 6.85) + 62 * span(t, 6.95, 7.5) - 32 * span(t, 7.55, 7.95);
  const nod = (t) =>
    11 + 1.5 * striding(t) * Math.sin((2 * Math.PI * t) / 0.6) - 10 * span(t, 6.4, 6.9) + 10 * span(t, 7.4, 7.9);
  calls.push({ tool: "animate", input: { id: "spider_neck", rotation: times.map((t) => key(t, [0, yaw(t), 0])) } });
  calls.push({ tool: "animate", input: { id: "spider_head", rotation: times.map((t) => key(t, [nod(t), 0, 0])) } });
  for (const side of ["left", "right"]) {
    calls.push({
      tool: "animate",
      input: {
        id: `spider_fan_${side}`,
        rotation: [
          { t: 0, value: [0, 0, 0], ease: "linear" },
          { t: DURATION, value: [side === "left" ? 2160 : -2160, 0, 0], ease: "linear" },
        ],
      },
    });
  }
  return worst;
}

function buildStage() {
  calls.push({
    tool: "set_environment",
    input: {
      background: "#a7a7a7",
      ambient: 0.62,
      // High and from the front, like a studio softbox.
      sun: { azimuth: 22, elevation: 62, intensity: 2.9, color: "#fff6ec" },
      ground: { visible: true, color: "#9a9a9a" },
      fog: { color: "#a7a7a7", near: 16, far: 60 },
      grade: { bloom: 0.6, vignette: 0.3, saturation: 1.05, contrast: 0.1 },
    },
  });
  calls.push({ tool: "set_camera", input: { position: [3.5, 1.7, 5.5], target: [0, 1.0, 0.15], fov: 40 } });
}

buildStage();
buildModel(START_Z);
const worst = buildAnimation();

const objects = calls.filter((c) => c.tool === "add_object");
const pieces = objects.reduce(
  (sum, c) => sum + c.input.parts.reduce((n, p) => n + (p.array?.count ?? 1), 0),
  0,
);
console.log(
  `${calls.length} calls: ${objects.length} groups, ${objects.reduce((n, c) => n + c.input.parts.length, 0)} parts ` +
    `(${pieces} pieces with arrays), ${calls.filter((c) => c.tool === "animate").length} animated joints. ` +
    `Worst IK error ${worst.toExponential(2)} m.`,
);

const target = process.argv[2];
if (target) {
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "reply-1.json"),
    JSON.stringify({
      calls,
      text:
        "Built the quadruped mech as a rig: hub, neck, head, two fans and four three-jointed legs. " +
        "It walks in on leg IK, squares up, then scans with the turret and rears a front leg.",
      done: true,
    }),
  );
  console.log(`Wrote reply-1.json to ${target}`);
}
