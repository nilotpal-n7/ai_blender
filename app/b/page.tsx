import { redirect } from "next/navigation";
import { createProject, listProjects } from "@/blender/projects";

// Reads the project folder on every request.
export const dynamic = "force-dynamic";

/** Opens the most recently changed Blender project, creating the first one if there are none. */
export default async function BlenderHome() {
  const [latest] = await listProjects();
  redirect(`/b/${latest?.id ?? (await createProject()).id}`);
}
