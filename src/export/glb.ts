/** Binary glTF (.glb) export, built from the scene with plain three.js. Browser only. */

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { frameCount, sampleTrack } from "@/scene/animate";
import { arrayCopies } from "@/scene/array";
import { DEG, sunDirection } from "@/scene/math";
import { childIds } from "@/scene/ops";
import type { MeshNode, Scene, SceneNode } from "@/scene/types";
import { EXPORT_DETAIL, fusedFinish, fusedMesh, isFused } from "@/shapes/blend";
import { hasVertexColors, meshDataGeometry, nodeGeometry } from "@/three/geometry";

/** glTF lights shine down their local −Z; the exporter reads that from a target at (0, 0, −1). */
function aimDownNegativeZ<T extends THREE.SpotLight | THREE.DirectionalLight>(light: T): T {
  light.add(light.target);
  light.target.position.set(0, 0, -1);
  return light;
}

function place(object: THREE.Object3D, node: SceneNode) {
  object.position.fromArray(node.position);
  object.rotation.set(node.rotation[0] * DEG, node.rotation[1] * DEG, node.rotation[2] * DEG);
  object.scale.fromArray(node.scale);
}

function meshOf(node: MeshNode): THREE.Mesh {
  const { material } = node;
  const mesh = new THREE.Mesh(
    nodeGeometry(node),
    // glTF has no procedural shading, so a worn finish is exported as its plain color.
    new THREE.MeshStandardMaterial({
      color: material.color,
      vertexColors: hasVertexColors(node.primitive),
      roughness: material.roughness,
      metalness: material.metalness,
      emissive: material.emissive,
      emissiveIntensity: material.emissiveIntensity,
      transparent: material.opacity < 1,
      opacity: material.opacity,
      side: node.primitive === "plane" ? THREE.DoubleSide : THREE.FrontSide,
    }),
  );
  mesh.name = `${node.name} mesh`;
  return mesh;
}

/** The objects for a node: itself, and beside it the copies of an arrayed mesh. */
function buildNode(scene: Scene, node: SceneNode, objects: Map<string, THREE.Object3D>): THREE.Object3D[] {
  const object = new THREE.Group();
  object.name = node.name;
  place(object, node);
  object.visible = node.visible;
  objects.set(node.id, object);
  const built: THREE.Object3D[] = [object];

  if (node.kind === "mesh" && !isFused(scene, node)) {
    object.add(meshOf(node));
    arrayCopies(node.array).slice(1).forEach((copy, i) => {
      const holder = new THREE.Group();
      holder.name = `${node.name} copy ${i + 2}`;
      holder.position.fromArray(copy.position);
      holder.rotation.set(copy.rotation[0] * DEG, copy.rotation[1] * DEG, copy.rotation[2] * DEG);
      holder.visible = node.visible;
      const inner = new THREE.Group();
      place(inner, node);
      inner.add(meshOf(node));
      holder.add(inner);
      built.push(holder);
    });
  }
  if (node.kind === "group" && node.blend > 0) {
    // The group's solid parts, fused into one surface.
    const surface = fusedMesh(scene, node, EXPORT_DETAIL);
    if (surface.points.length > 0) {
      const mesh = new THREE.Mesh(
        meshDataGeometry(surface),
        new THREE.MeshStandardMaterial({ vertexColors: true, ...fusedFinish(scene, node) }),
      );
      mesh.name = `${node.name} mesh`;
      object.add(mesh);
    }
  }
  if (node.kind === "light") {
    const { light } = node;
    if (light.type === "spot") {
      const spot = aimDownNegativeZ(
        new THREE.SpotLight(light.color, light.intensity, light.distance, light.angle * DEG, 0.35),
      );
      // Scene spot lights shine down −Y.
      spot.rotation.x = -Math.PI / 2;
      object.add(spot);
    } else {
      object.add(new THREE.PointLight(light.color, light.intensity, light.distance));
    }
  }
  for (const childId of childIds(scene, node.id)) {
    // A fused part is only kept, as an empty node, if something hangs off it.
    const child = scene.nodes[childId];
    if (isFused(scene, child) && childIds(scene, childId).length === 0) continue;
    object.add(...buildNode(scene, child, objects));
  }
  return built;
}

/** The clip as a three.js animation, sampled on every frame so it plays exactly as in the editor. */
function buildClip(scene: Scene, objects: Map<string, THREE.Object3D>): THREE.AnimationClip | null {
  const { clip } = scene;
  if (clip.tracks.length === 0) return null;
  const frames = frameCount(clip);
  const times = Array.from({ length: frames }, (_, frame) => Math.min(frame / clip.fps, clip.duration));
  const euler = new THREE.Euler();
  const quaternion = new THREE.Quaternion();
  const tracks = clip.tracks.flatMap((track) => {
    const object = objects.get(track.node);
    if (!object) return [];
    const samples = times.map((t) => sampleTrack(track.keys, t));
    if (track.property !== "rotation") {
      return new THREE.VectorKeyframeTrack(`${object.uuid}.${track.property}`, times, samples.flat());
    }
    const turns = samples.flatMap(([x, y, z]) =>
      quaternion.setFromEuler(euler.set(x * DEG, y * DEG, z * DEG, "XYZ")).toArray(),
    );
    return new THREE.QuaternionKeyframeTrack(`${object.uuid}.quaternion`, times, turns);
  });
  return new THREE.AnimationClip("Clip", clip.duration, tracks);
}

export function buildThreeScene(scene: Scene): { root: THREE.Scene; clip: THREE.AnimationClip | null } {
  const root = new THREE.Scene();
  const objects = new Map<string, THREE.Object3D>();
  for (const id of childIds(scene, null)) root.add(...buildNode(scene, scene.nodes[id], objects));

  const { sun } = scene.environment;
  const sunLight = aimDownNegativeZ(new THREE.DirectionalLight(sun.color, sun.intensity));
  sunLight.name = "Sun";
  // three.js starts directional lights at (0, 1, 0); only the rotation matters here.
  sunLight.position.set(0, 0, 0);
  // Turn the light so its +Z points back at the sun.
  sunLight.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(...sunDirection(sun)),
  );
  root.add(sunLight);

  const camera = new THREE.PerspectiveCamera(scene.camera.fov, 16 / 9, 0.1, 1200);
  camera.name = "Camera";
  camera.position.fromArray(scene.camera.position);
  camera.lookAt(...scene.camera.target);
  root.add(camera);
  return { root, clip: buildClip(scene, objects) };
}

export async function toGlb(scene: Scene): Promise<Blob> {
  const { root, clip } = buildThreeScene(scene);
  root.updateMatrixWorld(true);
  // `trs` writes position / rotation / scale instead of a baked matrix, which
  // keeps objects editable in whatever opens the file.
  const result = await new GLTFExporter().parseAsync(root, {
    binary: true,
    trs: true,
    animations: clip ? [clip] : [],
  });
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) (object.material as THREE.Material).dispose();
  });
  return new Blob([result as ArrayBuffer], { type: "model/gltf-binary" });
}
