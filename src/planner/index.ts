import { createBridgePlanner } from "./bridge";
import { claudeMessagesApi, createClaudePlanner, type Effort } from "./claude";
import { createOfflinePlanner } from "./offline";
import type { Planner } from "./types";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface PlannerConfig {
  /**
   * - `claude`: the Anthropic API.
   * - `bridge`: a Claude Code session answers, through files (see bridge.ts).
   * - `offline`: the built-in keyword planner.
   */
  kind: "claude" | "bridge" | "offline";
  /** Model id when `kind` is "claude". */
  model: string;
  effort: Effort;
}

/**
 * `PLANNER=claude|bridge|offline` picks a planner outright. Without it, Claude
 * is used when credentials are present and the offline planner otherwise.
 */
export function plannerConfig(env: NodeJS.ProcessEnv = process.env): PlannerConfig {
  const hasCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const chosen = (["claude", "bridge", "offline"] as const).find((k) => k === env.PLANNER);
  const kind = chosen ?? (hasCredentials ? "claude" : "offline");
  const effort = EFFORTS.find((e) => e === env.PLANNER_EFFORT) ?? "medium";
  return { kind, model: env.PLANNER_MODEL || "claude-opus-5-5", effort };
}

export function createPlanner(config: PlannerConfig = plannerConfig()): Planner {
  switch (config.kind) {
    case "claude":
      return createClaudePlanner(claudeMessagesApi(), config);
    case "bridge":
      return createBridgePlanner();
    case "offline":
      return createOfflinePlanner();
  }
}
