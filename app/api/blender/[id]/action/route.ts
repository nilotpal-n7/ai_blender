import { z } from "zod";
import { originOf, respond } from "@/blender/http";
import { openInBlender, renderStill, stopTurn } from "@/blender/hub";

const Action = z.object({ do: z.enum(["open", "render", "stop"]) });

/** Things to do with a project besides talking: open it in Blender, render it, stop the co-pilot. */
export function POST(request: Request, { params }: RouteContext<"/api/blender/[id]/action">) {
  return respond(request, async () => {
    const parsed = Action.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Unknown action." }, { status: 400 });
    const { id } = await params;
    if (parsed.data.do === "open") await openInBlender(id, originOf(request));
    else if (parsed.data.do === "render") await renderStill(id, originOf(request));
    else stopTurn(id);
    return Response.json({ ok: true });
  });
}
