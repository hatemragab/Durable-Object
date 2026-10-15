import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export * from "./smoke-support.mjs";
async function runSmoke(cloud) {
  const { runRoomSyncSmoke } = await import("./room-sync-smoke.mjs");
  return runRoomSyncSmoke(cloud);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--cloud")) {
    console.error("Usage: node testing/local-smoke.mjs [--cloud]");
    process.exitCode = 1;
  } else {
    try {
      await runSmoke(args.includes("--cloud"));
    } catch {
      console.error(
        "The bounded integration smoke failed. No tokens, tickets or submitted content are printed.",
      );
      process.exitCode = 1;
    }
  }
}
