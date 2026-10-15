import { parse } from "dotenv";
import { DEFAULTS } from "@chat-poc/contracts";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";
import { readConfig, runtimeEnvironment } from "./config/config.js";

try {
  let source = "";
  try {
    source = await readFile(".env", "utf8");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const config = readConfig(runtimeEnvironment(parse(source), process.env));
  const app = await createApp(config);
  await app.listen(config.port, config.host);
  console.info(
    `Development API ready on ${config.host}:${config.port}; protocol ${DEFAULTS.protocolVersion}.`,
  );
} catch {
  // Avoid driver/config errors that can embed a URI or credentials.
  console.error(
    "Development API startup failed. Check development environment, dataset identity, and local replica-set readiness.",
  );
  process.exitCode = 1;
}
