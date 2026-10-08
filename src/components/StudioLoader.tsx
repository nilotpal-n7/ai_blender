"use client";

import dynamic from "next/dynamic";
import type { PlannerInfo } from "@/client/store";

// The studio is WebGL plus live state from Blender, so it never renders on the server.
const Studio = dynamic(() => import("./Studio"), {
  ssr: false,
  loading: () => (
    <div className="grid h-dvh place-items-center bg-bg font-mono text-xs text-faint">
      Loading studio…
    </div>
  ),
});

export default function StudioLoader(props: { id: string; planner: PlannerInfo }) {
  // Keyed by project so switching projects starts from a clean page.
  return <Studio key={props.id} {...props} />;
}
