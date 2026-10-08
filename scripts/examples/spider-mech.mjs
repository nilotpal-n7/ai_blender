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
const ORANGE = { color: "#ee4a1b", roughness: 0.48, metalness: 0.05, wear: 0.42 };
const GREY = { color: "#6f7478", roughness: 0.55, metalness: 0.55, wear: 0.3 };
const PLATE = { color: "#8a8f93", roughness: 0.6, metalness: 0.45, wear: 0.34 };
const DARK = { color: "#222426", roughness: 0.7, metalness: 0.4 };
const STEEL = { color: "#c3c7cb", roughness: 0.22, metalness: 1 };
const BLUE = { color: "#0b2a3d", emissive: "#2fb4ff", emissiveIntensity: 7, roughness: 0.3 };
const RED = { color: "#3a0805", emissive: "#ff2a12", emissiveIntensity: 5, roughness: 0.3 };

// ─── Part helpers ───────────────────────────────────────────────────
const part = (primitive) => (name, position, scale, material, extra = {}) => ({
  name,
  primitive,
  position: v(position),
  scale: v(scale),
  material,
  ...(extra.rotation && { rotation: v(extra.rotation) }),
  ...(extra.bevel && { bevel: extra.bevel }),
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
    rotation: axis === "x" ? [0, 0, 90] : [90, 0, 0],
  });
const rodX = rod("x");
const rodZ = rod("z");
const pair = (step) => ({ count: 2, step });

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
    cyl("core", [0, 0, 0], [0.62, 0.26, 0.62], GREY),
    cyl("top plate", [0, 0.155, 0], [0.72, 0.06, 0.72], ORANGE),
    cyl("belly", [0, -0.17, 0], [0.5, 0.1, 0.5], DARK),
    cyl("belly cap", [0, -0.235, 0], [0.3, 0.05, 0.3], GREY),
    box("shoulder block", [0.255, 0, 0.255], [0.34, 0.2, 0.28], ORANGE, {
      rotation: [0, -45, 0],
      bevel: 0.025,
      array: { count: 4, turn: [0, 90, 0] },
    }),
    box("side armor", [0.33, 0.0, 0], [0.08, 0.16, 0.3], GREY, {
      bevel: 0.015,
      array: { count: 4, turn: [0, 90, 0] },
    }),
    cyl("bolt", [0.3, 0.19, 0], [0.035, 0.02, 0.035], STEEL, { array: { count: 12, turn: [0, 30, 0] } }),
    cyl("neck seat", [0, 0.2, 0], [0.44, 0.05, 0.44], GREY),
  ]);

  // Neck: turns the turret left and right.
  add("spider_neck", "Neck", "spider", [0, 0.22, 0], [0, 0, 0], [
    cyl("neck core", [0, 0.15, 0], [0.24, 0.3, 0.24], DARK),
    cyl("neck rib", [0, 0.035, 0], [0.34, 0.032, 0.34], GREY, { array: { count: 6, step: [0, 0.048, 0] } }),
  ]);

  // Head: nods up and down on top of the neck.
  add("spider_head", "Head", "spider_neck", [0, 0.32, 0], [6, 0, 0], [
    cyl("turntable", [0, 0.04, 0], [0.5, 0.08, 0.5], GREY),
    box("skull", [0, 0.36, 0.05], [0.84, 0.56, 1.06], GREY, { bevel: 0.045 }),
    // Roof: two orange slabs with a channel down the middle.
    box("roof plate left", [0.25, 0.672, 0.08], [0.36, 0.07, 1.14], ORANGE, { bevel: 0.022, rotation: [0, 0, -4] }),
    box("roof plate right", [-0.25, 0.672, 0.08], [0.36, 0.07, 1.14], ORANGE, { bevel: 0.022, rotation: [0, 0, 4] }),
    box("roof channel", [0, 0.648, 0.02], [0.2, 0.03, 0.9], DARK),
    box("roof grille slat", [0, 0.668, 0.1], [0.13, 0.022, 0.018], PLATE, {
      array: { count: 8, step: [0, 0, 0.034] },
    }),
    box("roof spine", [0, 0.668, -0.25], [0.07, 0.03, 0.4], ORANGE, { bevel: 0.01 }),
    box("visor", [0, 0.618, 0.67], [0.92, 0.06, 0.22], ORANGE, { bevel: 0.02, rotation: [20, 0, 0] }),
    wedge("visor cheek left", [0.435, 0.5, 0.56], [0.05, 0.2, 0.18], ORANGE, { rotation: [0, 180, 0] }),
    wedge("visor cheek right", [-0.435, 0.5, 0.56], [0.05, 0.2, 0.18], ORANGE, { rotation: [0, 180, 0] }),
    // Face: a dark recess with a grille and four barrels.
    box("face recess", [0, 0.41, 0.585], [0.76, 0.3, 0.05], DARK),
    box("face grille slat", [-0.09, 0.42, 0.61], [0.018, 0.2, 0.05], PLATE, {
      array: { count: 7, step: [0.03, 0, 0] },
    }),
    box("grille frame", [0, 0.42, 0.6], [0.26, 0.25, 0.04], GREY, { bevel: 0.01 }),
    rodZ("barrel collar upper", [-0.27, 0.47, 0.63], [0.085, 0.1], GREY, { array: pair([0.54, 0, 0]) }),
    rodZ("barrel upper", [-0.27, 0.47, 0.84], [0.046, 0.46], DARK, { array: pair([0.54, 0, 0]) }),
    rodZ("barrel tip upper", [-0.27, 0.47, 1.085], [0.062, 0.07], ORANGE, { array: pair([0.54, 0, 0]) }),
    rodZ("barrel collar lower", [-0.33, 0.37, 0.63], [0.085, 0.1], GREY, { array: pair([0.66, 0, 0]) }),
    rodZ("barrel lower", [-0.33, 0.37, 0.8], [0.046, 0.4], DARK, { array: pair([0.66, 0, 0]) }),
    rodZ("barrel tip lower", [-0.33, 0.37, 1.015], [0.062, 0.07], ORANGE, { array: pair([0.66, 0, 0]) }),
    // Chin: an orange jaw with two blue lamps.
    box("chin", [0, 0.15, 0.47], [0.62, 0.2, 0.34], ORANGE, { bevel: 0.03, rotation: [-8, 0, 0] }),
    box("chin lamp", [-0.15, 0.165, 0.648], [0.15, 0.028, 0.02], BLUE, {
      rotation: [-8, 0, 0],
      array: pair([0.3, 0, 0]),
    }),
    box("jaw", [0, 0.07, 0.2], [0.5, 0.1, 0.5], DARK, { bevel: 0.02 }),
    // Sides.
    box("cheek armor", [-0.44, 0.27, 0.2], [0.05, 0.34, 0.62], ORANGE, { bevel: 0.015, array: pair([0.88, 0, 0]) }),
    box("cheek slit left", [0.47, 0.52, 0.22], [0.02, 0.018, 0.2], ORANGE, { array: { count: 2, step: [0, -0.05, 0] } }),
    box("cheek slit right", [-0.47, 0.52, 0.22], [0.02, 0.018, 0.2], ORANGE, { array: { count: 2, step: [0, -0.05, 0] } }),
    // Back: two round sensors and a pair of handles.
    rodZ("sensor housing", [-0.2, 0.4, -0.5], [0.3, 0.12], GREY, { array: pair([0.4, 0, 0]) }),
    rodZ("sensor rim", [-0.2, 0.4, -0.565], [0.24, 0.03], DARK, { array: pair([0.4, 0, 0]) }),
    rodZ("sensor eye", [-0.2, 0.4, -0.572], [0.15, 0.03], RED, { array: pair([0.4, 0, 0]) }),
    box("back plate", [0, 0.4, -0.49], [0.8, 0.5, 0.04], DARK, { bevel: 0.015 }),
    box("handle", [-0.24, 0.71, -0.42], [0.16, 0.05, 0.1], ORANGE, {
      bevel: 0.012,
      rotation: [-24, 0, 0],
      array: pair([0.48, 0, 0]),
    }),
    box("handle post", [-0.24, 0.675, -0.46], [0.12, 0.05, 0.03], ORANGE, { array: pair([0.48, 0, 0]) }),
  ]);

  // Turbines: a vent on each side of the head, with a fan that spins.
  for (const [side, x] of [["left", 0.455], ["right", -0.455]]) {
    const out = Math.sign(x);
    add(`spider_vent_${side}`, `Vent ${side}`, "spider_head", [x, 0.4, -0.2], [0, 0, 0], [
      rodX("housing", [out * 0.02, 0, 0], [0.42, 0.14], GREY),
      torus("rim", [out * 0.1, 0, 0], [0.47, 0.34, 0.47], ORANGE, { rotation: [0, 0, 90] }),
      rodX("well", [out * 0.075, 0, 0], [0.33, 0.06], DARK),
    ]);
    add(`spider_fan_${side}`, `Fan ${side}`, `spider_vent_${side}`, [out * 0.1, 0, 0], [0, 0, 0], [
      rodX("hub", [0, 0, 0], [0.1, 0.05], STEEL),
      box("blade", [0, 0.1, 0], [0.03, 0.11, 0.022], PLATE, {
        rotation: [0, 24, 0],
        array: { count: 14, turn: [360 / 14, 0, 0] },
      }),
    ]);
  }

  for (const leg of LEGS) {
    const home = solveLeg(leg, [leg.sx * HOME, -HUB_Y, leg.sz * HOME]);
    const id = `spider_leg_${leg.key}`;
    // Hip: swings the whole leg forward and back about a vertical pin.
    add(`${id}_hip`, `Hip ${leg.label}`, "spider", [leg.sx * HIP, 0, leg.sz * HIP], [0, home.yaw, 0], [
      cyl("pin", [0, 0, 0], [0.13, 0.32, 0.13], STEEL),
      box("clevis", [0.09, -0.115, 0], [0.32, 0.05, 0.22], ORANGE, { bevel: 0.014, array: pair([0, 0.23, 0]) }),
      box("shoulder block", [SHOULDER, 0, 0], [0.14, 0.17, 0.12], GREY, { bevel: 0.015 }),
      rodZ("shoulder axle", [SHOULDER, 0, 0], [0.09, 0.3], STEEL),
    ]);
    // Upper leg: raises and lowers the knee.
    add(`${id}_upper`, `Upper leg ${leg.label}`, `${id}_hip`, [SHOULDER, 0, 0], [0, 0, home.upper], [
      box("beam", [0.38, 0, 0], [0.66, 0.13, 0.13], ORANGE, { bevel: 0.022 }),
      box("side plate", [0.4, -0.01, -0.085], [0.5, 0.17, 0.028], GREY, { bevel: 0.01, array: pair([0, 0, 0.17]) }),
      rodX("ram", [0.27, 0.125, 0], [0.085, 0.32], GREY),
      rodX("ram collar", [0.44, 0.125, 0], [0.1, 0.03], DARK),
      rodX("piston", [0.6, 0.125, 0], [0.042, 0.36], STEEL),
      box("piston eye", [0.79, 0.125, 0], [0.07, 0.07, 0.07], GREY, { bevel: 0.012 }),
      box("elbow plate", [0.79, 0.01, -0.1], [0.3, 0.32, 0.034], ORANGE, {
        bevel: 0.012,
        rotation: [0, 0, -18],
        array: pair([0, 0, 0.2]),
      }),
      rodZ("knee axle", [L1, 0, 0], [0.075, 0.3], STEEL),
    ]);
    // Lower leg: the armoured shin, hinged at the knee.
    add(`${id}_lower`, `Lower leg ${leg.label}`, `${id}_upper`, [L1, 0, 0], [0, 0, home.lower], [
      rodZ("knee wheel", [0, 0, 0], [0.27, 0.12], GREY),
      rodZ("knee cap", [0, 0, 0], [0.13, 0.15], DARK),
      box("knee bracket", [0.08, -0.06, 0], [0.2, 0.2, 0.15], GREY, { bevel: 0.02 }),
      box("spine", [0.11, -0.47, 0], [0.13, 1.14, 0.25], DARK, { bevel: 0.02 }),
      box("thigh armor", [0.17, 0.08, 0], [0.25, 0.46, 0.37], ORANGE, { bevel: 0.035 }),
      box("vent slit", [0.297, 0.16, 0.03], [0.012, 0.018, 0.17], DARK, { array: { count: 4, step: [0, -0.042, 0] } }),
      box("handle post", [0.17, 0.33, -0.085], [0.035, 0.07, 0.03], ORANGE, { array: pair([0, 0, 0.17]) }),
      box("handle bar", [0.17, 0.372, 0], [0.04, 0.03, 0.21], ORANGE, { bevel: 0.01 }),
      box("shin plate", [0.165, -0.39, 0], [0.2, 0.42, 0.35], GREY, { bevel: 0.022 }),
      box("shin panel", [0.27, -0.39, 0], [0.012, 0.3, 0.25], PLATE, { bevel: 0.005 }),
      box("shin guard", [0.17, -0.77, 0], [0.23, 0.3, 0.37], ORANGE, { bevel: 0.028 }),
      box("side fin", [0.08, -0.62, -0.19], [0.17, 0.52, 0.03], ORANGE, { bevel: 0.012, array: pair([0, 0, 0.38]) }),
      box("toe", [0.19, -1.0, 0], [0.2, 0.16, 0.25], ORANGE, { bevel: 0.022 }),
      box("sole", [0.14, -1.08, 0], [0.24, 0.04, 0.3], DARK, { bevel: 0.01 }),
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
    6 + 1.5 * striding(t) * Math.sin((2 * Math.PI * t) / 0.6) - 9 * span(t, 6.4, 6.9) + 9 * span(t, 7.4, 7.9);
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
      background: "#a9a9a9",
      ambient: 0.85,
      sun: { azimuth: 28, elevation: 52, intensity: 2.6, color: "#fff8f0" },
      ground: { visible: true, color: "#9c9c9c" },
      fog: { color: "#a9a9a9", near: 16, far: 46 },
      grade: { bloom: 0.9, vignette: 0.32, saturation: 1.08, contrast: 0.14 },
    },
  });
  calls.push({ tool: "set_camera", input: { position: [3.7, 1.75, 5.4], target: [0, 1.0, 0.1], fov: 42 } });
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
