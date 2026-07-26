"use client";

import dynamic from "next/dynamic";
import PromptPanel from "./components/PromptPanel";

// Dynamically import Viewport to prevent SSR issues with Three.js/WebGL
const Viewport = dynamic(() => import("./components/Viewport"), {
  ssr: false,
  loading: () => (
    <div
      className="flex-1 flex items-center justify-center"
      style={{ background: "var(--viewport-bg)" }}
    >
      <div className="flex flex-col items-center gap-4 animate-fade-in">
        <div
          className="w-12 h-12 rounded-full animate-pulse-glow"
          style={{ background: "var(--accent-primary)" }}
        />
        <span
          className="text-sm font-mono"
          style={{ color: "var(--text-muted)" }}
        >
          Initializing viewport...
        </span>
      </div>
    </div>
  ),
});

/**
 * Home — Main editor page.
 *
 * Layout: Full-screen with header bar, main viewport area, and right sidebar.
 * The viewport occupies all available space, and the prompt panel is fixed-width on the right.
 */
export default function Home() {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      {/* ─── Header Bar ────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-4 shrink-0"
        style={{
          height: "var(--header-height)",
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {/* Logo & Title */}
        <div className="flex items-center gap-3">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
            style={{
              background: "var(--accent-gradient)",
              color: "white",
            }}
          >
            AB
          </div>
          <h1
            className="text-sm font-semibold tracking-tight"
            style={{ color: "var(--text-primary)" }}
          >
            AI Blender
          </h1>
          <span
            className="text-xs font-mono px-2 py-0.5 rounded-full"
            style={{
              background: "var(--accent-glow)",
              color: "var(--accent-primary)",
              border: "1px solid var(--border-active)",
            }}
          >
            v0.1.0
          </span>
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-2">
          {/* Scene Name */}
          <span
            className="text-xs font-mono"
            style={{ color: "var(--text-muted)" }}
          >
            Untitled Scene
          </span>

          {/* Render Button (disabled for now) */}
          <button
            id="render-button"
            disabled
            className="px-3 py-1.5 rounded-lg text-xs font-semibold
                       transition-all duration-200 cursor-not-allowed opacity-40"
            style={{
              background: "var(--bg-tertiary)",
              color: "var(--text-muted)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            🎬 Render
          </button>
        </div>
      </header>

      {/* ─── Main Content ──────────────────────────────────────────── */}
      <main className="flex flex-1 overflow-hidden">
        {/* 3D Viewport (fills remaining space) */}
        <div className="flex-1 relative">
          <Viewport />
        </div>

        {/* Prompt Panel (fixed-width sidebar) */}
        <PromptPanel />
      </main>
    </div>
  );
}
