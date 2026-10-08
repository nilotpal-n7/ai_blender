import { z } from "zod";
import { createPlanner } from "@/planner";
import { PlannerError, type Emit, type PlanEvent } from "@/planner/types";
import { findSceneProblem } from "@/scene/ops";
import { IdSchema, SceneSchema } from "@/scene/types";

const PlanRequest = z.object({
  scene: SceneSchema,
  prompt: z.string().trim().min(1).max(4000),
  chat: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) }))
    .max(100),
  selection: z.array(IdSchema).max(100),
});

/**
 * Runs the planner on a scene and streams what it does as server-sent events
 * (one `PlanEvent` per `data:` line). Stateless: the request carries the scene.
 */
export async function POST(request: Request) {
  const parsed = PlanRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid plan request." }, { status: 400 });
  }
  const problem = findSceneProblem(parsed.data.scene);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const planner = createPlanner();
  const encoder = new TextEncoder();
  let open = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (event: PlanEvent) => {
        if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        const usage = await planner.run(parsed.data, emit, request.signal);
        emit({ type: "done", planner: planner.name, usage: usage ?? undefined });
      } catch (err) {
        if (request.signal.aborted) return;
        if (!(err instanceof PlannerError)) console.error("Planner failed:", err);
        emit({
          type: "error",
          message: err instanceof PlannerError ? err.message : "The planner failed unexpectedly.",
        });
      } finally {
        if (open) controller.close();
      }
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
