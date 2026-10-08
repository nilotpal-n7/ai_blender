import * as THREE from "three";
import {
  WEAR_EDGE_SCALE,
  WEAR_GRIME_SCALE,
  WEAR_METAL,
  WEAR_METAL_ROUGHNESS,
  WEAR_SCALE,
} from "@/scene/finish";

/**
 * A painted surface that has seen use: the color is chipped away in patches to
 * bare metal, with a dark edge where the paint lifts, and fades unevenly.
 *
 * The pattern is worked out from each point's place on the object, measured in
 * meters, so it needs no UVs and stays put when the object moves.
 */

const DECLARE_VERTEX = /* glsl */ `
  varying vec3 vWearPosition;
`;
const SET_VERTEX = /* glsl */ `
  // Object space, stretched to real size so the chips are the same scale on every part.
  vWearPosition = position * vec3(
    length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz)
  );
`;

const DECLARE_FRAGMENT = /* glsl */ `
  uniform float uWear;
  uniform float uWearSeed;
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
`;
const SHADE_FRAGMENT = /* glsl */ `
  float wearChip = 0.0;
  {
    vec3 p = vWearPosition + vec3(uWearSeed, uWearSeed * 1.7, uWearSeed * 0.3);
    // Broad patches with ragged edges.
    float field = wearFbm(p * WEAR_SCALE) * 0.75 + wearFbm(p * WEAR_EDGE_SCALE + 5.2) * 0.25;
    float level = mix(0.74, 0.44, uWear);
    wearChip = smoothstep(level, level + 0.02, field);
    float rim = smoothstep(level - 0.045, level, field) * (1.0 - wearChip);
    // Sun-fade and grime, uneven across the surface.
    float grime = wearFbm(p * WEAR_GRIME_SCALE + 3.7);
    diffuseColor.rgb *= mix(1.0, 0.62 + 0.62 * grime, min(1.0, uWear * 1.8));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45, rim * 0.85);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(WEAR_METAL), wearChip);
  }
`;

const fill = (glsl: string) =>
  glsl
    .replace("WEAR_SCALE", WEAR_SCALE.toFixed(2))
    .replace("WEAR_EDGE_SCALE", WEAR_EDGE_SCALE.toFixed(2))
    .replace("WEAR_GRIME_SCALE", WEAR_GRIME_SCALE.toFixed(2))
    .replace("WEAR_METAL", WEAR_METAL.join(", "));

/** A stable number for an id, so every part chips in its own places. */
export function wearSeed(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 9973;
  return hash / 97;
}

/** A standard material whose color wears through to metal. Set `wear` (0..1) and `seed`. */
export class WornMaterial extends THREE.MeshStandardMaterial {
  private readonly wearUniforms = { uWear: { value: 0 }, uWearSeed: { value: 0 } };

  get wear() {
    return this.wearUniforms.uWear.value;
  }
  set wear(value: number) {
    this.wearUniforms.uWear.value = value;
  }
  get seed() {
    return this.wearUniforms.uWearSeed.value;
  }
  set seed(value: number) {
    this.wearUniforms.uWearSeed.value = value;
  }

  onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, this.wearUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + DECLARE_VERTEX)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + SET_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + DECLARE_FRAGMENT)
      .replace("#include <color_fragment>", "#include <color_fragment>\n" + fill(SHADE_FRAGMENT))
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, ${WEAR_METAL_ROUGHNESS}, wearChip);`,
      )
      .replace(
        "#include <metalnessmap_fragment>",
        "#include <metalnessmap_fragment>\n metalnessFactor = mix(metalnessFactor, 1.0, wearChip);",
      );
  }

  customProgramCacheKey() {
    return "worn";
  }
}
