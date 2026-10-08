import { InvalidDocError, deleteDoc, loadDoc, parseDoc, saveDoc } from "@/server/store";

type Context = RouteContext<"/api/scenes/[id]">;

const notFound = () => Response.json({ error: "Scene not found." }, { status: 404 });

export async function GET(_request: Request, { params }: Context) {
  const doc = await loadDoc((await params).id);
  return doc ? Response.json(doc) : notFound();
}

/** Autosave: replaces the stored document with the one the editor holds. */
export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;
  try {
    const doc = parseDoc(await request.json());
    if (doc.id !== id) {
      return Response.json({ error: "Document id does not match the URL." }, { status: 400 });
    }
    await saveDoc({ ...doc, updatedAt: Date.now() });
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidDocError || err instanceof SyntaxError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  return (await deleteDoc((await params).id)) ? Response.json({ ok: true }) : notFound();
}
