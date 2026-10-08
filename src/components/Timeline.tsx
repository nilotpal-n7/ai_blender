"use client";

import { Camera, Diamond, Pause, Play, Repeat, SkipBack, Video, Videotape } from "lucide-react";
import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { canRecord, download, fileBase, lookThroughCamera, recordClip, setCameraFromView } from "@/client/shot";
import { ON_KEY, useEditor } from "@/client/store";
import { IconButton, NumberField, cx } from "./ui";

/** The playhead's track: click or drag to scrub. Diamonds mark the keys. */
function Scrubber() {
  const time = useEditor((s) => s.time);
  const duration = useEditor((s) => s.doc.scene.clip.duration);
  // Keys of the selected object, or of everything when nothing is selected.
  const keyTimes = useEditor(
    useShallow((s) => {
      const tracks = s.doc.scene.clip.tracks.filter((t) => !s.selection || t.node === s.selection);
      return [...new Set(tracks.flatMap((t) => t.keys.map((k) => k.t)))].sort((a, b) => a - b);
    }),
  );
  const bar = useRef<HTMLDivElement>(null);

  const seek = (event: React.PointerEvent) => {
    const box = bar.current!.getBoundingClientRect();
    const fraction = (event.clientX - box.left) / box.width;
    useEditor.getState().setTime(Math.min(Math.max(fraction, 0), 1) * duration);
  };

  return (
    <div
      ref={bar}
      role="slider"
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={time}
      tabIndex={0}
      className="relative h-6 min-w-24 flex-1 cursor-pointer touch-none rounded-md border border-line bg-bg"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        useEditor.setState({ playing: false });
        seek(event);
      }}
      onPointerMove={(event) => event.buttons === 1 && seek(event)}
      onKeyDown={(event) => {
        const { setTime, doc } = useEditor.getState();
        const frame = 1 / doc.scene.clip.fps;
        if (event.key === "ArrowLeft") setTime(time - frame);
        else if (event.key === "ArrowRight") setTime(time + frame);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {keyTimes.map((t) => (
        <span
          key={t}
          className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-user"
          style={{ left: `${(t / duration) * 100}%` }}
        />
      ))}
      <span
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent"
        style={{ left: `${(time / duration) * 100}%` }}
      />
    </div>
  );
}

export default function Timeline() {
  const playing = useEditor((s) => s.playing);
  const recording = useEditor((s) => s.recording);
  const locked = useEditor((s) => s.generating);
  const time = useEditor((s) => s.time);
  const clip = useEditor(useShallow((s) => ({ duration: s.doc.scene.clip.duration, loop: s.doc.scene.clip.loop })));
  const animated = useEditor((s) => s.doc.scene.clip.tracks.length > 0);
  const group = useEditor((s) => (s.selection ? s.doc.scene.nodes[s.selection]?.kind === "group" : false));
  const onKey = useEditor((s) =>
    s.doc.scene.clip.tracks.some(
      (t) => t.node === s.selection && t.keys.some((k) => Math.abs(k.t - s.time) < ON_KEY),
    ),
  );
  const { togglePlay, setTime, keySelected, unkeySelected, commit } = useEditor.getState();

  const record = async () => {
    const video = await recordClip();
    if (video) download(`${fileBase(useEditor.getState().doc.name)}.webm`, video);
  };

  return (
    <div className="flex h-10 min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line bg-panel px-2">
      <IconButton label="Back to the start" onClick={() => setTime(0)}>
        <SkipBack size={14} />
      </IconButton>
      <IconButton label={playing ? "Pause (Space)" : "Play (Space)"} active={playing} onClick={togglePlay}>
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </IconButton>
      <span className="w-[86px] shrink-0 text-center font-mono text-[11px] text-dim tabular-nums">
        {time.toFixed(2)} / {clip.duration.toFixed(2)}s
      </span>

      <Scrubber />

      <IconButton
        label={
          onKey
            ? "Remove the key here"
            : group
              ? "Key this pose here (K)"
              : "Select a group to key its pose: only groups move"
        }
        disabled={!group || locked || recording}
        active={onKey}
        onClick={onKey ? unkeySelected : keySelected}
      >
        <Diamond size={13} />
      </IconButton>
      <div className="mx-0.5 h-5 w-px bg-line" />
      <div className="w-14 shrink-0">
        <NumberField
          label="Clip length in seconds"
          value={clip.duration}
          min={0.5}
          max={120}
          step={0.5}
          disabled={locked || recording}
          onChange={(duration) => {
            if (commit([{ type: "clip", patch: { duration } }], "Clip length", "clip:duration")) {
              setTime(Math.min(useEditor.getState().time, duration));
            }
          }}
        />
      </div>
      <IconButton
        label={clip.loop ? "Looping: click to play once" : "Plays once: click to loop"}
        active={clip.loop}
        disabled={locked || recording}
        onClick={() => commit([{ type: "clip", patch: { loop: !clip.loop } }], "Loop")}
      >
        <Repeat size={14} />
      </IconButton>
      <div className="mx-0.5 h-5 w-px bg-line" />
      <IconButton label="Look through the camera" onClick={lookThroughCamera}>
        <Camera size={14} />
      </IconButton>
      <IconButton label="Use this view as the camera" disabled={locked || recording} onClick={setCameraFromView}>
        <Videotape size={14} />
      </IconButton>
      <button
        type="button"
        title={
          canRecord()
            ? "Record the clip through the camera as a video"
            : "This browser can't record the viewport"
        }
        disabled={!animated || recording || locked || !canRecord()}
        onClick={() => void record()}
        className={cx(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
          "disabled:pointer-events-none disabled:opacity-35",
          recording ? "bg-err text-white" : "text-dim hover:bg-hover hover:text-text",
        )}
      >
        <Video size={14} /> {recording ? "Recording" : "Record"}
      </button>
    </div>
  );
}
