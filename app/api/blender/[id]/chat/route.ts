import { z } from "zod";
import { originOf, respond } from "@/blender/http";
import { startTurn } from "@/blender/hub";

const Prompt = z.object({
  text: z.string().trim().min(1).max(4000),
  from: z.enum(["web", "blender"]).default("web"),
});

/** A prompt, typed on the web page or in Blender. The answer arrives through the project's state. */
export function POST(request: Request, { params }: RouteContext<"/api/blender/[id]/chat">) {
  return respond(request, async () => {
    const parsed = Prompt.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Type what to build first." }, { status: 400 });
    await startTurn((await params).id, parsed.data.text, parsed.data.from, originOf(request));
    return Response.json({ ok: true }, { status: 202 });
  });
}
