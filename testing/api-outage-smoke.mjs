throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** S27 protocol evidence with local workerd or verified Cloudflare and SQLite. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "../nestjs/node_modules/ws/wrapper.mjs";
import { DEFAULTS, parseBatch, isUuid } from "../shared/dist/index.js";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
import {
  validateCloudDeployment,
  validateTicketOrigin,
  startHeartbeat,
} from "./local-smoke.mjs";

const env = await readEnvironment();
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--cloud"))
  throw new Error("Usage: node testing/api-outage-smoke.mjs [--cloud]");
const cloud = args.includes("--cloud");
const deployment = cloud
  ? validateCloudDeployment(
      env,
      JSON.parse(
        await readFile(resolve(root, ".local/deployment.json"), "utf8"),
      ),
    )
  : null;
const base = "http://127.0.0.1:3000/api/v1";
const worker = deployment?.origin ?? "http://127.0.0.1:8787";
const entry = resolve(
  root,
  cloud ? "nestjs/dist/src/main.js" : "nestjs/scripts/start-local.mjs",
);
const reportPath = resolve(
  root,
  cloud
    ? ".local/cloud-api-outage-report.json"
    : ".local/api-outage-report.json",
);
const runId = randomUUID();
const checks = [];
const ownedProcesses = [];
const directory = resolve(
  root,
  `.local/${cloud ? "cloud-api-outage" : "api-outage"}/${runId}`,
);
let stage = "configuration";
let socket;
let socketError;
let hello;
let helloAt;
let resumed = false;
let syncedThrough = null;
let apiDown = false;
let heartbeat;
let heartbeatStats;
let db;
let log;
let finalReport;
let committedBatchAcks = 0;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (socketError) throw new Error("The owned protocol socket failed.");
    if (await check()) return;
    await pause(25);
  }
  throw new Error(`Timed out during ${label}.`);
}

async function requireFreeApiPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", () =>
      reject(
        new Error(
          "Port 3000 is already occupied; no existing listener will be stopped.",
        ),
      ),
    );
    listener.listen(3000, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}

async function startOwnedApi() {
  await requireFreeApiPort();
  const child = spawn(process.execPath, [entry], {
    cwd: cloud ? resolve(root, "nestjs") : root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const owned = {
    child,
    pid: child.pid,
    listening: false,
    stopped: false,
    exited: null,
  };
  owned.exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  ownedProcesses.push(owned);
  let output = "";
  child.stdout.on("data", (chunk) => {
    log.write(chunk);
    output = `${output}${chunk}`.slice(-1024);
    if (
      output.includes(
        cloud
          ? `Development API ready on ${env.HOST ?? "127.0.0.1"}:3000;`
          : "Local-only development API ready at ",
      )
    )
      owned.listening = true;
  });
  child.stderr.on("data", (chunk) => log.write(chunk));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () =>
      reject(new Error("Could not launch the owned API process.")),
    );
  });
  await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("The owned API exited during startup.");
      if (!owned.listening) return false;
      try {
        return (
          await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
        ).ok;
      } catch {
        return false;
      }
    },
    "owned API readiness",
    15_000,
  );
  return owned;
}

async function stopOwnedApi(owned) {
  if (owned.stopped) return;
  const child = owned.child;
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([
    owned.exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 8000);
    }),
  ]);
  clearTimeout(timer);
  if (!stopped) {
    child.kill("SIGKILL");
    await owned.exited;
  }
  owned.stopped = true;
}

async function api(path, { token, body, status = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(cloud ? 15_000 : 5000),
  });
  assert.equal(
    response.status,
    status,
    "The local API returned an unexpected status.",
  );
  const data = await response.json();
  assert.ok(
    !data.datasetId || data.datasetId === env.DATASET_ID,
    "The API belongs to a different dataset.",
  );
  return data;
}

async function workerHead() {
  const response = await fetch(`${worker}/internal/v1/users/2/stream`, {
    headers: {
      Authorization: `Bearer ${env.REALTIME_INTERNAL_SECRET}`,
      "X-Dataset-Id": env.DATASET_ID,
    },
    signal: AbortSignal.timeout(cloud ? 10_000 : 1000),
  });
  assert.equal(response.status, 200, "The local Worker stream is unavailable.");
  const data = await response.json();
  assert.equal(data.datasetId, env.DATASET_ID);
  assert.equal(data.userId, "2");
  assert.ok(Number.isSafeInteger(data.headSeq) && data.headSeq >= 0);
  return data.headSeq;
}

async function requireApiUnavailable() {
  let unreachable = false;
  try {
    await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
  } catch {
    unreachable = true;
  }
  assert.ok(
    unreachable,
    "REST must be unreachable while replay is being proved.",
  );
}

function cursor() {
  return db.prepare("SELECT seq FROM cursor").get().seq;
}
function applyBatch(frame) {
  assert.ok(
    apiDown && resumed,
    "A batch must be consumed only after the owned API stopped.",
  );
  const batch = parseBatch(frame);
  assert.ok(batch.fromSeq <= cursor() + 1, "The replay batch has a gap.");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const event of batch.events) {
      assert.equal(event.datasetId, env.DATASET_ID);
      assert.equal(event.userId, "2");
      const json = JSON.stringify(event);
      const prior = db
        .prepare("SELECT json FROM events WHERE seq=?")
        .get(event.streamSeq);
      if (prior) {
        assert.equal(prior.json, json);
        continue;
      }
      assert.equal(event.streamSeq, cursor() + 1);
      db.prepare("INSERT INTO events VALUES(?,?,?)").run(
        event.streamSeq,
        event.eventId,
        json,
      );
      const room = event.data.room,
        roomJson = JSON.stringify(room);
      const cachedRoom = db
        .prepare("SELECT version,json FROM rooms WHERE id=?")
        .get(room.id);
      if (!cachedRoom || room.version > cachedRoom.version)
        db.prepare(
          "INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,json=excluded.json",
        ).run(room.id, room.version, roomJson);
      else if (room.version === cachedRoom.version)
        assert.equal(cachedRoom.json, roomJson);
      if (event.type === "message.created") {
        const message = event.data.message,
          messageJson = JSON.stringify(message);
        const cached = db
          .prepare(
            "SELECT id,json FROM messages WHERE id=? OR (sender_id=? AND client_key=?)",
          )
          .all(message.id, message.senderId, message.clientMessageId);
        if (cached.length) {
          assert.equal(cached.length, 1);
          assert.equal(cached[0].id, message.id);
          assert.equal(cached[0].json, messageJson);
        } else
          db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
            message.id,
            message.roomId,
            message.senderId,
            message.clientMessageId,
            messageJson,
          );
      }
      db.prepare("UPDATE cursor SET seq=?").run(event.streamSeq);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  assert.ok(cursor() >= batch.toSeq, "SQLite must commit before ACK.");
  socket.send(
    JSON.stringify({
      v: 1,
      type: "ack",
      batchId: batch.batchId,
      throughSeq: batch.toSeq,
    }),
  );
  committedBatchAcks++;
}

async function closeSocket() {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  socket.close(1000, "outage proof complete");
  let timer;
  await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 2000);
    }),
  ]);
  clearTimeout(timer);
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

try {
  assert.equal(env.APP_ENV, "development");
  assert.ok(isUuid(env.DATASET_ID));
  assert.equal(
    Number(env.PORT ?? 3000),
    3000,
    "This proof requires the configured local API port 3000.",
  );
  await requireFreeApiPort();
  await workerHead();
  await mkdir(directory, { recursive: true });
  log = createWriteStream(resolve(root, ".local/api.log"), {
    flags: "a",
    mode: 0o600,
  });
  db = new DatabaseSync(resolve(directory, "device.sqlite"));
  db.exec(
    "CREATE TABLE cursor(seq INTEGER NOT NULL); INSERT INTO cursor VALUES(0); CREATE TABLE events(seq INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,json TEXT NOT NULL); CREATE TABLE rooms(id TEXT PRIMARY KEY,version INTEGER NOT NULL,json TEXT NOT NULL); CREATE TABLE messages(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,sender_id TEXT NOT NULL,client_key TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(sender_id,client_key));",
  );
  stage = "first API startup";
  const firstApi = await startOwnedApi();
  checks.push("harness launched its own API after proving port 3000 was free");
  const senderDevice = randomUUID(),
    receiverDevice = randomUUID();
  const sender = await api("/dev/session", {
    body: { userId: "1", deviceId: senderDevice },
  });
  const receiver = await api("/dev/session", {
    body: { userId: "2", deviceId: receiverDevice },
  });
  if (cloud) {
    assert.equal(sender.realtimeBaseUrl, worker);
    assert.equal(receiver.realtimeBaseUrl, worker);
    checks.push("both API sessions use the verified real Cloudflare origin");
  }
  const group = await api("/rooms/group", {
    token: sender.sessionToken,
    body: {
      title: "Synthetic API outage proof",
      memberUserIds: ["2"],
      clientRequestId: randomUUID(),
    },
    status: 201,
  });
  const clientMessageId = randomUUID(),
    text = `Synthetic outage replay ${runId}`;
  const sent = await api(`/rooms/${group.room.id}/messages`, {
    token: sender.sessionToken,
    body: { clientMessageId, text },
    status: 201,
  });
  const diagnostic = await api("/dev/diagnostics", {
    token: receiver.sessionToken,
  });
  assert.ok(
    Number.isSafeInteger(diagnostic.mongoHead) && diagnostic.mongoHead > 0,
  );
  const targetSeq = diagnostic.mongoHead;
  await waitFor(
    async () => (await workerHead()) >= targetSeq,
    "message acceptance before socket handshake",
    cloud ? 180_000 : 10_000,
  );

  stage = "authenticated socket waiting for resume";
  const ticket = await api("/realtime/ticket", {
    token: receiver.sessionToken,
    body: {},
  });
  const url = validateTicketOrigin(ticket.url, deployment?.origin);
  url.searchParams.set("ticket", ticket.ticket);
  socket = new WebSocket(url, {
    handshakeTimeout: 10_000,
    maxPayload: DEFAULTS.maxBatchBytes,
  });
  socket.onmessage = (event) => {
    try {
      if (event.data === "pong") {
        heartbeat?.pong();
        return;
      }
      const frame = JSON.parse(event.data);
      if (frame.type === "hello") {
        assert.equal(frame.datasetId, env.DATASET_ID);
        assert.equal(frame.userId, "2");
        assert.equal(frame.deviceId, receiverDevice);
        hello = frame;
        helloAt = Date.now();
      } else if (frame.type === "events.batch") applyBatch(frame);
      else if (frame.type === "sync.ready") {
        assert.ok(apiDown);
        syncedThrough = frame.throughSeq;
      } else if (frame.type === "error")
        throw new Error("Worker protocol error.");
    } catch {
      socketError = new Error(
        "The replay frame failed validation or SQLite persistence.",
      );
      socket.close();
    }
  };
  socket.onerror = () => {
    socketError = new Error("The authenticated socket transport failed.");
  };
  socket.onclose = (event) => {
    heartbeat?.stop();
    if (syncedThrough === null)
      socketError = new Error(
        `The protocol socket closed before ready (${event.code}).`,
      );
  };
  await waitFor(() => Boolean(hello), "socket hello", cloud ? 15_000 : 5000);
  heartbeat = startHeartbeat(socket, () => {
    socketError = new Error("The owned protocol socket heartbeat failed.");
    socket.terminate();
  });
  heartbeatStats = heartbeat.stats;
  checks.push(
    "existing authenticated socket received hello while resume stayed pending",
  );
  checks.push(
    "Mongo recipient head was fully stored by the Worker before API shutdown",
  );

  stage = "owned API shutdown";
  await stopOwnedApi(firstApi);
  apiDown = true;
  await requireApiUnavailable();
  assert.ok(
    Date.now() - helloAt < 9000,
    "Resume must remain within the ten-second handshake deadline.",
  );
  checks.push("only the harness-owned API stopped and REST became unreachable");

  stage = "SQLite replay while API is down";
  resumed = true;
  socket.send(JSON.stringify({ v: 1, type: "resume", afterSeq: cursor() }));
  await waitFor(
    () => syncedThrough !== null && syncedThrough >= targetSeq,
    "replay through stored message",
    cloud ? 180_000 : 20_000,
  );
  const cached = db
    .prepare("SELECT json FROM messages WHERE id=?")
    .get(sent.message.id);
  assert.ok(
    cached,
    "The known canonical message must arrive through Worker replay.",
  );
  assert.deepEqual(JSON.parse(cached.json), sent.message);
  assert.ok(committedBatchAcks > 0);
  assert.ok(cursor() >= targetSeq);
  await requireApiUnavailable();
  const committedCursor = cursor();
  checks.push(
    "existing socket replayed the canonical message while REST remained unreachable",
  );
  checks.push(
    "real SQLite event/entity/cursor transactions committed before every ACK",
  );
  heartbeat.stop();
  heartbeat = undefined;
  await closeSocket();

  stage = "owned API restart and idempotency";
  apiDown = false;
  const restartedApi = await startOwnedApi();
  const duplicate = await api(`/rooms/${group.room.id}/messages`, {
    token: sender.sessionToken,
    body: { clientMessageId, text },
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.message, sent.message);
  const history = await api(`/rooms/${group.room.id}/messages`, {
    token: sender.sessionToken,
  });
  assert.equal(
    history.messages.filter((message) => message.id === sent.message.id).length,
    1,
  );
  checks.push(
    "owned API restart retained the original message and same-key retry returned one duplicate",
  );
  await stopOwnedApi(restartedApi);
  await requireApiUnavailable();
  checks.push(
    "both harness-owned API processes stopped; port 3000 left free for the operator",
  );
  finalReport = {
    status: "passed",
    scenario: "S27",
    scope: cloud
      ? "real local NestJS + MongoDB replica set + deployed Cloudflare Durable Object + Node SQLite protocol harness; physical mobile testing remains separate"
      : "real local NestJS + MongoDB replica set + workerd + Node SQLite protocol harness; not native Flutter queue or real Cloudflare proof",
    ...(cloud ? { origin: deployment.origin, worker: deployment.worker } : {}),
    datasetId: env.DATASET_ID,
    runId,
    completedAt: new Date().toISOString(),
    roomId: group.room.id,
    messageId: sent.message.id,
    clientMessageId,
    targetSeq,
    committedCursor,
    committedBatchAcks,
    heartbeatStats,
    ownedApiPids: ownedProcesses.map((process) => process.pid),
    apiLeftRunning: false,
    checks,
  };
} catch {
  finalReport = {
    status: "failed",
    scenario: "S27",
    stage,
    runId,
    completedAt: new Date().toISOString(),
    apiLeftRunning: false,
    checks,
  };
  process.exitCode = 1;
  console.error(
    `API outage smoke failed during ${stage}. No raw transport or token details are printed.`,
  );
} finally {
  heartbeat?.stop();
  await closeSocket();
  for (const owned of ownedProcesses) await stopOwnedApi(owned);
  db?.close();
  if (log) await new Promise((resolve) => log.end(resolve));
  await mkdir(resolve(root, ".local"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, {
    mode: 0o600,
  });
}
if (finalReport.status === "passed")
  console.log(JSON.stringify(finalReport, null, 2));
