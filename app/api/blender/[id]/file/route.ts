import { readFile } from "node:fs/promises";
import { respond } from "@/blender/http";
import { servedFile } from "@/blender/projects";

/** The web preview (`?name=model.glb`) or a picture Blender made. */
export function GET(request: Request, { params }: RouteContext<"/api/blender/[id]/file">) {
  return respond(request, async () => {
    const name = new URL(request.url).searchParams.get("name") ?? "";
    const file = servedFile((await params).id, name);
    const body = file && (await readFile(file).catch(() => null));
    if (!body) return Response.json({ error: "File not found." }, { status: 404 });
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": name.endsWith(".glb") ? "model/gltf-binary" : name.endsWith(".mp4") ? "video/mp4" : "image/png",
        "Cache-Control": "no-store",
      },
    });
  });
}
