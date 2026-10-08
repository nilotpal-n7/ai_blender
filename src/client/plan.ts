import type { PlanEvent, PlanInput } from "@/planner/types";

/** Calls the planner and yields its events as the server streams them. */
export async function* streamPlan(input: PlanInput, signal: AbortSignal): AsyncGenerator<PlanEvent> {
  const response = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The planner request failed (${response.status}).`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    // Server-sent events: frames end with a blank line, payload on `data:` lines.
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as PlanEvent;
      }
    }
  }
}
