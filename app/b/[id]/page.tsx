import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadProject } from "@/blender/projects";
import StudioLoader from "@/components/StudioLoader";
import { plannerConfig } from "@/planner";

export const dynamic = "force-dynamic";

const find = (id: string) => loadProject(id).catch(() => null);

export async function generateMetadata({ params }: PageProps<"/b/[id]">): Promise<Metadata> {
  const project = await find((await params).id);
  return { title: project ? `${project.name} · AI Blender` : "AI Blender" };
}

export default async function BlenderProjectPage({ params }: PageProps<"/b/[id]">) {
  const project = await find((await params).id);
  if (!project) notFound();
  const { kind, model } = plannerConfig();
  return <StudioLoader id={project.id} planner={{ kind, model }} />;
}
