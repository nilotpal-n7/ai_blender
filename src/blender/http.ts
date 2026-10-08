import { StudioError } from "./types";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The studio's routes lead to code running in Blender, so they only answer
 * this computer: the address must be a local one (which also defeats DNS
 * rebinding), and a browser request must come from the app's own pages.
 */
export function refuseOutsiders(request: Request): Response | null {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const name = host.replace(/:\d+$/, "");
  const origin = request.headers.get("origin");
  const ownPage = !origin || origin.replace(/^https?:\/\//, "").toLowerCase() === host;
  if ((LOCAL.has(name) || name.endsWith(".localhost")) && ownPage) return null;
  return Response.json(
    { error: "The Blender studio only answers requests from this computer." },
    { status: 403 },
  );
}

/** Runs a route's work and turns a StudioError into its response. */
export async function respond(request: Request, work: () => Promise<Response>): Promise<Response> {
  const refused = refuseOutsiders(request);
  if (refused) return refused;
  try {
    return await work();
  } catch (err) {
    if (err instanceof StudioError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

export const originOf = (request: Request) => new URL(request.url).origin;
