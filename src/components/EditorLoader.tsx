"use client";

import dynamic from "next/dynamic";
import type { PlannerInfo } from "@/client/store";
import type { SceneDoc } from "@/scene/types";

// The editor is WebGL plus browser-only state, so it never renders on the server.
const Editor = dynamic(() => import("./Editor"), {
  ssr: false,
  loading: () => (
    <div className="grid h-dvh place-items-center bg-bg font-mono text-xs text-faint">
      Loading editor…
    </div>
  ),
});

export default function EditorLoader(props: { doc: SceneDoc; planner: PlannerInfo }) {
  // Keyed by scene so switching scenes starts from a clean editor.
  return <Editor key={props.doc.id} {...props} />;
}
