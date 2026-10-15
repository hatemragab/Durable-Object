throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** Native S19: kill the authorized app while its real committed REST send is held. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, open, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import mongoose from "../nestjs/node_modules/mongoose/index.js";
import { root, readEnvironment } from "../nestjs/scripts/environment.mjs";

const exec = promisify(execFile);
const device = "3CC14436-EC3C-4419-A079-C84951E5FA07";
const bundle = "com.example.durableChatDemo";
const marker = `inflight_${Date.now()}_${randomUUID().slice(0, 8)}`;
const reportPath = resolve(root, ".local/ios-inflight-restart-report.json");
const proxyReportPath = resolve(root, ".local/fault-proxy-report.json");
const owned = [];
const logs = [];
const checks = [];
let stage = "preflight",
  failure,
  preparedSeen = false,
  committedSeen = false,
  killTask,
  killedAt,
  killRequestedAt,
  proxyCommittedAt,
  flutter;
let report;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeLine = (value) =>
  value
    .replace(/([?&]ticket=)[^\s&"']+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, "$1<redacted>");

async function command(name, args, timeout = 15_000) {
  const result = await exec(name, args, {
    cwd: root,
    timeout,
    maxBuffer: 1_048_576,
  });
  return result.stdout.trim();
}
async function freePort(port) {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied; no existing process will be stopped.`,
        ),
      ),
    );
    listener.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}
async function waitFor(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (await check()) return;
    await pause(25);
  }
  throw new Error("The current native in-flight proof stage timed out.");
}
async function startChild(name, executable, args, cwd, consume = () => {}) {
  const output = await open(resolve(root, `.local/${name}.log`), "a", 0o600);
  logs.push(output);
  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = {
    name,
    child,
    stopped: false,
    exited: new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    }),
  };
  owned.push(handle);
  let pending = "";
  function receive(bytes) {
    const text = bytes.toString("utf8");
    consume(text);
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) void output.write(`${safeLine(line)}\n`);
  }
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  child.once("exit", () => {
    if (pending) void output.write(`${safeLine(pending)}\n`);
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () =>
      reject(new Error("A harness-owned helper could not start.")),
    );
  });
  return handle;
}
async function stopChild(handle) {
  if (!handle || handle.stopped) return;
  const child = handle.child;
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([
    handle.exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    }),
  ]);
  clearTimeout(timer);
  if (!stopped) {
    child.kill("SIGKILL");
    await handle.exited;
  }
  handle.stopped = true;
}
function terminateWhenPrepared() {
  if (!preparedSeen || !committedSeen || killTask) return;
  stage = "terminate the authorized native app while sending";
  killRequestedAt = new Date().toISOString();
  // No marker scans or database calls precede termination after both live sentinels.
  killTask = command("xcrun", ["simctl", "terminate", device, bundle])
    .then(() => {
      killedAt = new Date().toISOString();
    })
    .catch((error) => {
      failure = error;
    });
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function artifactHashes(appPath) {
  const candidates = [
    "Runner",
    "Frameworks/App.framework/App",
    "Frameworks/App.framework/flutter_assets/kernel_blob.bin",
  ];
  const result = {};
  for (const name of candidates) {
    const path = resolve(appPath, name);
    try {
      if ((await stat(path)).isFile())
        result[name] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  assert.ok(
    result.Runner,
    "The installed native executable must be identified.",
  );
  assert.ok(
    Object.keys(result).some((name) => name !== "Runner"),
    "The installed Dart artifact must be identified.",
  );
  return result;
}

try {
  const env = await readEnvironment();
  assert.equal(env.APP_ENV, "development");
  assert.equal(Number(env.PORT ?? 3000), 3000);
  await freePort(3000);
  await freePort(3002);
  const inventory = JSON.parse(
    await command("xcrun", ["simctl", "list", "devices", "booted", "--json"]),
  );
  const authorized = inventory.devices?.[
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0"
  ]?.find((item) => item.udid === device);
  assert.ok(
    authorized &&
      authorized.state === "Booted" &&
      authorized.name === "iPhone 17 Pro",
    "The exact authorized iPhone 17 Pro/iOS 26.0 simulator must be booted.",
  );
  const workerHealth = await fetch("http://127.0.0.1:8787/health", {
    signal: AbortSignal.timeout(2000),
  });
  assert.ok(workerHealth.ok);
  await mkdir(resolve(root, ".local"), { recursive: true });
  const publicConfig = resolve(root, `.local/ios-inflight-${marker}.json`);
  await writeFile(
    publicConfig,
    JSON.stringify(
      {
        API_BASE_URL: "http://127.0.0.1:3002/api/v1",
        EXPECTED_DATASET_ID: env.DATASET_ID,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  checks.push(
    "exact authorized iPhone 17 Pro/iOS 26.0 selected; both helper ports initially free",
  );

  stage = "owned local API and hold proxy startup";
  let apiReady = false;
  const api = await startChild(
    "inflight-api",
    process.execPath,
    [resolve(root, "nestjs/scripts/start-local.mjs")],
    root,
    (text) => {
      if (text.includes("Local-only development API ready at "))
        apiReady = true;
    },
  );
  await waitFor(async () => {
    if (api.child.exitCode !== null)
      throw new Error("Owned API exited during startup.");
    if (!apiReady) return false;
    try {
      return (
        await fetch("http://127.0.0.1:3000/api/v1/health", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  });
  let proxyReady = false,
    proxyText = "";
  const proxy = await startChild(
    "inflight-proxy",
    process.execPath,
    [
      resolve(root, "testing/fault-proxy.mjs"),
      "--hold-first-message",
      `--hold-message-marker=${marker}`,
    ],
    root,
    (text) => {
      proxyText = `${proxyText}${text}`.slice(-4096);
      if (proxyText.includes("FAULT_PROXY_READY")) proxyReady = true;
      if (proxyText.includes("COMMITTED_MESSAGE_HELD")) {
        committedSeen = true;
        terminateWhenPrepared();
      }
    },
  );
  await waitFor(() => {
    if (proxy.child.exitCode !== null)
      throw new Error("Owned hold proxy exited during startup.");
    return proxyReady;
  });
  checks.push("only harness-owned API and loopback hold proxy launched");

  stage = "native prepare and committed in-flight send";
  let flutterText = "";
  flutter = await startChild(
    "ios-inflight-restart",
    "flutter",
    [
      "run",
      "-t",
      "integration_test/restart_roundtrip_test.dart",
      "-d",
      device,
      `--dart-define-from-file=${publicConfig}`,
      `--dart-define=RESTART_TEST_MARKER=${marker}`,
      "--dart-define=HOLD_FOR_TERMINATION=true",
      "--dart-define=KILL_WHILE_SENDING=true",
      "--no-pub",
    ],
    resolve(root, "flutter"),
    (text) => {
      flutterText = `${flutterText}${text}`.slice(-65_536);
      if (flutterText.includes(`RESTART_PREPARED:${marker}`)) {
        preparedSeen = true;
        terminateWhenPrepared();
      }
      if (flutterText.includes(`RESTART_FAILED:${marker}`))
        failure = new Error("The native prepare test reported failure.");
    },
  );
  await waitFor(() => {
    if (flutter.child.exitCode !== null && !killTask)
      throw new Error("The owned Flutter runner exited before preparation.");
    return Boolean(killTask);
  }, 300_000);
  await killTask;
  if (failure) throw failure;
  await stopChild(flutter);
  const held = await readJson(proxyReportPath);
  assert.equal(held.mode, "hold-first-message");
  assert.equal(held.heldMessage.fullCommittedResponseRead, true);
  assert.equal(held.heldMessage.upstreamStatus, 201);
  assert.equal(held.heldMessage.requestCapturedBeforeForward, true);
  assert.ok(
    held.counts.serverBatchesSuppressed > 0,
    "The sender echo must have been suppressed before termination.",
  );
  proxyCommittedAt = held.heldMessage.committedAt;
  const commitToKillMs =
    Date.parse(killRequestedAt) - Date.parse(proxyCommittedAt);
  assert.ok(
    commitToKillMs >= 0 && commitToKillMs < 12_000,
    "Termination must precede the fifteen-second native REST timeout.",
  );
  checks.push(
    "native sending marker and fully committed held HTTP response both observed before explicit app termination",
  );
  checks.push(
    "matching sender-device event batch suppressed so neither REST nor WebSocket confirmed before kill",
  );

  stage = "persisted sending state after real native termination";
  const container = await command("xcrun", [
    "simctl",
    "get_app_container",
    device,
    bundle,
    "data",
  ]);
  const databaseDirectory = resolve(container, "Documents");
  const prepared = await readJson(
    resolve(databaseDirectory, `restart-${marker}.json`),
  );
  assert.equal(prepared.persistedSendState, "sending");
  assert.equal(prepared.marker, marker);
  assert.equal(prepared.dataset, env.DATASET_ID);
  assert.equal(prepared.clientMessageId, held.heldMessage.clientMessageId);
  assert.equal(prepared.deviceId, held.heldMessage.deviceId);
  const databasePath = resolve(
    databaseDirectory,
    `chat_${prepared.dataset}_1.db`,
  );
  const beforeDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = beforeDb
      .prepare(
        "SELECT send_state,server_id,text FROM messages WHERE sender_id=? AND client_message_id=?",
      )
      .all("1", prepared.clientMessageId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].send_state, "sending");
    assert.equal(rows[0].server_id, null);
    assert.equal(rows[0].text, prepared.text);
    assert.equal(
      beforeDb
        .prepare(
          "SELECT state FROM outgoing_messages WHERE client_message_id=?",
        )
        .get(prepared.clientMessageId).state,
      "sending",
    );
    assert.equal(
      beforeDb
        .prepare("SELECT last_applied_seq FROM account_meta WHERE id=1")
        .get().last_applied_seq,
      prepared.cursor,
    );
  } finally {
    beforeDb.close();
  }
  checks.push(
    "post-kill native SQLite retained one sending row, sending outgoing intent, original text/key, null server ID and unchanged cursor",
  );
  await waitFor(
    async () => (await readJson(proxyReportPath)).holdReleased,
    5000,
  );
  const appPath = await command("xcrun", [
    "simctl",
    "get_app_container",
    device,
    bundle,
    "app",
  ]);
  const beforeHashes = await artifactHashes(appPath);

  stage = "same installed binary relaunch and recovery";
  const launched = await command("xcrun", ["simctl", "launch", device, bundle]);
  const nativePid = Number(/:\s*(\d+)\s*$/.exec(launched)?.[1]);
  assert.ok(Number.isInteger(nativePid) && nativePid > 0);
  let completed;
  await waitFor(async () => {
    try {
      await readFile(
        resolve(databaseDirectory, `restart-failed-${marker}.json`),
      );
      throw new Error("Native recovery wrote a failure marker.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      completed = await readJson(
        resolve(databaseDirectory, `restart-completed-${marker}.json`),
      );
      return true;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  }, 90_000);
  assert.equal(completed.phase, "recovered");
  assert.equal(completed.marker, marker);
  assert.equal(completed.dataset, env.DATASET_ID);
  assert.equal(completed.deviceId, prepared.deviceId);
  assert.equal(completed.clientMessageId, prepared.clientMessageId);
  assert.equal(completed.messageId, held.heldMessage.serverMessageId);
  assert.equal(completed.beforeCursor, prepared.cursor);
  assert.ok(completed.afterCursor > completed.beforeCursor);
  assert.deepEqual(
    await artifactHashes(
      await command("xcrun", [
        "simctl",
        "get_app_container",
        device,
        bundle,
        "app",
      ]),
    ),
    beforeHashes,
  );
  checks.push(
    "same installed native/Dart artifacts relaunched without reinstall or database copy; native recovery confirmed original device/key/cursor and exact durable echo",
  );

  stage = "Mongo and native canonical uniqueness verification";
  const mongoUrl = new URL(env.MONGO_URI);
  assert.ok(
    mongoUrl.protocol === "mongodb:" &&
      ["localhost", "127.0.0.1"].includes(mongoUrl.hostname) &&
      mongoUrl.pathname.startsWith("/chat_poc_") &&
      mongoUrl.searchParams.get("replicaSet") === "rs0",
  );
  const mongo = new mongoose.mongo.MongoClient(env.MONGO_URI, {
    serverSelectionTimeoutMS: 3000,
  });
  try {
    await mongo.connect();
    const database = mongo.db();
    assert.equal(
      (
        await database
          .collection("dataset_metadata")
          .findOne({ _id: "dataset" })
      ).datasetId,
      env.DATASET_ID,
    );
    const canonical = await database
      .collection("messages")
      .find({
        datasetId: env.DATASET_ID,
        senderId: "1",
        clientMessageId: prepared.clientMessageId,
      })
      .toArray();
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0]._id, completed.messageId);
    assert.equal(canonical[0].originDeviceId, prepared.deviceId);
    assert.equal(canonical[0].roomId, prepared.roomId);
    assert.equal(canonical[0].text, prepared.text);
  } finally {
    await mongo.close();
  }
  const afterDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const local = afterDb
      .prepare(
        "SELECT server_id,send_state FROM messages WHERE sender_id=? AND client_message_id=?",
      )
      .all("1", prepared.clientMessageId);
    assert.equal(local.length, 1);
    assert.equal(local[0].server_id, completed.messageId);
    assert.equal(local[0].send_state, "sent");
    assert.equal(
      afterDb
        .prepare(
          "SELECT COUNT(*) AS count FROM outgoing_messages WHERE client_message_id=?",
        )
        .get(prepared.clientMessageId).count,
      0,
    );
  } finally {
    afterDb.close();
  }
  const finalProxy = await readJson(proxyReportPath);
  assert.ok(finalProxy.heldMessage.duplicateResponsesAfterRelease > 0);
  assert.equal(finalProxy.counts.clientAcksDropped, 0);
  await writeFile(
    resolve(root, ".local/ios-inflight-proxy-report.json"),
    JSON.stringify(finalProxy, null, 2) + "\n",
    { mode: 0o600 },
  );
  checks.push(
    "Mongo contains exactly one original canonical message; native cache contains one sent row, no outgoing row, and same-key retry returned duplicate",
  );
  report = {
    status: "passed",
    scenario: "S19",
    scope:
      "actual native Flutter/sqflite on authorized simulator + local NestJS/Mongo replica set/workerd, killed while persisted sending and committed response/echo held; not real Cloudflare or multiple mobile devices",
    device,
    bundle,
    marker,
    completedAt: new Date().toISOString(),
    datasetId: env.DATASET_ID,
    clientMessageId: prepared.clientMessageId,
    messageId: completed.messageId,
    deviceId: prepared.deviceId,
    beforeCursor: completed.beforeCursor,
    afterCursor: completed.afterCursor,
    proxyCommittedAt,
    killRequestedAt,
    killedAt,
    commitToKillMs,
    nativeRelaunchPid: nativePid,
    sameInstalledArtifactHashes: beforeHashes,
    ownedHelperPids: owned
      .filter((handle) => handle.name !== "ios-inflight-restart")
      .map((handle) => handle.child.pid),
    nativeAppLeftRunning: true,
    checks,
  };
} catch {
  process.exitCode = 1;
  report = {
    status: "failed",
    scenario: "S19",
    stage,
    marker,
    device,
    completedAt: new Date().toISOString(),
    preparedSeen,
    committedSeen,
    killedAt: killedAt ?? null,
    checks,
  };
  console.error(
    `Native in-flight restart proof failed during ${stage}. No token or message contents are printed.`,
  );
} finally {
  for (const handle of [...owned].reverse()) await stopChild(handle);
  for (const output of logs) await output.close();
  await mkdir(resolve(root, ".local"), { recursive: true });
  try {
    await freePort(3000);
    await freePort(3002);
    report.helperPortsLeftFree = true;
  } catch {
    report.helperPortsLeftFree = false;
    if (report.status === "passed") {
      report.status = "failed";
      report.stage = "helper cleanup";
      process.exitCode = 1;
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}
if (report.status === "passed") console.log(JSON.stringify(report, null, 2));
