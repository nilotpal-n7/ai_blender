import path from "node:path";

/** Where local data lives: saved scenes and bridge traffic. */
export function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), ".data");
}
