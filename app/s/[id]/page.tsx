import type { Metadata } from "next";
import { notFound } from "next/navigation";
import EditorLoader from "@/components/EditorLoader";
import { plannerConfig } from "@/planner";
import { loadDoc } from "@/server/store";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/s/[id]">): Promise<Metadata> {
  const doc = await loadDoc((await params).id);
  return { title: doc ? `${doc.name} · AI Blender` : "AI Blender" };
}

export default async function ScenePage({ params }: PageProps<"/s/[id]">) {
  const doc = await loadDoc((await params).id);
  if (!doc) notFound();
  const { kind, model } = plannerConfig();
  return <EditorLoader doc={doc} planner={{ kind, model }} />;
}
