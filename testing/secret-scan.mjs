import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
const env = await readEnvironment();
const keys = [
  "DEV_SESSION_SECRET",
  "WS_TICKET_SECRET",
  "REALTIME_INTERNAL_SECRET",
  "CLOUDFLARE_API_TOKEN",
];
const inventory = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
);
if (inventory.status !== 0) throw new Error("Git inventory failed.");
const violations = [];
for (const file of inventory.stdout.split("\0").filter(Boolean)) {
  const bytes = await readFile(resolve(root, file));
  for (const key of keys)
    if (
      env[key] &&
      env[key].length >= 16 &&
      bytes.includes(Buffer.from(env[key]))
    )
      violations.push({ file, key });
}
const generatedFiles = [];
for (const directory of [".local", "flutter/.local"]) {
  try {
    generatedFiles.push(
      ...(await readdir(resolve(root, directory)))
        .filter((name) => /\.(log|json)$/.test(name))
        .map((name) => `${directory}/${name}`),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
for (const file of [...generatedFiles, "flutter/config.local.json"]) {
  let source;
  try {
    source = await readFile(resolve(root, file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const key of keys)
    if (env[key] && env[key].length >= 16 && source.includes(env[key]))
      violations.push({ file, key });
  if (
    /ticket=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(
      source,
    )
  )
    violations.push({ file, key: "raw token in log" });
  if (file.endsWith(".json")) {
    const config = JSON.parse(source);
    if (
      (file === "flutter/config.local.json" ||
        file === ".local/proxy-config.json" ||
        Object.hasOwn(config, "API_BASE_URL") ||
        Object.hasOwn(config, "EXPECTED_DATASET_ID")) &&
      Object.keys(config).some(
        (key) => !["API_BASE_URL", "EXPECTED_DATASET_ID"].includes(key),
      )
    )
      violations.push({ file, key: "unexpected public configuration field" });
  }
}
if (violations.length) {
  console.error(JSON.stringify({ secretScan: "failed", violations }, null, 2));
  process.exitCode = 1;
} else
  console.log(
    "Secret scan passed: Git-visible files, public Flutter configuration, and local service/native/build logs and reports contain no configured secret values or raw JWT tickets/bearer tokens.",
  );
