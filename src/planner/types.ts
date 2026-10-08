import type { Op, Scene } from "@/scene/types";

export interface PlanInput {
  /** The scene as the user currently sees it, hand edits included. */
  scene: Scene;
  prompt: string;
  /** Earlier turns of the conversation, oldest first. */
  chat: { role: "user" | "assistant"; text: string }[];
  /** Ids the user has selected, for "this" and "it". */
  selection: string[];
}

export interface PlanUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What a planner streams back while it works. */
export type PlanEvent =
  /** Ops that are already validated; the client applies them as they arrive. */
  | { type: "ops"; ops: Op[] }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "done"; planner: string; usage?: PlanUsage }
  | { type: "error"; message: string };

export type Emit = (event: PlanEvent) => void;

export interface Planner {
  /** Shown in the UI, e.g. "claude-opus-5-5" or "offline". */
  name: string;
  /** Streams ops and text through `emit`. Throws to report a failure. */
  run(input: PlanInput, emit: Emit, signal: AbortSignal): Promise<PlanUsage | void>;
}

/** A failure whose message is safe and useful to show to the user as-is. */
export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerError";
  }
}
