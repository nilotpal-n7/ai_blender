import { toBlenderScript } from "@/export/blender";
import { toUsda } from "@/export/usda";
import { loadDoc } from "@/server/store";

type Context = RouteContext<"/api/scenes/[id]/export">;

const FORMATS = {
  blender: { extension: "py", type: "text/x-python", build: toBlenderScript },
  usd: { extension: "usda", type: "text/plain", build: toUsda },
} as const;

/**
 * The saved scene as a file, for rendering from a script or a pipeline:
 * `?format=blender` (the default) or `?format=usd`. glTF is built in the
 * browser, from the Export menu.
 */
export async function GET(request: Request, { params }: Context) {
  const doc = await loadDoc((await params).id);
  if (!doc) return Response.json({ error: "Scene not found." }, { status: 404 });

  const wanted = new URL(request.url).searchParams.get("format") ?? "blender";
  if (!(wanted in FORMATS)) {
    return Response.json({ error: 'Unknown format. Use "blender" or "usd".' }, { status: 400 });
  }
  const format = FORMATS[wanted as keyof typeof FORMATS];
  const file = `${doc.name.trim().replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "scene"}.${format.extension}`;
  return new Response(format.build(doc.scene, doc.name), {
    headers: {
      "Content-Type": `${format.type}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${file}"`,
    },
  });
}
