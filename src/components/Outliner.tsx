"use client";

import { Box, ChevronRight, Eye, EyeOff, Group, Lightbulb } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditor } from "@/client/store";
import { childIds, pathTo } from "@/scene/ops";
import { cx } from "./ui";

const KIND_ICON = { mesh: Box, group: Group, light: Lightbulb };

function OutlinerRow({
  id,
  depth,
  open,
  toggle,
}: {
  id: string;
  depth: number;
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}) {
  const node = useEditor((s) => s.doc.scene.nodes[id]);
  const children = useEditor(useShallow((s) => childIds(s.doc.scene, id)));
  const selected = useEditor((s) => s.selection === id);
  // A group stays open while something inside it is selected.
  const holdsSelection = useEditor(
    (s) => s.selection !== null && s.selection !== id && pathTo(s.doc.scene, s.selection).includes(id),
  );
  if (!node) return null;

  const expanded = open.has(id) || holdsSelection;
  const Icon = KIND_ICON[node.kind];
  const yours =
    node.author === "user"
      ? "You added this"
      : node.pinned.length > 0
        ? `You set its ${node.pinned.join(", ")}`
        : null;

  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={children.length > 0 ? expanded : undefined}
        className={cx(
          "group flex h-7 cursor-default items-center gap-1 pr-1.5 text-[13px]",
          selected ? "bg-accent-soft text-text" : "text-dim hover:bg-hover hover:text-text",
          !node.visible && "opacity-50",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => useEditor.getState().select(id)}
      >
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          className={cx("grid size-4 shrink-0 place-items-center", children.length === 0 && "invisible")}
          onClick={(e) => {
            e.stopPropagation();
            toggle(id);
          }}
        >
          <ChevronRight size={12} className={cx("transition-transform", expanded && "rotate-90")} />
        </button>
        <Icon size={13} className={cx("shrink-0", selected ? "text-accent" : "text-faint")} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {yours && <span title={yours} className="size-1.5 shrink-0 rounded-full bg-user" />}
        <button
          type="button"
          aria-label={node.visible ? "Hide" : "Show"}
          title={node.visible ? "Hide" : "Show"}
          className={cx(
            "grid size-5 shrink-0 place-items-center rounded text-faint hover:text-text",
            node.visible && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            useEditor
              .getState()
              .commit(
                [{ type: "update", id, patch: { visible: !node.visible } }],
                `${node.visible ? "Hide" : "Show"} ${node.name}`,
              );
          }}
        >
          {node.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      </div>
      {expanded &&
        children.map((child) => (
          <OutlinerRow key={child} id={child} depth={depth + 1} open={open} toggle={toggle} />
        ))}
    </>
  );
}

export default function Outliner() {
  const roots = useEditor(useShallow((s) => childIds(s.doc.scene, null)));
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-[11px] font-semibold tracking-wider text-faint uppercase">Scene</h2>
        <span className="font-mono text-[11px] text-faint">{roots.length}</span>
      </header>
      <div role="tree" className="min-h-0 flex-1 overflow-y-auto py-1">
        {roots.length === 0 ? (
          <p className="px-3 py-2 text-xs leading-relaxed text-faint">
            Nothing here yet. Ask the co-pilot for a scene, or add a shape from the toolbar.
          </p>
        ) : (
          roots.map((id) => <OutlinerRow key={id} id={id} depth={0} open={open} toggle={toggle} />)
        )}
      </div>
    </div>
  );
}
