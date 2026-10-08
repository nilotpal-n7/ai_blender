import { createDoc, listDocs } from "@/server/store";

export async function GET() {
  return Response.json({ scenes: await listDocs() });
}

export async function POST() {
  return Response.json(await createDoc(), { status: 201 });
}
