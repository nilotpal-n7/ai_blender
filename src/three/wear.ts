import * as THREE from "three";
import {
  EDGES,
  RUST_BRIGHT,
  RUST_DARK,
  RUST_SCALE,
  WEAR_EDGE_REACH,
  WEAR_EDGE_SCALE,
  WEAR_FIT,
  WEAR_GRIME_SCALE,
  WEAR_METAL,
  WEAR_METAL_ROUGHNESS,
  WEAR_SCALE,
} from "@/scene/finish";

/**
 * A surface that has seen use. Paint chips away in patches, first along the
 * edges, down to mottled bare metal; scratches cut through it; rust blooms
 * around the damage; and all of it has a little relief, so the paint reads as
 * a layer with thickness.
 *
 * Everything is worked out from each point's place on the object, measured in
 * meters, so it needs no UVs and stays put when the object moves.
 */

const DECLARE_VERTEX = /* glsl */ `
  varying vec3 vWearPosition;
`;
const SET_VERTEX = /* glsl */ `
  // Object space, stretched to real size so the pattern is the same scale on every part.
  vWearPosition = position * vec3(
    length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz)
  );
`;

const DECLARE_FRAGMENT = /* glsl */ `
  uniform float uWear;
  uniform float uRust;
  uniform float uWearSeed;
  uniform float uWearEdges;
  uniform mat4 modelMatrix;
  varying vec3 vWearPosition;

  float wearHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float wearNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(wearHash(i), wearHash(i + vec3(1, 0, 0)), f.x),
          mix(wearHash(i + vec3(0, 1, 0)), wearHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(wearHash(i + vec3(0, 0, 1)), wearHash(i + vec3(1, 0, 1)), f.x),
          mix(wearHash(i + vec3(0, 1, 1)), wearHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float wearFbm(vec3 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 4; octave++) {
      total += amplitude * wearNoise(p);
      p = p * 2.03 + 11.7;
      amplitude *= 0.5;
    }
    return total / 0.9375;
  }
  /** How much finer the pattern is on this part than on one 40 cm across; see wearFit. */
  float wearFit() {
    vec3 size = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
    float middle = size.x + size.y + size.z - min(size.x, min(size.y, size.z)) - max(size.x, max(size.y, size.z));
    return clamp(WEAR_FIT_SIZE / max(middle, 1e-4), WEAR_FIT_MIN, WEAR_FIT_MAX);
  }
  /** Meters from the nearest edge of the shape, for a point on its surface. */
  float wearEdgeDistance(vec3 p) {
    if (uWearEdges < -0.5) return 1000.0;
    vec3 size = 0.5 * vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
    vec3 d = size - abs(p);
    if (uWearEdges > 0.5) d = vec3(size.x - length(p.xz * vec2(1.0, size.x / max(size.z, 1e-4))), d.y, 1000.0);
    // On the surface the smallest of the three is zero; the next one is the way to the edge.
    return d.x + d.y + d.z - min(d.x, min(d.y, d.z)) - max(d.x, max(d.y, d.z));
  }
  /** Fine scratches: noise pulled out long and thin along one direction. */
  float wearScratches(vec3 p) {
    vec3 a = vec3(dot(p, vec3(0.8, 0.5, 0.33)), dot(p, vec3(-0.5, 0.8, 0.1)), dot(p, vec3(-0.2, -0.3, 0.93)));
    vec3 b = vec3(dot(p, vec3(0.3, -0.6, 0.74)), dot(p, vec3(0.9, 0.4, -0.1)), dot(p, vec3(-0.3, 0.7, 0.66)));
    float first = wearNoise(a * vec3(2.5, 150.0, 150.0));
    float second = wearNoise(b * vec3(3.5, 190.0, 190.0) + 31.0);
    return max(smoothstep(0.89, 0.95, first), smoothstep(0.91, 0.96, second));
  }
  vec3 wearBump(vec3 at, vec3 normal, float height, float facing) {
    vec3 dx = dFdx(at);
    vec3 dy = dFdy(at);
    vec3 r1 = cross(dy, normal);
    vec3 r2 = cross(normal, dx);
    float det = dot(dx, r1) * facing;
    vec3 gradient = sign(det) * (dFdx(height) * r1 + dFdy(height) * r2);
    return normalize(abs(det) * normal - gradient);
  }
`;

const SHADE_FRAGMENT = /* glsl */ `
  float wearChip = 0.0;
  float wearRust = 0.0;
  float wearHeight = 0.0;
  float wearRough = 0.0;
  {
    vec3 seed = vec3(uWearSeed, uWearSeed * 1.7, uWearSeed * 0.3);
    // The broad pattern is sized to the part; the grain and scratches are the size they are.
    float fit = wearFit();
    vec3 p = vWearPosition * fit + seed;
    vec3 q = vWearPosition + seed;
    float fine = wearFbm(p * WEAR_EDGE_SCALE + 5.2);
    float grain = wearFbm(q * 95.0);
    float nearEdge = 1.0 - smoothstep(0.0, WEAR_EDGE_REACH, wearEdgeDistance(vWearPosition) * fit);

    // Paint goes in broad patches with ragged outlines, and first along the edges.
    float field = wearFbm(p * WEAR_SCALE) * 0.72 + fine * 0.28 + nearEdge * (0.1 + 0.16 * fine) * step(0.001, uWear);
    float level = mix(0.78, 0.43, uWear);
    wearChip = smoothstep(level, level + 0.012, field) * step(0.001, uWear);
    float rim = smoothstep(level - 0.035, level, field) * (1.0 - wearChip) * step(0.001, uWear);
    float scratch = wearScratches(q) * smoothstep(0.05, 0.4, uWear) * (1.0 - wearChip);

    // The paint: faded and grimy unevenly, darker where it is about to lift.
    float grime = wearFbm(p * WEAR_GRIME_SCALE + 3.7);
    vec3 paint = diffuseColor.rgb * mix(1.0, 0.6 + 0.66 * grime, min(1.0, uWear * 1.8));
    paint *= 1.0 - 0.5 * rim;
    paint *= 0.94 + 0.12 * grain;

    // The metal under it: mottled, with darker stains.
    vec3 metal = vec3(WEAR_METAL) * (0.62 + 0.8 * wearFbm(p * 9.0 + 2.3)) * (0.9 + 0.2 * grain);
    vec3 color = mix(paint, metal, max(wearChip, scratch * 0.45));

    // Rust blooms out of chips and edges and spreads from there.
    if (uRust > 0.0) {
      float bloom = wearFbm(p * RUST_SCALE + 17.0) * 0.6 + fine * 0.22 + wearChip * 0.14 + rim * 0.1 + nearEdge * 0.08;
      float rustLevel = mix(0.86, 0.36, uRust);
      wearRust = smoothstep(rustLevel, rustLevel + 0.09, bloom);
      float halo = smoothstep(rustLevel - 0.12, rustLevel, bloom) * (1.0 - wearRust);
      vec3 rust = mix(vec3(RUST_DARK), vec3(RUST_BRIGHT), smoothstep(0.3, 0.75, wearFbm(p * 31.0 + 8.0)));
      color = mix(color, color * vec3(0.78, 0.6, 0.48), halo * 0.7);
      color = mix(color, rust * (0.8 + 0.4 * grain), wearRust);
    }
    diffuseColor.rgb = color;

    // Relief: paint stands proud of the metal, rust is crusty, scratches are cut in.
    wearHeight = (1.0 - wearChip) * 0.6 * step(0.001, uWear) - scratch * 0.35 + wearRust * (0.3 + 0.9 * fine) + grain * 0.08;
    wearRough = grain;
  }
`;

const SHADE_ROUGHNESS = /* glsl */ `
  roughnessFactor = mix(roughnessFactor * (0.85 + 0.3 * wearRough), ${WEAR_METAL_ROUGHNESS} + 0.25 * wearRough, wearChip);
  roughnessFactor = clamp(mix(roughnessFactor, 0.95, wearRust), 0.04, 1.0);
`;
const SHADE_METALNESS = /* glsl */ `
  metalnessFactor = mix(mix(metalnessFactor, 1.0, wearChip), 0.0, wearRust);
`;
const SHADE_NORMAL = /* glsl */ `
  normal = wearBump(-vViewPosition, normal, wearHeight * 0.0012, faceDirection);
`;

const vec = (v: readonly number[]) => v.join(", ");
const fill = (glsl: string) =>
  glsl
    .replaceAll("WEAR_EDGE_SCALE", WEAR_EDGE_SCALE.toFixed(2))
    .replaceAll("WEAR_EDGE_REACH", WEAR_EDGE_REACH.toFixed(4))
    .replaceAll("WEAR_FIT_SIZE", WEAR_FIT.size.toFixed(3))
    .replaceAll("WEAR_FIT_MIN", WEAR_FIT.min.toFixed(3))
    .replaceAll("WEAR_FIT_MAX", WEAR_FIT.max.toFixed(3))
    .replaceAll("WEAR_GRIME_SCALE", WEAR_GRIME_SCALE.toFixed(2))
    .replaceAll("WEAR_SCALE", WEAR_SCALE.toFixed(2))
    .replaceAll("WEAR_METAL", vec(WEAR_METAL))
    .replaceAll("RUST_SCALE", RUST_SCALE.toFixed(2))
    .replaceAll("RUST_DARK", vec(RUST_DARK))
    .replaceAll("RUST_BRIGHT", vec(RUST_BRIGHT));

/** A stable number for an id, so every part chips in its own places. */
export function wearSeed(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 9973;
  return hash / 97;
}

/**
 * A standard material that wears and rusts. Set `wear` and `rust` (0..1), a
 * `seed`, and `edges` (from `edgesOf`) so paint wears off the shape's edges.
 */
export class WornMaterial extends THREE.MeshStandardMaterial {
  private readonly wearUniforms = {
    uWear: { value: 0 },
    uRust: { value: 0 },
    uWearSeed: { value: 0 },
    uWearEdges: { value: EDGES.none as number },
  };

  get wear() {
    return this.wearUniforms.uWear.value;
  }
  set wear(value: number) {
    this.wearUniforms.uWear.value = value;
  }
  get rust() {
    return this.wearUniforms.uRust.value;
  }
  set rust(value: number) {
    this.wearUniforms.uRust.value = value;
  }
  get seed() {
    return this.wearUniforms.uWearSeed.value;
  }
  set seed(value: number) {
    this.wearUniforms.uWearSeed.value = value;
  }
  get edges() {
    return this.wearUniforms.uWearEdges.value;
  }
  set edges(value: number) {
    this.wearUniforms.uWearEdges.value = value;
  }

  onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, this.wearUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + DECLARE_VERTEX)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + SET_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + fill(DECLARE_FRAGMENT))
      .replace("#include <color_fragment>", "#include <color_fragment>\n" + fill(SHADE_FRAGMENT))
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + SHADE_ROUGHNESS)
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n" + SHADE_METALNESS)
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + SHADE_NORMAL);
  }

  customProgramCacheKey() {
    return "worn-4";
  }
}
