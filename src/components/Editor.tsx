"use client";

import { Grid3x3, Maximize, Move3d, Rotate3d, Scale3d } from "lucide-react";
import { useEffect, useLayoutEffect } from "react";
import { flushSave, startAutosave } from "@/client/autosave";
import { useEditor, type GizmoMode, type PlannerInfo } from "@/client/store";
import type { SceneDoc } from "@/scene/types";
import ChatPanel from "./ChatPanel";
import Inspector from "./Inspector";
import Outliner from "./Outliner";
import Timeline from "./Timeline";
import TopBar from "./TopBar";
import { IconButton } from "./ui";
import Viewport from "./Viewport";

const MODES: { mode: GizmoMode; key: string; label: string; icon: typeof Move3d }[] = [
  { mode: "translate", key: "g", label: "Move", icon: Move3d },
  { mode: "rotate", key: "r", label: "Rotate", icon: Rotate3d },
  { mode: "scale", key: "s", label: "Resize", icon: Scale3d },
];

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]");
      if (typing) return;
      const editor = useEditor.getState();
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;

      if (mod && key === "z") {
        if (event.shiftKey) editor.redo();
        else editor.undo();
      } else if (mod && key === "y") editor.redo();
      else if (mod && key === "d") editor.duplicateSelected();
      else if (mod || event.altKey) return;
      else if (key === "delete" || key === "backspace") editor.removeSelected();
      else if (key === "escape") editor.select(null);
      else if (key === "f" || key === "home") editor.frameAll();
      else if (key === " ") editor.togglePlay();
      else if (key === "k") editor.keySelected();
      else {
        const match = MODES.find((m) => m.key === key);
        if (!match) return;
        editor.setMode(match.mode);
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function ViewportOverlay() {
  const mode = useEditor((s) => s.mode);
  const empty = useEditor((s) => Object.keys(s.doc.scene.nodes).length === 0);
  const generating = useEditor((s) => s.generating);
  const count = useEditor((s) => Object.keys(s.doc.scene.nodes).length);
  const grid = useEditor((s) => s.grid);
  const { setMode, frameAll, toggleGrid } = useEditor.getState();

  return (
    <>
      <div className="absolute top-3 left-3 flex gap-0.5 rounded-lg border border-line bg-panel/90 p-1 backdrop-blur">
        {MODES.map(({ mode: m, key, label, icon: Icon }) => (
          <IconButton
            key={m}
            label={`${label} (${key.toUpperCase()})`}
            active={mode === m}
            onClick={() => setMode(m)}
          >
            <Icon size={15} />
          </IconButton>
        ))}
        <div className="mx-0.5 w-px bg-line" />
        <IconButton label="Frame everything (F)" onClick={frameAll}>
          <Maximize size={15} />
        </IconButton>
        <IconButton label={grid ? "Hide the grid" : "Show the grid"} active={grid} onClick={toggleGrid}>
          <Grid3x3 size={15} />
        </IconButton>
      </div>

      {empty && !generating && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="max-w-xs text-center text-sm leading-relaxed text-dim">
            An empty scene. Describe what you want in the co-pilot panel, or add a shape from the
            toolbar.
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 font-mono text-[11px] text-dim">
        {generating ? "Co-pilot is editing…" : `${count} ${count === 1 ? "node" : "nodes"}`}
      </div>
    </>
  );
}

export default function Editor({ doc, planner }: { doc: SceneDoc; planner: PlannerInfo }) {
  // The panels read the scene from the store, so they wait until it holds this one.
  const loaded = useEditor((s) => s.doc.id === doc.id);
  useLayoutEffect(() => {
    // Never replace what is being edited with an older copy from the server.
    if (useEditor.getState().doc.id !== doc.id) useEditor.getState().init(doc, planner);
    // Leaving this scene: save pending edits before the store moves on.
    return () => void flushSave(true);
  }, [doc, planner]);
  useEffect(() => startAutosave(), []);
  useShortcuts();

  if (!loaded) return <div className="h-dvh bg-bg" />;
  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <TopBar />
      {/* Narrow windows stack the chat under the viewport and drop the outliner. */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-panel lg:flex">
          <Outliner />
          <Inspector />
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Viewport />
            <ViewportOverlay />
          </div>
          <Timeline />
        </main>
        <aside className="h-[45%] shrink-0 border-t border-line bg-panel md:h-auto md:w-[300px] md:border-t-0 md:border-l xl:w-[340px]">
          <ChatPanel />
        </aside>
      </div>
    </div>
  );
}
