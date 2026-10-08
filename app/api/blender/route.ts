import { respond } from "@/blender/http";
import { createProject, listProjects } from "@/blender/projects";

export function GET(request: Request) {
  return respond(request, async () => Response.json({ projects: await listProjects() }));
}

export function POST(request: Request) {
  return respond(request, async () => Response.json(await createProject(), { status: 201 }));
}
