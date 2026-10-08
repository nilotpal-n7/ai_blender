"use client";

import {
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FolderOpen,
  LoaderCircle,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { flushSave } from "@/client/autosave";
import { download, fileBase } from "@/client/shot";
import { useEditor } from "@/client/store";
import { toBlenderScript } from "@/export/blender";
import { toUsda } from "@/export/usda";
import { PRIMITIVES, PRIMITIVE_INFO } from "@/scene/types";
import type { SceneSummary } from "@/server/store";
import { IconButton, Menu, MenuItem, TextField } from "./ui";

function ScenesMenu() {
  const router = useRouter();
  const currentId = useEditor((s) => s.doc.id);
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);

  const load = async () => {
    const response = await fetch("/api/scenes");
    setScenes(response.ok ? ((await response.json()) as { scenes: SceneSummary[] }).scenes : []);
  };
  const open = async (id: string) => {
    await flushSave();
    router.push(`/s/${id}`);
  };
  const create = async () => {
    await flushSave();
    const response = await fetch("/api/scenes", { method: "POST" });
    if (response.ok) router.push(`/s/${((await response.json()) as { id: string }).id}`);
  };
  const remove = async () => {
    if (!window.confirm("Delete this scene? This can't be undone.")) return;
    // Mark the scene saved so autosave doesn't write it back after the delete.
    useEditor.getState().setSave("saved");
    await fetch(`/api/scenes/${currentId}`, { method: "DELETE" });
    router.push("/");
  };

  return (
    <Menu
      trigger={
        <span className="flex items-center gap-1.5" onPointerDown={() => void load()}>
          <FolderOpen size={14} /> Scenes <ChevronDown size={12} />
        </span>
      }
    >
      {(close) => (
        <>
          <MenuItem
            onSelect={() => {
              close();
              void create();
            }}
          >
            <Plus size={13} /> New scene
          </MenuItem>
          <div className="my-1 max-h-64 overflow-y-auto border-y border-line py-1">
            {scenes === null ? (
              <p className="px-2 py-1.5 text-xs text-faint">Loading…</p>
            ) : (
              scenes.map((scene) => (
                <MenuItem
                  key={scene.id}
                  hint={`${scene.objects} obj`}
                  onSelect={() => {
                    close();
                    if (scene.id !== currentId) void open(scene.id);
                  }}
                >
                  {scene.id === currentId ? <Check size={13} /> : <span className="w-[13px]" />}
                  <span className="truncate">{scene.name}</span>
                </MenuItem>
              ))
            )}
          </div>
          <MenuItem
            danger
            onSelect={() => {
              close();
              void remove();
            }}
          >
            <Trash2 size={13} /> Delete this scene
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function ExportMenu() {
  const save = (extension: string, build: (name: string) => Blob | string | Promise<Blob | string>) => async () => {
    const { doc } = useEditor.getState();
    download(`${fileBase(doc.name)}.${extension}`, await build(doc.name));
  };
  const scene = () => useEditor.getState().doc.scene;

  return (
    <Menu
      align="right"
      trigger={
        <>
          <Download size={14} /> Export <ChevronDown size={12} />
        </>
      }
    >
      {(close) => (
        <div onClick={close}>
          <MenuItem
            hint=".py"
            onSelect={save("py", (name) => toBlenderScript(scene(), name))}
          >
            Blender script
          </MenuItem>
          <MenuItem hint=".usda" onSelect={save("usda", (name) => toUsda(scene(), name))}>
            OpenUSD
          </MenuItem>
          <MenuItem
            hint=".glb"
            // three's exporter is only loaded when it is first needed.
            onSelect={save("glb", async () => (await import("@/export/glb")).toGlb(scene()))}
          >
            glTF binary
          </MenuItem>
        </div>
      )}
    </Menu>
  );
}

function SaveBadge() {
  const save = useEditor((s) => s.save);
  const view = {
    saved: { icon: <Check size={12} />, text: "Saved", tone: "text-faint" },
    unsaved: { icon: <LoaderCircle size={12} />, text: "Unsaved", tone: "text-faint" },
    saving: { icon: <LoaderCircle size={12} className="animate-spin" />, text: "Saving", tone: "text-faint" },
    error: { icon: <CircleAlert size={12} />, text: "Save failed", tone: "text-err" },
  }[save];
  return (
    <span className={`flex items-center gap-1 text-xs ${view.tone}`} role="status">
      {view.icon} {view.text}
    </span>
  );
}

export default function TopBar() {
  const name = useEditor((s) => s.doc.name);
  const canUndo = useEditor((s) => s.doc.undo.length > 0 && !s.generating);
  const canRedo = useEditor((s) => s.doc.redo.length > 0 && !s.generating);
  const undoLabel = useEditor((s) => s.doc.undo.at(-1)?.label);
  const locked = useEditor((s) => s.generating);
  const { undo, redo, rename, addPrimitive, addLight } = useEditor.getState();

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
      <div className="flex items-center gap-2 pr-1">
        <span className="grid size-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-white">
          AB
        </span>
        <TextField
          label="Scene name"
          value={name}
          onCommit={rename}
          className="!w-28 !border-transparent !bg-transparent font-medium hover:!border-line focus:!border-accent sm:!w-52"
        />
      </div>
      <ScenesMenu />

      <div className="mx-1 h-5 w-px bg-line" />

      <IconButton label={undoLabel ? `Undo: ${undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)"} disabled={!canUndo} onClick={undo}>
        <Undo2 size={15} />
      </IconButton>
      <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <Redo2 size={15} />
      </IconButton>

      <Menu
        trigger={
          <>
            <Plus size={14} /> Add <ChevronDown size={12} />
          </>
        }
      >
        {(close) => (
          <fieldset disabled={locked} className="contents" onClick={close}>
            {PRIMITIVES.map((primitive) => (
              <MenuItem key={primitive} onSelect={() => addPrimitive(primitive)}>
                <span className="capitalize" title={PRIMITIVE_INFO[primitive]}>
                  {primitive}
                </span>
              </MenuItem>
            ))}
            <div className="my-1 border-t border-line" />
            <MenuItem onSelect={() => addLight("point")}>Point light</MenuItem>
            <MenuItem onSelect={() => addLight("spot")}>Spot light</MenuItem>
          </fieldset>
        )}
      </Menu>

      <div className="flex-1" />
      <SaveBadge />
      <ExportMenu />
    </header>
  );
}
