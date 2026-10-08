import { redirect } from "next/navigation";
import { defaultSceneId } from "@/server/store";

// Reads the scene folder on every request.
export const dynamic = "force-dynamic";

/** Opens the most recently edited scene, creating the first one if there are none. */
export default async function Home() {
  redirect(`/s/${await defaultSceneId()}`);
}
