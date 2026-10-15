throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** Owns its API process and coordinates the native test through nonsecret sentinels. */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { open, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "../nestjs/scripts/environment.mjs";
const device = "3CC14436-EC3C-4419-A079-C84951E5FA07";
await mkdir(resolve(root, ".local"), { recursive: true });
const free = await new Promise((r) => {
  const socket = createConnection({ host: "127.0.0.1", port: 3000 });
  socket.once("connect", () => {
    socket.destroy();
    r(false);
  });
  socket.once("error", () => {
    socket.destroy();
    r(true);
  });
});
if (!free)
  throw new Error(
    "Port3000 must be free. Stop only your verified demo API before running this harness.",
  );
const apiLog = await open(resolve(root, ".local/api.log"), "a");
let api,
  flutter,
  stage = 0,
  stream = "",
  failure;
async function startApi() {
  api = spawn(
    process.execPath,
    [resolve(root, "nestjs/scripts/start-local.mjs")],
    { cwd: root, stdio: ["ignore", apiLog.fd, apiLog.fd] },
  );
  await new Promise((r, j) => {
    api.once("spawn", r);
    api.once("error", j);
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null)
      throw new Error("Owned API exited during startup.");
    try {
      const response = await fetch("http://127.0.0.1:3000/api/v1/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Owned API startup timed out.");
}
async function stopApi() {
  if (!api || api.exitCode !== null || api.signalCode !== null) return;
  const child = api;
  const exit = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exit;
}
const output = await open(resolve(root, ".local/ios-api-outage.log"), "w");
try {
  await startApi();
  flutter = spawn(
    "flutter",
    [
      "test",
      "integration_test/api_outage_test.dart",
      "-d",
      device,
      "--dart-define-from-file=config.local.json",
      "--no-pub",
    ],
    { cwd: resolve(root, "flutter"), stdio: ["ignore", "pipe", "pipe"] },
  );
  let controls = Promise.resolve();
  function consume(bytes) {
    stream += bytes;
    output.write(bytes);
    controls = controls
      .then(async () => {
        if (stage === 0 && stream.includes("API_OUTAGE_READY")) {
          console.log(
            "Native cached room and continuous socket ready; stopping owned API.",
          );
          await stopApi();
          stage = 1;
        }
        if (stage === 1 && stream.includes("API_OUTAGE_QUEUED")) {
          console.log(
            "Native SQLite pending intent and cached bubble verified during outage; restarting owned API.",
          );
          await startApi();
          stage = 2;
        }
      })
      .catch((error) => {
        failure = error;
        flutter.kill("SIGTERM");
      });
  }
  flutter.stdout.on("data", consume);
  flutter.stderr.on("data", consume);
  const timeout = setTimeout(() => {
    failure = new Error("Native outage harness exceeded five minutes.");
    flutter.kill("SIGTERM");
  }, 300000);
  const code = await new Promise((r, j) => {
    flutter.once("error", j);
    flutter.once("exit", r);
  });
  clearTimeout(timeout);
  await controls;
  if (failure) throw failure;
  if (
    code !== 0 ||
    stage !== 2 ||
    !stream.includes("API_OUTAGE_RECOVERED") ||
    !stream.includes("All tests passed!")
  )
    throw new Error(
      "Native API outage test failed; inspect redacted .local/ios-api-outage.log.",
    );
  const report = {
    status: "passed",
    scope:
      "native Flutter/sqflite on authorized iPhone17Pro iOS26.0 + actual local API/replica set/workerd",
    device,
    completedAt: new Date().toISOString(),
    checks: [
      "cached room and socket synchronized before outage",
      "only harness-owned API stopped",
      "required composer persisted queued intent and displayed cached bubble with API down",
      "same connection remained live through outage",
      "restart drained original client ID to one canonical message and exact durable echo",
      "same-key REST retry returned original message",
    ],
  };
  await writeFile(
    resolve(root, ".local/ios-api-outage-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stopApi();
  await apiLog.close();
  await output.close();
}
