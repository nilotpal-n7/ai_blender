import { respond } from "@/blender/http";
import { removeProject, studioState, waitForChange } from "@/blender/hub";

type Context = RouteContext<"/api/blender/[id]">;

/**
 * The project as the page and Blender's sidebar show it. With `?after=<rev>`
 * the answer waits until something has changed since that revision.
 */
export function GET(request: Request, { params }: Context) {
  return respond(request, async () => {
    const { id } = await params;
    // Before waiting, so a project that doesn't exist is a 404 right away.
    await studioState(id);
    const after = Number(new URL(request.url).searchParams.get("after"));
    if (Number.isFinite(after) && after > 0) await waitForChange(id, after, request.signal);
    return Response.json(await studioState(id));
  });
}

export function DELETE(request: Request, { params }: Context) {
  return respond(request, async () => {
    await removeProject((await params).id);
    return Response.json({ ok: true });
  });
}
