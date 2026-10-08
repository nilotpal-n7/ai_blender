"use client";

import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/client/store";
import type { ChatMessage, ChatStats } from "@/scene/types";
import { cx } from "./ui";

const OPEN_ENDED = [
  "A cozy campsite at night: a tent, a campfire and a ring of pine trees",
  "A tiny desert town with a water tower and a dusty main street",
  "A low-poly desk setup with a monitor, a lamp and a potted plant",
];

const SUGGESTIONS = {
  claude: OPEN_ENDED,
  bridge: OPEN_ENDED,
  offline: [
    "A red cube on a wooden table with a spotlight",
    "A house with three trees and two rocks at sunset",
    "A snowman next to a lamp at night",
  ],
};

function Stats({ stats }: { stats: ChatStats }) {
  const parts = [
    stats.added > 0 && `${stats.added} added`,
    stats.updated > 0 && `${stats.updated} changed`,
    stats.removed > 0 && `${stats.removed} removed`,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="font-mono text-[11px] text-faint">{parts.join(" · ")}</span>;
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="ml-6 self-end rounded-xl rounded-br-sm bg-raised px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
        {message.text}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {message.text && (
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text">{message.text}</p>
      )}
      {message.error && (
        <p role="alert" className="rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-xs leading-relaxed text-err">
          {message.error}
        </p>
      )}
      {message.stats && <Stats stats={message.stats} />}
    </div>
  );
}

function Live() {
  const live = useEditor((s) => s.live);
  if (!live) return null;
  // Show the tail of the model's reasoning while nothing else has arrived yet.
  const thinking = live.thinking.trim().slice(-220);
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      {live.text ? (
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text">{live.text}</p>
      ) : (
        thinking && <p className="line-clamp-3 text-xs leading-relaxed text-faint italic">…{thinking}</p>
      )}
      <span className="flex items-center gap-2 font-mono text-[11px] text-dim">
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
        {live.ops > 0 ? `Building · ${live.ops} changes so far` : "Planning"}
      </span>
    </div>
  );
}

export default function ChatPanel() {
  const chat = useEditor((s) => s.doc.chat);
  const generating = useEditor((s) => s.generating);
  const planner = useEditor((s) => s.planner);
  const liveLength = useEditor((s) => (s.live ? s.live.text.length + s.live.ops : 0));
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const source = {
    claude: { label: planner.model, dot: "bg-ok", title: `Scenes are planned by ${planner.model}` },
    bridge: {
      label: "claude code session",
      dot: "bg-accent",
      title: "Prompts are answered by the Claude Code session working in this project",
    },
    offline: {
      label: "offline planner",
      dot: "bg-warn",
      title: "No Anthropic credentials found, so a small built-in planner is used",
    },
  }[planner.kind];

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat.length, liveLength]);

  const send = (text: string) => {
    if (!text.trim() || generating) return;
    setDraft("");
    void useEditor.getState().send(text);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-[11px] font-semibold tracking-wider text-faint uppercase">Co-pilot</h2>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-faint" title={source.title}>
          <span className={cx("size-1.5 rounded-full", source.dot)} />
          {source.label}
        </span>
      </header>

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {planner.kind === "bridge" && chat.length === 0 && (
          <p className="rounded-lg border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-dim">
            Prompts are answered by the Claude Code session working in this project, so it has to be
            open and listening. Replies take a little longer than an API would.
          </p>
        )}
        {planner.kind === "offline" && (
          <p className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            Running without an API key, so prompts go to a small built-in planner that knows a few
            objects. Add <code className="font-mono">ANTHROPIC_API_KEY</code> to{" "}
            <code className="font-mono">.env.local</code> and restart to describe anything.
          </p>
        )}
        {chat.length === 0 && !generating && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] leading-relaxed text-dim">
              Describe a scene and watch it get built. Then move things by hand and ask for changes;
              your edits are kept.
            </p>
            {SUGGESTIONS[planner.kind].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => send(suggestion)}
                className="rounded-lg border border-line px-3 py-2 text-left text-xs leading-relaxed text-dim transition-colors hover:border-accent/60 hover:text-text"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {chat.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        <Live />
      </div>

      <form
        className="shrink-0 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-bg p-2 transition-colors focus-within:border-accent">
          <textarea
            aria-label="Describe a scene or a change"
            placeholder={chat.length === 0 ? "Describe a scene…" : "Ask for a change…"}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(draft);
              }
            }}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-faint"
          />
          {generating ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={() => useEditor.getState().stop()}
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-text hover:bg-hover"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!draft.trim()}
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-white transition-opacity disabled:opacity-30"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
