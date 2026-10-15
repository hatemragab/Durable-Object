throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** Actual OS Settings-background / same-app foreground proof on the sole authorized simulator. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { root, readEnvironment } from "../nestjs/scripts/environment.mjs";

const exec = promisify(execFile);
const device = "3CC14436-EC3C-4419-A079-C84951E5FA07";
const bundle = "com.example.durableChatDemo";
const marker = `lifecycle_${Date.now()}_${randomUUID().slice(0, 8)}`;
const reportPath = resolve(root, ".local/ios-lifecycle-report.json");
const owned = [],
  files = [],
  checks = [];
let stage = "preflight",
  failure,
  api,
  flutter,
  report,
  output = "",
  nativeDirectory;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (text) =>
  text
    .replace(/([?&]ticket=)[^\s&"']+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, "$1<redacted>");
const command = async (name, args) =>
  (
    await exec(name, args, { cwd: root, timeout: 15000, maxBuffer: 1048576 })
  ).stdout.trim();
async function freePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied; existing processes will not be stopped.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function start(name, executable, args, cwd, consume = () => {}) {
  const file = await open(resolve(root, `.local/${name}.log`), "a", 0o600);
  files.push(file);
  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = {
    child,
    name,
    exited: new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    }),
  };
  owned.push(handle);
  let pending = "";
  const receive = (bytes) => {
    const value = bytes.toString("utf8");
    consume(value);
    pending += value;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) void file.write(`${redact(line)}\n`);
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  child.once("exit", () => {
    if (pending) void file.write(`${redact(pending)}\n`);
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return handle;
}
async function stop(handle) {
  if (
    !handle ||
    handle.child.exitCode !== null ||
    handle.child.signalCode !== null
  )
    return;
  handle.child.kill("SIGTERM");
  let timer;
  const ended = await Promise.race([
    handle.exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    }),
  ]);
  clearTimeout(timer);
  if (!ended) {
    handle.child.kill("SIGKILL");
    await handle.exited;
  }
}
async function waitFor(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (
      flutter &&
      flutter.child.exitCode !== null &&
      flutter.child.exitCode !== 0
    )
      throw new Error("Owned native test failed; inspect redacted log.");
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`Timed out during ${stage}.`);
}
async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function nativeFile(name) {
  try {
    return await jsonFile(resolve(nativeDirectory, `${name}-${marker}.json`));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function request(path, body, token) {
  const response = await fetch(`http://127.0.0.1:3000/api/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Local test API returned HTTP ${response.status}.`);
  return response.json();
}
async function startApi() {
  api = await start(
    "lifecycle-api",
    process.execPath,
    [resolve(root, "nestjs/scripts/start-local.mjs")],
    root,
  );
  await waitFor(async () => {
    if (api.child.exitCode !== null)
      throw new Error("Owned API failed startup.");
    try {
      return (
        await fetch("http://127.0.0.1:3000/api/v1/health", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, 20000);
}
function inspectPaused(prepared, env) {
  const db = new DatabaseSync(
    resolve(nativeDirectory, `chat_${env.DATASET_ID}_1.db`),
    { readOnly: true },
  );
  try {
    const row = db
      .prepare(
        "SELECT send_state,server_id FROM messages WHERE sender_id=? AND client_message_id=?",
      )
      .get("1", prepared.clientMessageId);
    assert.equal(row.send_state, "queued");
    assert.equal(row.server_id, null);
    assert.equal(
      db.prepare("SELECT last_applied_seq FROM account_meta WHERE id=1").get()
        .last_applied_seq,
      prepared.cursor,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE room_id=?")
        .get(prepared.roomId).count,
      prepared.cachedCount,
    );
    assert.equal(
      db
        .prepare(
          "SELECT state FROM outgoing_messages WHERE client_message_id=?",
        )
        .get(prepared.clientMessageId).state,
      "queued",
    );
  } finally {
    db.close();
  }
}
try {
  const env = await readEnvironment();
  assert.equal(env.APP_ENV, "development");
  assert.equal(Number(env.PORT ?? 3000), 3000);
  await freePort(3000);
  const devices = JSON.parse(
    await command("xcrun", ["simctl", "list", "devices", "booted", "--json"]),
  );
  assert.ok(
    devices.devices?.["com.apple.CoreSimulator.SimRuntime.iOS-26-0"]?.some(
      (item) =>
        item.udid === device &&
        item.name === "iPhone 17 Pro" &&
        item.state === "Booted",
    ),
    "Exact authorized simulator must already be booted.",
  );
  assert.ok(
    (
      await fetch("http://127.0.0.1:8787/health", {
        signal: AbortSignal.timeout(2000),
      })
    ).ok,
  );
  await mkdir(resolve(root, ".local"), { recursive: true });
  const config = resolve(root, `.local/ios-lifecycle-${marker}.json`);
  await writeFile(
    config,
    JSON.stringify({
      API_BASE_URL: "http://127.0.0.1:3000/api/v1",
      EXPECTED_DATASET_ID: env.DATASET_ID,
    }) + "\n",
    { mode: 0o600 },
  );
  stage = "owned API and native cache/history preparation";
  await startApi();
  flutter = await start(
    "ios-lifecycle",
    "flutter",
    [
      "test",
      "integration_test/lifecycle_test.dart",
      "-d",
      device,
      `--dart-define-from-file=${config}`,
      `--dart-define=LIFECYCLE_TEST_MARKER=${marker}`,
      "--no-pub",
    ],
    resolve(root, "flutter"),
    (value) => {
      output = (output + value).slice(-131072);
    },
  );
  await waitFor(() => output.includes("LIFECYCLE_STOP_API"), 300000);
  stage = "owned API stop and native queued composer";
  await stop(api);
  await waitFor(() => output.includes("LIFECYCLE_READY"), 60000);
  const container = await command("xcrun", [
    "simctl",
    "get_app_container",
    device,
    bundle,
    "data",
  ]);
  nativeDirectory = resolve(container, "Documents");
  stage = "actual Settings foreground / demo OS background";
  await command("xcrun", ["simctl", "launch", device, "com.apple.Preferences"]);
  let prepared;
  await waitFor(async () => {
    const failed = await nativeFile("lifecycle-failed");
    if (failed) throw new Error("Native lifecycle assertion failed.");
    prepared = await nativeFile("lifecycle-background");
    return Boolean(prepared);
  }, 30000);
  assert.equal(prepared.marker, marker);
  assert.equal(prepared.dataset, env.DATASET_ID);
  assert.equal(prepared.foreground, false);
  assert.equal(prepared.state, "backgroundPaused");
  assert.equal(prepared.connectionId, null);
  assert.equal(prepared.sendState, "queued");
  assert.ok(prepared.lifecycle.some((item) => item.state === "paused"));
  inspectPaused(prepared, env);
  checks.push(
    "actual OS paused event after Settings launch; product socket retired and native cache/cursor/queued intent preserved",
  );
  stage =
    "API restored and peer journal published while demo remains backgrounded";
  await startApi();
  const peerSession = await request("/dev/session", {
    userId: "2",
    deviceId: randomUUID(),
  });
  const peer = await request(
    `/rooms/${prepared.roomId}/messages`,
    { clientMessageId: randomUUID(), text: `Background peer ${marker}` },
    peerSession.sessionToken,
  );
  const observerSession = await request("/dev/session", {
    userId: "1",
    deviceId: randomUUID(),
  });
  let diagnostics;
  await waitFor(async () => {
    diagnostics = await request(
      "/dev/diagnostics",
      null,
      observerSession.sessionToken,
    );
    return (
      diagnostics.mongoHead > prepared.cursor &&
      diagnostics.workerHead === diagnostics.mongoHead &&
      diagnostics.unpublishedCount === 0
    );
  }, 30000);
  await writeFile(
    resolve(nativeDirectory, `lifecycle-peer-${marker}.json`),
    JSON.stringify({
      messageId: peer.message.id,
      workerHead: diagnostics.workerHead,
    }) + "\n",
    { mode: 0o600 },
  );
  await pause(3000);
  inspectPaused(prepared, env);
  checks.push(
    "API reachable and peer event retained in Worker while OS-backgrounded native queue/cursor remained paused",
  );
  stage = "same installed app foreground / ticket / replay / queue convergence";
  await command("xcrun", ["simctl", "launch", device, bundle]);
  let completed;
  await waitFor(async () => {
    if (await nativeFile("lifecycle-failed"))
      throw new Error("Native foreground recovery assertion failed.");
    completed = await nativeFile("lifecycle-completed");
    return Boolean(completed);
  }, 90000);
  assert.equal(completed.status, "passed");
  assert.equal(completed.deviceId, prepared.deviceId);
  assert.equal(completed.clientMessageId, prepared.clientMessageId);
  assert.equal(completed.peerMessageId, peer.message.id);
  assert.equal(completed.freshTicket, true);
  assert.notEqual(completed.beforeConnection, completed.afterConnection);
  assert.ok(completed.afterCursor > prepared.cursor);
  assert.ok(
    completed.replayTargets.some((target) => target >= diagnostics.workerHead),
  );
  const states = completed.lifecycle.map((item) => item.state);
  assert.ok(
    states.includes("paused") &&
      states.lastIndexOf("resumed") > states.indexOf("paused"),
  );
  checks.push(
    "real OS resumed event; new ticket/connection; retained peer replay and exactly one original pending message confirmed with durable echo",
  );
  assert.deepEqual(
    completed.historyPages.slice(0, 3).map((page) => page.before),
    [null, 71, 21],
  );
  checks.push(
    "native older-history UI requested all120 messages across three strict pages and preserved scroll position",
  );
  await waitFor(() => flutter.child.exitCode !== null, 30000);
  assert.equal(flutter.child.exitCode, 0);
  assert.ok(output.includes("All tests passed!"));
  report = {
    status: "passed",
    scope:
      "actual OS background/foreground on authorized iPhone17Pro iOS26.0 + local NestJS/Mongo/workerd; no real Cloudflare or multiple native devices",
    scenario: "S43 and native older-history pagination",
    device,
    bundle,
    marker,
    completedAt: new Date().toISOString(),
    checks,
    native: completed,
  };
} catch (error) {
  process.exitCode = 1;
  report = {
    status: "failed",
    stage,
    marker,
    device,
    error: redact(error.message),
    completedAt: new Date().toISOString(),
    checks,
  };
  console.error(
    `Native lifecycle proof failed during ${stage}: ${redact(error.message)}; inspect redacted .local/ios-lifecycle.log.`,
  );
} finally {
  for (const handle of [...owned].reverse()) await stop(handle);
  for (const file of files) await file.close();
  await mkdir(resolve(root, ".local"), { recursive: true });
  try {
    await freePort(3000);
    report.helperPortLeftFree = true;
  } catch {
    report.helperPortLeftFree = false;
    report.status = "failed";
    process.exitCode = 1;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}
if (report.status === "passed") console.log(JSON.stringify(report, null, 2));
