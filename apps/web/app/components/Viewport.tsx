"use client";

import { useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  Environment,
  PerspectiveCamera,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";

/**
 * Viewport — Interactive 3D viewport using React Three Fiber.
 *
 * This component renders the WebGL canvas with orbit controls,
 * an infinite grid, and environment lighting. It will eventually
 * display streamed .usdz scenes and handle user override generation.
 */
export default function Viewport() {
  const controlsRef = useRef(null);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative w-full h-full"
      style={{ background: "var(--viewport-bg)" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Canvas
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
        }}
        dpr={[1, 2]}
        shadows
      >
        {/* Camera */}
        <PerspectiveCamera makeDefault position={[8, 6, 8]} fov={45} />

        {/* Controls */}
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.05}
          minDistance={2}
          maxDistance={100}
          maxPolarAngle={Math.PI / 2 + 0.1}
        />

        {/* Lighting */}
        <ambientLight intensity={0.15} />
        <directionalLight
          position={[10, 15, 10]}
          intensity={0.8}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        <pointLight position={[-5, 5, -5]} intensity={0.3} color="#7c64ff" />

        {/* Environment */}
        <Environment preset="night" />

        {/* Ground Grid */}
        <Grid
          position={[0, 0, 0]}
          args={[100, 100]}
          cellSize={1}
          cellThickness={0.5}
          cellColor="#1a1a35"
          sectionSize={5}
          sectionThickness={1}
          sectionColor="#2a2a50"
          fadeDistance={50}
          fadeStrength={1}
          followCamera={false}
          infiniteGrid
        />

        {/* Placeholder scene object — a glass-like torus knot */}
        <mesh position={[0, 1.5, 0]} castShadow>
          <torusKnotGeometry args={[1, 0.35, 128, 32]} />
          <meshPhysicalMaterial
            color="#7c64ff"
            metalness={0.2}
            roughness={0.1}
            transmission={0.6}
            thickness={1.5}
            ior={1.5}
            envMapIntensity={1.5}
          />
        </mesh>

        {/* Navigation Gizmo */}
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport
            axisColors={["#ff4060", "#40ff60", "#4060ff"]}
            labelColor="white"
          />
        </GizmoHelper>
      </Canvas>

      {/* Viewport Overlay: Status Bar */}
      <div
        className="absolute bottom-0 left-0 right-0 px-4 py-2 flex items-center justify-between text-xs"
        style={{
          background: "linear-gradient(transparent, rgba(10, 10, 15, 0.9))",
          color: "var(--text-muted)",
        }}
      >
        <span className="font-mono">WebGL • Orbit Mode</span>
        <span className="font-mono">No scene loaded</span>
      </div>

      {/* Focus Ring */}
      {hovered && (
        <div
          className="absolute inset-0 pointer-events-none rounded-sm"
          style={{
            border: "1px solid var(--border-active)",
            transition: "opacity var(--duration-fast) var(--ease-out)",
          }}
        />
      )}
    </div>
  );
}
