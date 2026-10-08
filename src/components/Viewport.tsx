"use client";

import { Environment, GizmoHelper, GizmoViewport, Grid, OrbitControls, Outlines, TransformControls } from "@react-three/drei";
import { Canvas, extend, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  Bloom,
  BrightnessContrast,
  EffectComposer,
  HueSaturation,
  N8AO,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";
import { useEditor } from "@/client/store";
import { sampleTrack } from "@/scene/animate";
import { arrayCopies } from "@/scene/array";
import { DEG, roundVec, sunDirection } from "@/scene/math";
import { childIds } from "@/scene/ops";
import type { Animatable, Environment as SceneEnvironment, GroupNode, LightNode, MeshNode, Vec3 } from "@/scene/types";
import { fusedFinish, fusedMesh, fusedParts, isFused } from "@/shapes/blend";
import { hasVertexColors, meshDataGeometry, nodeGeometry, primitiveGeometry } from "@/three/geometry";
import { registry } from "@/three/registry";
import { stage } from "@/three/stage";
import { WornMaterial, wearSeed } from "@/three/wear";

const Worn = extend(WornMaterial);

const ACCENT = "#8f7dff";
const SUN_DISTANCE = 40;
const SKY_RADIUS = 500;

/** When the gizmo was last released; the click that ends a drag must not reselect. */
let gizmoReleasedAt = 0;
const justUsedGizmo = () => performance.now() - gizmoReleasedAt < 200;
/** The node being dragged by the gizmo, which playback must leave alone meanwhile. */
let dragging: string | null = null;

function onPick(id: string) {
  return (event: ThreeEvent<MouseEvent>) => {
    // `delta` is how far the pointer travelled; more than a few pixels is an orbit, not a click.
    if (event.delta > 4 || justUsedGizmo()) return;
    event.stopPropagation();
    useEditor.getState().pick(id);
  };
}

function MeshBody({ node, lit }: { node: MeshNode; lit: boolean }) {
  const { material } = node;
  const surface = {
    color: material.color,
    // Generated shapes carry shading in their colors; the material color tints it.
    vertexColors: hasVertexColors(node.primitive),
    roughness: material.roughness,
    metalness: material.metalness,
    emissive: material.emissive,
    emissiveIntensity: material.emissiveIntensity,
    transparent: material.opacity < 1,
    opacity: material.opacity,
    side: node.primitive === "plane" ? THREE.DoubleSide : THREE.FrontSide,
  };
  return (
    <mesh castShadow receiveShadow onClick={onPick(node.id)}>
      <primitive object={nodeGeometry(node)} attach="geometry" />
      {material.wear > 0 ? (
        <Worn {...surface} wear={material.wear} seed={wearSeed(node.id)} />
      ) : (
        <meshStandardMaterial {...surface} />
      )}
      {lit && <Outlines thickness={3} color={ACCENT} />}
    </mesh>
  );
}

/** A part that has been fused into its group's surface, shown only while it is selected. */
function FusedPartGhost({ node }: { node: MeshNode }) {
  return (
    <mesh>
      <primitive object={primitiveGeometry(node.primitive)} attach="geometry" />
      <meshBasicMaterial color={ACCENT} wireframe transparent opacity={0.6} depthTest={false} toneMapped={false} />
    </mesh>
  );
}

/** The single smooth surface of a blending group. */
function FusedBody({ id, lit }: { id: string; lit: boolean }) {
  // Rebuild only when something that shapes the surface changes.
  const signature = useEditor((s) => {
    const group = s.doc.scene.nodes[id] as GroupNode;
    return JSON.stringify([fusedParts(s.doc.scene, group), group.blend, fusedFinish(s.doc.scene, group)]);
  });
  const { geometry, finish } = useMemo(() => {
    const { scene } = useEditor.getState().doc;
    const group = scene.nodes[id] as GroupNode;
    return { geometry: meshDataGeometry(fusedMesh(scene, group)), finish: fusedFinish(scene, group) };
    // `signature` stands for everything read from the scene here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, signature]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  if (!geometry.getAttribute("position")?.count) return null;
  return (
    <mesh castShadow receiveShadow onClick={onPick(id)} geometry={geometry} dispose={null}>
      <meshStandardMaterial vertexColors roughness={finish.roughness} metalness={finish.metalness} />
      {lit && <Outlines thickness={3} color={ACCENT} />}
    </mesh>
  );
}

function SpotLight({ light }: { light: LightNode["light"] }) {
  const ref = useRef<THREE.SpotLight>(null);
  // three.js aims a spot at `target`; parenting it under the light makes the
  // beam follow the node's rotation, pointing down local −Y.
  useLayoutEffect(() => {
    const spot = ref.current;
    if (!spot) return;
    spot.add(spot.target);
    spot.target.position.set(0, -1, 0);
    return () => {
      spot.remove(spot.target);
    };
  }, []);
  return (
    <spotLight
      ref={ref}
      color={light.color}
      intensity={light.intensity}
      distance={light.distance}
      angle={light.angle * DEG}
      penumbra={0.35}
      castShadow
      shadow-mapSize={[1024, 1024]}
      shadow-bias={-0.0005}
    />
  );
}

function LightBody({ node, lit }: { node: LightNode; lit: boolean }) {
  const { light } = node;
  return (
    <>
      {light.type === "spot" ? (
        <SpotLight light={light} />
      ) : (
        <pointLight color={light.color} intensity={light.intensity} distance={light.distance} />
      )}
      {/* Lights are invisible on their own; this marker makes them clickable. */}
      <mesh onClick={onPick(node.id)} scale={lit ? 1.5 : 1}>
        <octahedronGeometry args={[0.1, 0]} />
        <meshBasicMaterial color={lit ? ACCENT : light.color} wireframe toneMapped={false} />
      </mesh>
    </>
  );
}

const NodeView = memo(function NodeView({ id, inSelection }: { id: string; inSelection: boolean }) {
  const node = useEditor((s) => s.doc.scene.nodes[id]);
  const children = useEditor(useShallow((s) => childIds(s.doc.scene, id)));
  const selected = useEditor((s) => s.selection === id);
  const fused = useEditor((s) => {
    const current = s.doc.scene.nodes[id];
    return current !== undefined && isFused(s.doc.scene, current);
  });
  const attach = useCallback(
    (object: THREE.Group | null) => {
      registry.set(id, object);
      return () => registry.set(id, null);
    },
    [id],
  );
  if (!node) return null;

  const lit = inSelection || selected;
  const [rx, ry, rz] = node.rotation;
  const placed = {
    position: node.position,
    rotation: [rx * DEG, ry * DEG, rz * DEG] as Vec3,
    scale: node.scale,
    visible: node.visible,
  };
  const drawn = node.kind === "mesh" && !fused;
  // The copies of an arrayed mesh stand beside it, in its parent's space.
  const copies = drawn ? arrayCopies(node.array).slice(1) : [];
  return (
    <>
      <group ref={attach} {...placed}>
        {drawn && <MeshBody node={node} lit={lit} />}
        {node.kind === "mesh" && fused && selected && <FusedPartGhost node={node} />}
        {node.kind === "group" && node.blend > 0 && <FusedBody id={id} lit={lit} />}
        {node.kind === "light" && <LightBody node={node} lit={lit} />}
        {children.map((child) => (
          <NodeView key={child} id={child} inSelection={lit} />
        ))}
      </group>
      {copies.map((copy, i) => (
        <group key={i} position={copy.position} rotation={copy.rotation.map((d) => d * DEG) as Vec3}>
          <group {...placed}>{drawn && <MeshBody node={node} lit={lit} />}</group>
        </group>
      ))}
    </>
  );
});

/** The sky's colors: the chosen color overhead, hazier at the horizon, with a glow around the sun. */
function skyColors(env: SceneEnvironment) {
  const zenith = new THREE.Color(env.background);
  const horizon = env.fog
    ? new THREE.Color(env.fog.color)
    : zenith.clone().lerp(new THREE.Color("#ffffff"), 0.22);
  const sun = new THREE.Color(env.sun.color).multiplyScalar(env.sun.intensity);
  return { zenith, horizon, sun };
}

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 sun;
  uniform vec3 sunDirection;
  varying vec3 vDirection;
  void main() {
    vec3 direction = normalize(vDirection);
    vec3 color = mix(horizon, zenith, pow(clamp(direction.y, 0.0, 1.0), 0.45));
    float toward = max(dot(direction, sunDirection), 0.0);
    // A soft halo plus a small bright disc.
    color += sun * (0.05 * pow(toward, 12.0) + 0.9 * pow(toward, 900.0));
    gl_FragColor = vec4(color, 1.0);
  }
`;

function Sky({ env }: { env: SceneEnvironment }) {
  const uniforms = useMemo(() => {
    const { zenith, horizon, sun } = skyColors(env);
    return {
      zenith: { value: zenith },
      horizon: { value: horizon },
      sun: { value: sun },
      sunDirection: { value: new THREE.Vector3(...sunDirection(env.sun)) },
    };
  }, [env]);
  return (
    <mesh scale={SKY_RADIUS} frustumCulled={false}>
      <sphereGeometry args={[1, 48, 24]} />
      <shaderMaterial
        key={JSON.stringify(env)}
        side={THREE.BackSide}
        depthWrite={false}
        fog={false}
        uniforms={uniforms}
        vertexShader={SKY_VERTEX}
        fragmentShader={SKY_FRAGMENT}
      />
    </mesh>
  );
}

function SceneEnvironmentView() {
  const env = useEditor((s) => s.doc.scene.environment);
  const [x, y, z] = sunDirection(env.sun);
  const { zenith, horizon, sun } = useMemo(() => skyColors(env), [env]);
  const ground = useMemo(() => new THREE.Color(env.ground.color).multiplyScalar(0.6), [env.ground.color]);

  return (
    <>
      <color attach="background" args={[env.background]} />
      {env.fog && <fog attach="fog" args={[env.fog.color, env.fog.near, env.fog.far]} />}
      <Sky env={env} />
      {/* What surfaces reflect and are softly lit by: a small stand-in for the sky, ground and sun. */}
      <Environment key={JSON.stringify(env)} resolution={64} frames={1} environmentIntensity={0.55 * env.ambient + 0.15}>
        <mesh scale={50}>
          <sphereGeometry args={[1, 24, 12]} />
          <meshBasicMaterial side={THREE.BackSide} color={zenith.clone().lerp(horizon, 0.5)} toneMapped={false} />
        </mesh>
        <mesh position={[0, -30, 0]} rotation-x={-Math.PI / 2}>
          <circleGeometry args={[60, 24]} />
          <meshBasicMaterial color={ground} toneMapped={false} />
        </mesh>
        <mesh position={[x * 30, y * 30, z * 30]} scale={5}>
          <sphereGeometry args={[1, 16, 8]} />
          <meshBasicMaterial color={sun.clone().multiplyScalar(4)} toneMapped={false} />
        </mesh>
      </Environment>
      <hemisphereLight args={["#ffffff", env.ground.color, env.ambient]} />
      <directionalLight
        position={[x * SUN_DISTANCE, y * SUN_DISTANCE, z * SUN_DISTANCE]}
        color={env.sun.color}
        intensity={env.sun.intensity}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.03}
      >
        <orthographicCamera attach="shadow-camera" args={[-25, 25, 25, -25, 1, 120]} />
      </directionalLight>
      {env.ground.visible && (
        <mesh rotation-x={-Math.PI / 2} position-y={-0.002} receiveShadow>
          <circleGeometry args={[300, 64]} />
          <meshStandardMaterial color={env.ground.color} roughness={1} />
        </mesh>
      )}
    </>
  );
}

/**
 * Contact shadows in creases, glow on anything brighter than white, filmic
 * tone mapping, and then the scene's grade.
 */
function Effects() {
  const grade = useEditor((s) => s.doc.scene.environment.grade);
  const graded = grade.saturation !== 1 || grade.contrast !== 0;
  return (
    // Keyed, because the composer builds its chain once from the effects it is given.
    <EffectComposer key={`${graded}/${grade.vignette > 0}`} multisampling={4} enableNormalPass={false}>
      <N8AO aoRadius={0.9} distanceFalloff={1.2} intensity={2.4} quality="medium" halfRes />
      <Bloom mipmapBlur intensity={grade.bloom} luminanceThreshold={1.1} luminanceSmoothing={0.25} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      {graded ? <HueSaturation saturation={grade.saturation - 1} /> : <></>}
      {graded ? <BrightnessContrast contrast={grade.contrast} /> : <></>}
      {grade.vignette > 0 ? <Vignette offset={0.35} darkness={grade.vignette} /> : <></>}
    </EffectComposer>
  );
}

function setTransform(object: THREE.Object3D, property: Animatable, value: Vec3) {
  if (property === "rotation") object.rotation.set(value[0] * DEG, value[1] * DEG, value[2] * DEG);
  else object[property].set(value[0], value[1], value[2]);
}

/**
 * Advances the playhead and poses the scene for it. Poses are written straight
 * onto the three.js objects, so playing doesn't re-render the React tree.
 */
function Playback() {
  // Which properties are currently posed, so they can be put back when their track goes.
  const posed = useRef(new Set<string>());

  useFrame((_, delta) => {
    const state = useEditor.getState();
    const { clip, nodes } = state.doc.scene;
    let { time } = state;
    if (state.playing) {
      time += Math.min(delta, 0.1);
      if (time >= clip.duration) {
        // A recording is one pass through the clip, even if the clip loops.
        const wraps = clip.loop && !state.recording;
        time = wraps ? time % clip.duration : clip.duration;
        useEditor.setState({ time, playing: wraps });
      } else {
        useEditor.setState({ time });
      }
    }

    const current = new Set<string>();
    for (const track of clip.tracks) {
      const object = registry.get(track.node);
      if (!object) continue;
      const key = `${track.node}/${track.property}`;
      current.add(key);
      if (track.node !== dragging) setTransform(object, track.property, sampleTrack(track.keys, time));
    }
    for (const key of posed.current) {
      if (current.has(key)) continue;
      const [id, property] = key.split("/") as [string, Animatable];
      const [object, node] = [registry.get(id), nodes[id]];
      if (object && node) setTransform(object, property, node[property]);
    }
    posed.current = current;
  });
  return null;
}

/** Lets code outside the canvas reach the camera and the picture. */
function StageBinding() {
  const camera = useThree((s) => s.camera);
  const canvas = useThree((s) => s.gl.domElement);
  const controls = useThree((s) => s.controls) as typeof stage.controls;
  useEffect(() => {
    Object.assign(stage, { camera, canvas, controls });
    return () => void Object.assign(stage, { camera: null, canvas: null, controls: null });
  }, [camera, canvas, controls]);
  return null;
}

/** A wire outline of the camera that renders and recordings are taken from. */
function ShotCamera() {
  const shot = useEditor((s) => s.doc.scene.camera);
  const ref = useRef<THREE.LineSegments>(null);
  const { geometry, quaternion } = useMemo(() => {
    // The frame the camera sees, a short way in front of it (16:9).
    const depth = 0.7;
    const h = Math.tan((shot.fov * DEG) / 2) * depth;
    const w = (h * 16) / 9;
    const corners = [[-w, -h], [w, -h], [w, h], [-w, h]];
    const points: number[] = [];
    corners.forEach(([x, y], i) => {
      const [nx, ny] = corners[(i + 1) % 4];
      points.push(0, 0, 0, x, y, -depth, x, y, -depth, nx, ny, -depth);
    });
    // A tick above the frame shows which way is up.
    points.push(-w * 0.3, h * 1.06, -depth, 0, h * 1.3, -depth, 0, h * 1.3, -depth, w * 0.3, h * 1.06, -depth);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const facing = new THREE.Matrix4().lookAt(
      new THREE.Vector3(...shot.position),
      new THREE.Vector3(...shot.target),
      new THREE.Vector3(0, 1, 0),
    );
    return { geometry, quaternion: new THREE.Quaternion().setFromRotationMatrix(facing) };
  }, [shot]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // Looking through the camera, its own outline would only be in the way.
  useFrame(({ camera }) => {
    const lines = ref.current;
    if (lines) lines.visible = camera.position.distanceTo(lines.position) > 0.6;
  });
  return (
    <lineSegments ref={ref} position={shot.position} quaternion={quaternion} geometry={geometry}>
      <lineBasicMaterial color="#e8c14a" toneMapped={false} />
    </lineSegments>
  );
}

/** Move / rotate / scale handles on the selected object. */
function Gizmo() {
  const selection = useEditor((s) => s.selection);
  const mode = useEditor((s) => s.mode);
  const generating = useEditor((s) => s.generating);
  const object = useSyncExternalStore(registry.subscribe, () =>
    selection ? registry.get(selection) : undefined,
  );
  if (!selection || !object || generating) return null;

  const commit = () => {
    gizmoReleasedAt = performance.now();
    dragging = null;
    const { doc, time, transform } = useEditor.getState();
    const node = doc.scene.nodes[selection];
    if (!node) return;
    // What the object showed before the drag: its key at the playhead if it is animated.
    const shown = (property: Animatable) => {
      const track = doc.scene.clip.tracks.find((t) => t.node === selection && t.property === property);
      return track ? sampleTrack(track.keys, time) : node[property];
    };
    const moved = (a: Vec3, b: Vec3) => a.some((v, i) => Math.abs(v - b[i]) > 1e-4);
    const position = roundVec(object.position.toArray());
    const rotation = roundVec([object.rotation.x / DEG, object.rotation.y / DEG, object.rotation.z / DEG], 2);
    const scale = roundVec(object.scale.toArray().map((v) => Math.max(0.001, Math.abs(v))));
    const values: Partial<Record<Animatable, Vec3>> = {};
    if (moved(position, shown("position"))) values.position = position;
    if (moved(rotation, shown("rotation"))) values.rotation = rotation;
    if (moved(scale, shown("scale"))) values.scale = scale;
    if (Object.keys(values).length === 0) return;
    const verb = { translate: "Move", rotate: "Rotate", scale: "Resize" }[mode];
    transform(selection, values, `${verb} ${node.name}`);
  };

  return (
    <TransformControls
      object={object}
      mode={mode}
      size={0.75}
      onMouseDown={() => {
        dragging = selection;
      }}
      onMouseUp={commit}
    />
  );
}

/** Frames the whole scene when the store asks for it. */
function CameraRig() {
  const request = useEditor((s) => s.frameRequest);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update(): void } | null;

  useEffect(() => {
    if (request === 0 || !controls) return;
    // Wait a frame so objects added in the same update have their matrices.
    const frame = requestAnimationFrame(() => {
      const { scene } = useEditor.getState().doc;
      const roots = childIds(scene, null);
      // Frame the things, not the lamps hanging far above them.
      const solid = roots.filter((id) => scene.nodes[id].kind !== "light");
      const box = new THREE.Box3();
      for (const id of solid.length > 0 ? solid : roots) {
        const object = registry.get(id);
        if (object) box.expandByObject(object);
      }
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const fov = (camera as THREE.PerspectiveCamera).fov * DEG;
      const distance = Math.max(sphere.radius, 1) / Math.sin(fov / 2) * 1.15;
      const direction = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).addScaledVector(direction, distance);
      controls.update();
    });
    return () => cancelAnimationFrame(frame);
  }, [request, camera, controls]);

  return null;
}

function SceneRoots() {
  const roots = useEditor(useShallow((s) => childIds(s.doc.scene, null)));
  return roots.map((id) => <NodeView key={id} id={id} inSelection={false} />);
}

export default function Viewport() {
  const recording = useEditor((s) => s.recording);
  const grid = useEditor((s) => s.grid) && !recording;
  return (
    <Canvas
      shadows="soft"
      // Tone mapping happens once, at the end of the effect chain.
      flat
      dpr={[1, 2]}
      camera={{ position: [7, 5, 9], fov: 45, near: 0.1, far: 1200 }}
      onPointerMissed={() => {
        if (!justUsedGizmo()) useEditor.getState().select(null);
      }}
    >
      <SceneEnvironmentView />
      <SceneRoots />
      <Playback />
      <StageBinding />
      {!recording && <Gizmo />}
      {!recording && <ShotCamera />}
      <CameraRig />
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} target={[0, 1, 0]} maxDistance={300} />
      {grid && (
        <Grid
          position={[0, 0.003, 0]}
          infiniteGrid
          cellSize={1}
          sectionSize={5}
          cellThickness={0.5}
          sectionThickness={0.8}
          cellColor="#3d4256"
          sectionColor="#5d6380"
          fadeDistance={45}
          fadeStrength={2}
        />
      )}
      <Effects />
      {/* Drawn after the effects, so the axis widget stays crisp. */}
      {!recording && (
        <GizmoHelper alignment="bottom-right" margin={[64, 64]} renderPriority={2}>
          <GizmoViewport axisColors={["#f0506e", "#5fd97a", "#4f8dfd"]} labelColor="#0b0c10" />
        </GizmoHelper>
      )}
    </Canvas>
  );
}
