import { respond } from "@/blender/http";
import { engineSync } from "@/blender/hub";
import { EngineSyncSchema } from "@/blender/types";

/**
 * Where a Blender running `blender/engine.py` asks for work. The request is
 * held open until there is a job, so the engine simply asks again and again.
 */
export function POST(request: Request) {
  return respond(request, async () => {
    const parsed = EngineSyncSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Not an engine request." }, { status: 400 });
    return Response.json(await engineSync(parsed.data, request.signal));
  });
}
