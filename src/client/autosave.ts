import type { SceneDoc } from "@/scene/types";
import { useEditor } from "./store";

const DEBOUNCE_MS = 700;

let timer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<void> = Promise.resolve();
let queued: SceneDoc | null = null;

async function put(doc: SceneDoc, keepalive: boolean): Promise<void> {
  if (useEditor.getState().doc === doc) useEditor.getState().setSave("saving");
  const saved = await fetch(`/api/scenes/${doc.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
    keepalive,
  }).then(
    (response) => response.ok,
    () => false,
  );

  const editor = useEditor.getState();
  // The editor may have moved on to another scene while this was in flight.
  if (editor.doc.id !== doc.id) return;
  if (!saved) editor.setSave("error");
  else if (editor.doc === doc) editor.setSave("saved");
  else schedule(); // edited again in the meantime
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void flushSave(), DEBOUNCE_MS);
}

/**
 * Saves the open scene now if it has unsaved changes. The document is captured
 * when this is called, so it is safe to call just before switching scenes.
 */
export function flushSave(keepalive = false): Promise<void> {
  clearTimeout(timer);
  const { doc, save } = useEditor.getState();
  if (save !== "saved" && doc !== queued) {
    queued = doc;
    queue = queue.then(() => put(doc, keepalive));
  }
  return queue;
}

/** Saves the open scene shortly after each change. Returns a function that stops it. */
export function startAutosave(): () => void {
  const unsubscribe = useEditor.subscribe((state, prev) => {
    // The planner changes the scene many times a second; save once it is done.
    if (state.doc !== prev.doc && state.save === "unsaved" && !state.generating) schedule();
  });
  const onHide = () => {
    if (document.visibilityState === "hidden") void flushSave(true);
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onHide);
    clearTimeout(timer);
  };
}
