import * as THREE from "three";
import { GENERATED, isBeveled, nodeMesh, primitiveMesh } from "@/export/meshdata";
import type { Primitive, Vec3 } from "@/scene/types";
import type { MeshData } from "@/shapes/mesh";

/** Turns plain mesh data into three.js geometry, carrying its colors along. */
export function meshDataGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.points.flat(), 3));
  if (mesh.colors) {
    // Mesh data colors are sRGB; three.js wants vertex colors linear.
    const linear = mesh.colors.flatMap((c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace).toArray());
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(linear, 3));
  }
  const index: number[] = [];
  for (const face of mesh.faces) {
    // Fan triangulation; faces are convex.
    for (let i = 1; i + 1 < face.length; i++) index.push(face[0], face[i], face[i + 1]);
  }
  geometry.setIndex(index);
  if (mesh.normals) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals.flat(), 3));
    return geometry;
  }
  if (mesh.smooth) {
    geometry.computeVertexNormals();
    return geometry;
  }
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  geometry.dispose();
  return flat;
}

const cache = new Map<Primitive, THREE.BufferGeometry>();

function build(primitive: Primitive): THREE.BufferGeometry {
  switch (primitive) {
    case "box":
      return new THREE.BoxGeometry(1, 1, 1);
    case "sphere":
      return new THREE.SphereGeometry(0.5, 48, 24);
    case "cylinder":
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 48);
    case "cone":
      return new THREE.ConeGeometry(0.5, 1, 48);
    case "pyramid": {
      // A 4-sided cone turned so its faces line up with the axes; un-indexed
      // so each face gets its own flat normal.
      const cone = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, false, Math.PI / 4);
      const flat = cone.toNonIndexed();
      flat.computeVertexNormals();
      cone.dispose();
      return flat;
    }
    case "torus":
      return new THREE.TorusGeometry(0.375, 0.125, 24, 64).rotateX(Math.PI / 2);
    case "plane":
      return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    default:
      return meshDataGeometry(primitiveMesh(primitive));
  }
}

/** Unit-sized geometry for a primitive, shared by every mesh that uses it. */
export function primitiveGeometry(primitive: Primitive): THREE.BufferGeometry {
  let geometry = cache.get(primitive);
  if (!geometry) {
    geometry = build(primitive);
    cache.set(primitive, geometry);
  }
  return geometry;
}

const beveled = new Map<string, THREE.BufferGeometry>();

/** Geometry for a mesh node: the shared unit primitive, or a box rounded for the node's size. */
export function nodeGeometry(node: { primitive: Primitive; scale: Vec3; bevel: number }): THREE.BufferGeometry {
  if (!isBeveled(node)) return primitiveGeometry(node.primitive);
  const key = `${node.scale.join(",")}|${node.bevel}`;
  let geometry = beveled.get(key);
  if (!geometry) {
    geometry = meshDataGeometry(nodeMesh(node));
    // Sizes change while dragging, so old entries are dropped rather than kept forever.
    if (beveled.size > 1500) {
      beveled.forEach((old) => old.dispose());
      beveled.clear();
    }
    beveled.set(key, geometry);
  }
  return geometry;
}

/** Whether a primitive's geometry carries colors that the material must multiply in. */
export const hasVertexColors = (primitive: Primitive) => GENERATED.has(primitive);
