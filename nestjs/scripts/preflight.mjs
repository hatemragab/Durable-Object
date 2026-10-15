import { spawnSync } from "node:child_process";
import { readEnvironment, root } from "./environment.mjs";
const checks = [
  ["Node", process.execPath, ["--version"]],
  ["npm", "npm", ["--version"]],
  ["Flutter", "flutter", ["--version"]],
  ["Dart", "dart", ["--version"]],
  ["MongoDB", "mongod", ["--version"]],
  ["Docker", "docker", ["--version"]],
  ["Xcode", "xcodebuild", ["-version"]],
  ["Wrangler", `${root}/cloudflare/node_modules/.bin/wrangler`, ["--version"]],
];
for (const [label, command, args] of checks) {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  console.log(
    `${label}: ${r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : "unavailable"}`,
  );
}
const env = await readEnvironment();
for (const key of [
  "APP_ENV",
  "DATASET_ID",
  "MONGO_URI",
  "DEV_SESSION_SECRET",
  "WS_TICKET_SECRET",
  "REALTIME_INTERNAL_SECRET",
  "REALTIME_BASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
])
  console.log(`${key}: ${env[key] ? "configured" : "missing"}`);
console.log(
  "Device/UI target: iPhone 17 Pro / iOS 26.0 / 3CC14436-EC3C-4419-A079-C84951E5FA07 only.",
);
