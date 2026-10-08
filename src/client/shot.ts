/**
 * The shot: the camera a video is taken from, and recording one from the viewport.
 */

import { roundVec } from "@/scene/math";
import { stage } from "@/three/stage";
import { useEditor } from "./store";

/** Saves `data` to the user's downloads under `filename`. */
export function download(filename: string, data: Blob | string) {
  const blob = typeof data === "string" ? new Blob([data], { type: "text/plain" }) : data;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const fileBase = (name: string) =>
  name.trim().replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "scene";

/** Moves the viewport to look through the scene's camera. */
export function lookThroughCamera() {
  const { camera, controls } = stage;
  if (!camera || !controls) return;
  const shot = useEditor.getState().doc.scene.camera;
  camera.position.fromArray(shot.position);
  camera.fov = shot.fov;
  camera.updateProjectionMatrix();
  controls.target.fromArray(shot.target);
  controls.update();
}

/** Makes the current view the scene's camera. */
export function setCameraFromView() {
  const { camera, controls } = stage;
  if (!camera || !controls) return;
  useEditor.getState().commit(
    [
      {
        type: "camera",
        patch: {
          position: roundVec(camera.position.toArray(), 3),
          target: roundVec(controls.target.toArray(), 3),
          fov: Math.round(camera.fov),
        },
      },
    ],
    "Set camera",
  );
}

const nextFrames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });

export const canRecord = () =>
  typeof MediaRecorder !== "undefined" &&
  typeof HTMLCanvasElement !== "undefined" &&
  typeof HTMLCanvasElement.prototype.captureStream === "function";

/**
 * Plays the clip once through the scene's camera and captures it as a WebM
 * video. Resolves with null if the browser can't record or the take was cut short.
 */
export async function recordClip(): Promise<Blob | null> {
  const { canvas } = stage;
  if (!canvas || !canRecord() || useEditor.getState().recording) return null;
  const { fps } = useEditor.getState().doc.scene.clip;
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  if (!type) return null;

  lookThroughCamera();
  useEditor.setState({ selection: null, recording: true, playing: false, time: 0 });
  // Give the overlays a moment to go and the first pose to be drawn.
  await nextFrames(3);

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 16_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();
  useEditor.setState({ playing: true });
  // Playback stops by itself at the end of the clip while recording.
  await new Promise<void>((resolve) => {
    const unsubscribe = useEditor.subscribe((state) => {
      if (state.playing) return;
      unsubscribe();
      resolve();
    });
  });
  const { time, doc } = useEditor.getState();
  const finished = time >= doc.scene.clip.duration - 1e-3;
  await nextFrames(2);
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  useEditor.setState({ recording: false, time: 0 });
  return finished ? new Blob(chunks, { type: "video/webm" }) : null;
}
