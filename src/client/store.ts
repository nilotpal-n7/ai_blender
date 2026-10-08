/**
 * Editor state. The browser owns the open scene: every change, by hand or by
 * the planner, is a list of ops applied here and recorded as one undoable turn.
 */

import { create } from "zustand";
import type { PlannerConfig } from "@/planner";
import { sampleTrack, trackOf, withKey } from "@/scene/animate";
import { countOps } from "@/scene/describe";
import { OpError, applyOps, childIds, descendantIds, pathTo, uniqueId } from "@/scene/ops";
import {
  ANIMATABLE,
  DEFAULT_CAMERA,
  DEFAULT_CLIP,
  DEFAULT_GRADE,
  DEFAULT_LIGHT,
  DEFAULT_MATERIAL,
  MAX_HISTORY,
  type Animatable,
  type ChatMessage,
  type Light,
  type NodePatch,
  type Op,
  type Primitive,
  type SceneDoc,
  type SceneNode,
  type Turn,
  type Vec3,
} from "@/scene/types";
import { streamPlan } from "./plan";

export type GizmoMode = "translate" | "rotate" | "scale";
export type SaveState = "saved" | "unsaved" | "saving" | "error";
export type PlannerInfo = Pick<PlannerConfig, "kind" | "model">;

/** Edits closer together than this, with the same key, are one undo step. */
const MERGE_WINDOW_MS = 1200;

const uid = () => Math.random().toString(36).slice(2, 10);

interface EditorState {
  doc: SceneDoc;
  planner: PlannerInfo;
  selection: string | null;
  mode: GizmoMode;
  /** True while the planner is editing; hand edits wait until it finishes. */
  generating: boolean;
  /** The reply being streamed, and how many changes it has made so far. */
  live: { text: string; thinking: string; ops: number } | null;
  save: SaveState;
  /** Bumped to ask the viewport to frame the whole scene. */
  frameRequest: number;
  /** Whether the editor's ground grid is drawn. */
  grid: boolean;
  /** The playhead: seconds into the clip. The viewport shows the scene as it is at this moment. */
  time: number;
  playing: boolean;
  /** True while a video is being captured, when the editor's own overlays are hidden. */
  recording: boolean;

  init(doc: SceneDoc, planner: PlannerInfo): void;
  /**
   * Applies a hand edit as one undo step. Pass `key` for edits that overwrite
   * the same properties repeatedly (dragging a slider) so they merge.
   */
  commit(ops: Op[], label: string, key?: string): boolean;
  undo(): void;
  redo(): void;
  select(id: string | null): void;
  /** Viewport click: selects the whole object first, then drills into parts. */
  pick(id: string): void;
  setMode(mode: GizmoMode): void;
  rename(name: string): void;
  addPrimitive(primitive: Primitive): void;
  addLight(type: Light["type"]): void;
  duplicateSelected(): void;
  removeSelected(): void;
  send(prompt: string): Promise<void>;
  stop(): void;
  frameAll(): void;
  toggleGrid(): void;
  setSave(save: SaveState): void;
  /** Moves the playhead, snapped to a frame. */
  setTime(time: number): void;
  togglePlay(): void;
  /**
   * A hand edit of position, rotation or scale. Where the property is animated
   * the edit becomes a key at the playhead; otherwise it changes the node itself.
   */
  transform(id: string, values: Partial<Record<Animatable, Vec3>>, label: string, key?: string): void;
  /** Keys the selected group's position and rotation as they are at the playhead. */
  keySelected(): void;
  /** Removes the selected group's keys at the playhead. */
  unkeySelected(): void;
}

/** How close to a key the playhead has to be to count as being on it, in seconds. */
export const ON_KEY = 1e-3;

let abort: AbortController | null = null;

const EMPTY_DOC: SceneDoc = {
  id: "00000000",
  name: "",
  createdAt: 0,
  updatedAt: 0,
  scene: {
    environment: {
      background: "#000000",
      ambient: 0,
      sun: { azimuth: 0, elevation: 0, intensity: 0, color: "#000000" },
      ground: { visible: false, color: "#000000" },
      fog: null,
      grade: DEFAULT_GRADE,
    },
    nodes: {},
    camera: DEFAULT_CAMERA,
    clip: DEFAULT_CLIP,
  },
  chat: [],
  undo: [],
  redo: [],
};

export const useEditor = create<EditorState>()((set, get) => {
  /** Replaces the document and marks it for autosave. */
  const setDoc = (patch: Partial<SceneDoc>, extra: Partial<EditorState> = {}) =>
    set((state) => ({
      doc: { ...state.doc, ...patch, updatedAt: Date.now() },
      save: "unsaved",
      ...extra,
    }));

  const addNode = (node: SceneNode, label: string) => {
    if (get().commit([{ type: "add", node }], label)) set({ selection: node.id });
  };

  const newNodeBase = (name: string) => {
    const { doc } = get();
    return {
      id: uniqueId(doc.scene, name),
      name,
      parent: null,
      rotation: [0, 0, 0] as [number, number, number],
      visible: true,
      author: "user" as const,
      pinned: [],
    };
  };

  return {
    doc: EMPTY_DOC,
    planner: { kind: "offline", model: "" },
    selection: null,
    mode: "translate",
    generating: false,
    live: null,
    save: "saved",
    frameRequest: 0,
    grid: true,
    time: 0,
    playing: false,
    recording: false,

    init(doc, planner) {
      abort?.abort();
      set({
        doc,
        planner,
        selection: null,
        generating: false,
        live: null,
        save: "saved",
        time: 0,
        playing: false,
        recording: false,
      });
    },

    commit(ops, label, key) {
      const { doc, generating } = get();
      if (generating || ops.length === 0) return false;
      let applied;
      try {
        applied = applyOps(doc.scene, ops, "user");
      } catch (err) {
        if (err instanceof OpError) return false;
        throw err;
      }
      const now = Date.now();
      const last = doc.undo.at(-1);
      const merges =
        key !== undefined &&
        last?.author === "user" &&
        last.key === key &&
        now - last.at < MERGE_WINDOW_MS;
      // A merged step keeps its original inverse, so one undo returns to
      // where the drag started.
      const turn: Turn = merges
        ? { ...last, ops, at: now }
        : { id: uid(), author: "user", label, ops, inverse: applied.inverse, at: now, key };
      const undo = merges ? [...doc.undo.slice(0, -1), turn] : [...doc.undo, turn];
      setDoc({ scene: applied.scene, undo: undo.slice(-MAX_HISTORY), redo: [] });
      return true;
    },

    undo() {
      const { doc, generating, selection } = get();
      const turn = doc.undo.at(-1);
      if (!turn || generating) return;
      const { scene } = applyOps(doc.scene, turn.inverse);
      setDoc(
        { scene, undo: doc.undo.slice(0, -1), redo: [...doc.redo, turn] },
        { selection: selection && selection in scene.nodes ? selection : null },
      );
    },

    redo() {
      const { doc, generating, selection } = get();
      const turn = doc.redo.at(-1);
      if (!turn || generating) return;
      const { scene } = applyOps(doc.scene, turn.ops, turn.author);
      setDoc(
        { scene, undo: [...doc.undo, turn], redo: doc.redo.slice(0, -1) },
        { selection: selection && selection in scene.nodes ? selection : null },
      );
    },

    select: (id) => set({ selection: id }),

    pick(id) {
      const { doc, selection } = get();
      const path = pathTo(doc.scene, id);
      // Clicking inside the current selection goes one level deeper.
      const depth = selection ? path.indexOf(selection) : -1;
      set({ selection: path[Math.min(depth + 1, path.length - 1)] });
    },

    setMode: (mode) => set({ mode }),

    rename(name) {
      const trimmed = name.trim().slice(0, 120);
      if (trimmed && trimmed !== get().doc.name) setDoc({ name: trimmed });
    },

    addPrimitive(primitive) {
      const flat = primitive === "plane";
      const height = primitive === "torus" ? 0.25 : 1;
      addNode(
        {
          ...newNodeBase(primitive),
          name: primitive.charAt(0).toUpperCase() + primitive.slice(1),
          position: [0, flat ? 0.01 : height / 2, 0],
          scale: flat ? [2, 1, 2] : [1, 1, 1],
          kind: "mesh",
          primitive,
          material: { ...DEFAULT_MATERIAL },
          bevel: 0,
          array: null,
          taper: [1, 1],
        },
        `Add ${primitive}`,
      );
    },

    addLight(type) {
      addNode(
        {
          ...newNodeBase(`${type}_light`),
          name: type === "spot" ? "Spot light" : "Point light",
          position: [0, 3, 0],
          scale: [1, 1, 1],
          kind: "light",
          light: { ...DEFAULT_LIGHT, type, intensity: type === "spot" ? 80 : DEFAULT_LIGHT.intensity },
        },
        `Add ${type} light`,
      );
    },

    duplicateSelected() {
      const { doc, selection } = get();
      const source = selection && doc.scene.nodes[selection];
      if (!source) return;
      // Copy the whole subtree, giving every node a fresh id.
      const ids = [source.id, ...descendantIds(doc.scene, source.id)];
      const taken = new Set<string>();
      const renamed = new Map<string, string>();
      for (const id of ids) {
        const copy = uniqueId(doc.scene, id.replace(/_\d+$/, ""), taken);
        taken.add(copy);
        renamed.set(id, copy);
      }
      const ops = ids.map((id): Op => {
        const node = doc.scene.nodes[id];
        const isRoot = id === source.id;
        return {
          type: "add",
          node: {
            ...node,
            id: renamed.get(id)!,
            parent: isRoot ? node.parent : renamed.get(node.parent!)!,
            position: isRoot
              ? [node.position[0] + 1, node.position[1], node.position[2] + 1]
              : node.position,
            author: "user",
            pinned: [],
          },
        };
      });
      if (get().commit(ops, `Duplicate ${source.name}`)) {
        set({ selection: renamed.get(source.id)! });
      }
    },

    removeSelected() {
      const { doc, selection } = get();
      const node = selection && doc.scene.nodes[selection];
      if (!node) return;
      if (get().commit([{ type: "remove", id: node.id }], `Delete ${node.name}`)) {
        set({ selection: null });
      }
    },

    async send(prompt) {
      const text = prompt.trim();
      const start = get();
      if (!text || start.generating) return;

      const controller = new AbortController();
      abort = controller;
      const wasEmpty = childIds(start.doc.scene, null).length === 0;
      const question: ChatMessage = { id: uid(), role: "user", text, at: Date.now() };
      setDoc(
        { chat: [...start.doc.chat, question] },
        { generating: true, live: { text: "", thinking: "", ops: 0 } },
      );

      const ops: Op[] = [];
      let inverse: Op[] = [];
      let planner = start.planner.kind === "claude" ? start.planner.model : start.planner.kind;
      let error: string | undefined;
      try {
        const input = {
          scene: start.doc.scene,
          prompt: text,
          chat: start.doc.chat.map(({ role, text }) => ({ role, text })),
          selection: start.selection ? [start.selection] : [],
        };
        for await (const event of streamPlan(input, controller.signal)) {
          if (event.type === "ops") {
            const applied = applyOps(get().doc.scene, event.ops, "ai");
            ops.push(...event.ops);
            inverse = [...applied.inverse, ...inverse];
            set((state) => ({
              doc: { ...state.doc, scene: applied.scene },
              live: state.live && { ...state.live, ops: ops.length },
            }));
          } else if (event.type === "text" || event.type === "thinking") {
            const field = event.type;
            set(({ live }) =>
              live ? { live: { ...live, [field]: live[field] + event.delta } } : {},
            );
          } else if (event.type === "done") {
            planner = event.planner;
          } else {
            error = event.message;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          error = err instanceof Error ? err.message : "The planner request failed.";
        }
      }

      // Whatever arrived before a stop or an error is kept, as one undo step.
      const { doc, live, selection } = get();
      const stopped = controller.signal.aborted;
      const reply: ChatMessage = {
        id: uid(),
        role: "assistant",
        text: live?.text.trim() || (stopped ? "Stopped." : ""),
        at: Date.now(),
        stats: countOps(ops),
        planner,
        error,
      };
      const turn: Turn = { id: uid(), author: "ai", label: text, ops, inverse, at: Date.now() };
      setDoc(
        {
          chat: [...doc.chat, reply],
          ...(ops.length > 0 && { undo: [...doc.undo, turn].slice(-MAX_HISTORY), redo: [] }),
        },
        {
          generating: false,
          live: null,
          selection: selection && selection in doc.scene.nodes ? selection : null,
        },
      );
      if (wasEmpty && ops.length > 0) get().frameAll();
    },

    stop: () => abort?.abort(),
    frameAll: () => set((state) => ({ frameRequest: state.frameRequest + 1 })),
    toggleGrid: () => set((state) => ({ grid: !state.grid })),
    setSave: (save) => set({ save }),

    setTime(time) {
      const { duration, fps } = get().doc.scene.clip;
      const frame = Math.round(Math.min(Math.max(time, 0), duration) * fps);
      set({ time: Math.min(frame / fps, duration) });
    },

    togglePlay() {
      const { playing, time, doc } = get();
      // Playing from the very end starts over.
      const atEnd = !doc.scene.clip.loop && time >= doc.scene.clip.duration - ON_KEY;
      set({ playing: !playing, ...(!playing && atEnd && { time: 0 }) });
    },

    transform(id, values, label, key) {
      const { doc, time } = get();
      const patch: NodePatch = {};
      const ops: Op[] = [];
      for (const property of ANIMATABLE) {
        const value = values[property];
        if (!value) continue;
        const track = trackOf(doc.scene, id, property);
        if (track) ops.push({ type: "animate", id, property, keys: withKey(track.keys, time, value) });
        else patch[property] = value;
      }
      if (Object.keys(patch).length > 0) ops.unshift({ type: "update", id, patch });
      get().commit(ops, label, key);
    },

    keySelected() {
      const { doc, selection, time } = get();
      const node = selection && doc.scene.nodes[selection];
      if (!node || node.kind !== "group") return;
      const ops: Op[] = [];
      for (const property of ANIMATABLE) {
        const track = trackOf(doc.scene, node.id, property);
        // Scale is only keyed once it has been animated; most motion never needs it.
        if (!track && property === "scale") continue;
        const value = track ? sampleTrack(track.keys, time) : node[property];
        ops.push({ type: "animate", id: node.id, property, keys: withKey(track?.keys ?? [], time, value) });
      }
      get().commit(ops, `Key ${node.name}`);
    },

    unkeySelected() {
      const { doc, selection, time } = get();
      const node = selection && doc.scene.nodes[selection];
      if (!node) return;
      const ops = doc.scene.clip.tracks
        .filter((track) => track.node === node.id && track.keys.some((k) => Math.abs(k.t - time) < ON_KEY))
        .map((track): Op => ({
          type: "animate",
          id: node.id,
          property: track.property,
          keys: track.keys.filter((k) => Math.abs(k.t - time) >= ON_KEY),
        }));
      get().commit(ops, `Remove key from ${node.name}`);
    },
  };
});
