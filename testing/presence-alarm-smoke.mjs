throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** Local/cloud alarm-only lease measurement. Uses only two owned WebSockets.
 * The observer watches once, then sends heartbeats without refreshing presence.
 * This withholds application heartbeats; it does not cut a mobile network.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import WebSocket from "../nestjs/node_modules/ws/wrapper.mjs";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
import {
  validateCloudDeployment,
  validateTicketOrigin,
  startHeartbeat,
  closeOwnedSocket,
} from "./local-smoke.mjs";
import {
  DEFAULTS,
  isUuid,
  parseBatch,
  parsePresence,
} from "../shared/dist/index.js";

const componentRequire = createRequire(
  new URL("../cloudflare/package.json", import.meta.url),
);
const { SignJWT } = await import(
  pathToFileURL(componentRequire.resolve("jose")).href
);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--cloud"))
  throw new Error("Usage: node testing/presence-alarm-smoke.mjs [--cloud]");
const cloud = args.includes("--cloud");
let origin = "http://127.0.0.1:8787";
let measurementStarted = false;
const sourceId = "3";
const observerId = "2";
const timeoutMs = 130_000;
const directory = resolve(root, ".local");
const runDirectory = resolve(
  directory,
  cloud ? "cloud-presence-alarm" : "presence-alarm",
);
const reportFile = resolve(
  directory,
  cloud ? "cloud-presence-alarm-report.json" : "presence-alarm-report.json",
);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = {
  scope: cloud
    ? "real Cloudflare Durable Objects and two independent Node SQLite protocol clients; not physical or native mobile network-cut evidence"
    : "local workerd and Node SQLite; not native mobile or real Cloudflare",
  mode: cloud ? "cloud" : "local",
  simulation: "application heartbeat withholding; no actual mobile network cut",
  observationMechanism:
    "one initial offline watch snapshot, then pushed presence.changed only; no target queries or periodic snapshots during measurement",
  sourceId,
  observerId,
  timeoutMs,
  configuredLeaseMs: DEFAULTS.livenessLeaseMs,
  configuredSweepMs: DEFAULTS.presenceSweepMs,
  startedAt: new Date().toISOString(),
  result: "in-progress",
  phase: "configuration",
  observations: [],
};
const clients = [];

async function waitFor(predicate, limitMs, message) {
  const deadline = Date.now() + limitMs;
  while (!predicate() && Date.now() < deadline) {
    assert.ok(
      clients.every((client) => !client.failed && client.closeCode === null),
      "Owned sessions must remain healthy during the measurement.",
    );
    await sleep(25);
  }
  assert.ok(predicate(), message);
  assert.ok(
    clients.every((client) => !client.failed && client.closeCode === null),
    "Owned sessions must remain healthy through the measurement boundary.",
  );
}

async function connect(env, userId) {
  const deviceId = randomUUID();
  const sqliteFile = resolve(
    runDirectory,
    `${Date.now()}-${userId}-${deviceId}.sqlite`,
  );
  const db = new DatabaseSync(sqliteFile);
  db.exec(
    "CREATE TABLE cursor(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL); INSERT INTO cursor VALUES(1,0); CREATE TABLE events(seq INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL);",
  );
  const client = {
    userId,
    deviceId,
    sqliteFile,
    db,
    failed: false,
    closeCode: null,
    ready: false,
    resumeSentAt: null,
    replayTarget: null,
    snapshots: [],
    pongs: 0,
    heartbeat: null,
    sentControlFrames: 0,
    cursor: () => db.prepare("SELECT seq FROM cursor WHERE id=1").get().seq,
    send: (frame) => {
      assert.ok(
        !measurementStarted || userId !== sourceId,
        "The source must send no control frames during the alarm-only measurement.",
      );
      client.sentControlFrames++;
      client.socket.send(JSON.stringify({ v: 1, ...frame }));
    },
  };
  clients.push(client);
  let url;
  if (cloud) {
    const base = "http://127.0.0.1:3000/api/v1";
    const sessionResponse = await fetch(`${base}/dev/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, deviceId }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.datasetId, env.DATASET_ID);
    assert.equal(session.realtimeBaseUrl, origin);
    const ticketResponse = await fetch(`${base}/realtime/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(ticketResponse.status, 200);
    const ticket = await ticketResponse.json();
    assert.equal(ticket.datasetId, env.DATASET_ID);
    url = validateTicketOrigin(ticket.url, origin);
    url.searchParams.set("ticket", ticket.ticket);
  } else {
    const now = Math.floor(Date.now() / 1000);
    const ticket = await new SignJWT({
      deviceId,
      datasetId: env.DATASET_ID,
      sessionExp: now + DEFAULTS.sessionValiditySeconds,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("chat-poc-nestjs")
      .setAudience("chat-poc-realtime")
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(now + DEFAULTS.ticketValiditySeconds)
      .setJti(randomUUID())
      .sign(new TextEncoder().encode(env.WS_TICKET_SECRET));
    url = validateTicketOrigin(
      new URL("/v1/ws", origin.replace("http:", "ws:")).href,
    );
    url.searchParams.set("ticket", ticket);
  }
  client.socket = new WebSocket(url, {
    handshakeTimeout: 10_000,
    maxPayload: DEFAULTS.maxBatchBytes,
  });
  client.socket.addEventListener("error", () => {
    client.failed = true;
    client.heartbeat?.stop();
  });
  client.socket.addEventListener("close", (event) => {
    client.closeCode = event.code;
    client.heartbeat?.stop();
  });
  client.socket.addEventListener("message", (event) => {
    try {
      if (event.data === "pong") {
        assert.equal(userId, observerId, "Source must never request a pong.");
        client.pongs++;
        client.heartbeat?.pong();
        return;
      }
      const frame = JSON.parse(String(event.data));
      assert.equal(frame.v, 1);
      if (frame.type === "hello") {
        assert.equal(frame.datasetId, env.DATASET_ID);
        assert.equal(frame.userId, userId);
        assert.equal(frame.deviceId, deviceId);
        if (userId === observerId)
          client.heartbeat = startHeartbeat(client.socket, () => {
            client.failed = true;
          });
        client.resumeSentAt = Date.now();
        client.send({ type: "resume", afterSeq: 0 });
      } else if (frame.type === "sync.started") {
        assert.equal(frame.afterSeq, 0);
        assert.ok(Number.isSafeInteger(frame.targetSeq));
        client.replayTarget = frame.targetSeq;
      } else if (frame.type === "events.batch") {
        const batch = parseBatch(frame);
        db.exec("BEGIN");
        try {
          for (const item of batch.events) {
            assert.equal(item.datasetId, env.DATASET_ID);
            assert.equal(item.userId, userId);
            const json = JSON.stringify(item);
            if (item.streamSeq <= client.cursor()) {
              assert.equal(
                db
                  .prepare("SELECT json FROM events WHERE seq=?")
                  .get(item.streamSeq)?.json,
                json,
              );
              continue;
            }
            assert.equal(item.streamSeq, client.cursor() + 1);
            db.prepare(
              "INSERT INTO events(seq,event_id,json) VALUES(?,?,?)",
            ).run(item.streamSeq, item.eventId, json);
            db.prepare("UPDATE cursor SET seq=? WHERE id=1").run(
              item.streamSeq,
            );
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        // Application ACK follows the completed durable transaction.
        client.send({
          type: "ack",
          batchId: batch.batchId,
          throughSeq: batch.toSeq,
        });
      } else if (frame.type === "sync.ready") {
        assert.equal(frame.throughSeq, client.replayTarget);
        assert.ok(client.cursor() >= client.replayTarget);
        client.ready = true;
      } else if (frame.type === "presence.snapshot") {
        assert.equal(userId, observerId);
        client.snapshots.push(frame.items.map(parsePresence));
      } else if (frame.type === "presence.changed") {
        const item = parsePresence(frame.item);
        if (userId === observerId && item.userId === sourceId) {
          report.observations.push({ receivedAtMs: Date.now(), item });
        }
      } else {
        throw new Error("Unexpected local protocol frame.");
      }
    } catch {
      // Exception text may contain an upgrade URL, so retain no raw exception.
      client.failed = true;
    }
  });
  await waitFor(
    () => client.ready,
    cloud ? 180_000 : 20_000,
    "Replay must finish with SQLite ACKs.",
  );
  return client;
}

try {
  const env = await readEnvironment();
  assert.equal(env.APP_ENV, "development");
  assert.ok(isUuid(env.DATASET_ID));
  if (cloud) {
    const deployment = validateCloudDeployment(
      env,
      JSON.parse(
        await readFile(resolve(root, ".local/deployment.json"), "utf8"),
      ),
    );
    origin = deployment.origin;
    report.cloudDeployment = deployment;
  } else
    assert.ok(
      typeof env.WS_TICKET_SECRET === "string" &&
        Buffer.byteLength(env.WS_TICKET_SECRET) >= 32,
    );
  report.datasetId = env.DATASET_ID;
  await mkdir(runDirectory, { recursive: true });
  report.phase = "observer-resume";
  const observer = await connect(env, observerId);
  report.phase = "initial-offline-snapshot";
  observer.send({ type: "presence.watch", userIds: [sourceId] });
  await waitFor(
    () => observer.snapshots.length === 1,
    cloud ? 30_000 : 10_000,
    "The initial authoritative snapshot must arrive.",
  );
  assert.equal(observer.snapshots[0].length, 1);
  const initial = observer.snapshots[0][0];
  assert.equal(initial.userId, sourceId);
  assert.equal(
    initial.state,
    "offline",
    "User3 must initially have no active sessions.",
  );
  assert.equal(initial.activeDeviceCount, 0);
  assert.equal(initial.connectionCount, 0);
  report.initialPresence = initial;

  report.phase = "source-resume";
  const source = await connect(env, sourceId);
  await waitFor(
    () =>
      report.observations.some(
        ({ item }) =>
          item.state === "online" && item.revision > initial.revision,
      ),
    cloud ? 30_000 : 10_000,
    "Source online transition must arrive by push.",
  );
  const online = report.observations.find(
    ({ item }) => item.state === "online" && item.revision > initial.revision,
  ).item;
  assert.equal(
    online.activeDeviceCount,
    1,
    "Only the owned source device may qualify.",
  );
  assert.equal(online.connectionCount, 1);
  report.onlinePresence = online;
  report.resumeSentAt = new Date(source.resumeSentAt).toISOString();
  report.phase = "alarm-only-heartbeat-withholding";
  const sourceControlsBeforeMeasurement = source.sentControlFrames;
  measurementStarted = true;
  console.log(
    JSON.stringify({
      phase: report.phase,
      sourceId,
      observerId,
      configuredLeaseMs: DEFAULTS.livenessLeaseMs,
    }),
  );
  // No query, refresh, source ping, source close, or source control is sent here.
  await waitFor(
    () =>
      report.observations.some(
        ({ item }) =>
          item.state === "offline" && item.revision > online.revision,
      ),
    timeoutMs,
    "A pushed offline transition must arrive within 130 seconds.",
  );
  assert.equal(
    observer.snapshots.length,
    1,
    "No periodic snapshot may evaluate the source.",
  );
  assert.equal(source.pongs, 0);
  assert.equal(source.sentControlFrames, sourceControlsBeforeMeasurement);
  assert.ok(
    observer.pongs > 0,
    "The observing client must stay alive through real pongs.",
  );
  for (const { item } of report.observations) {
    assert.notEqual(item.state, "unknown");
    assert.ok(item.activeDeviceCount <= 1 && item.connectionCount <= 1);
  }
  const offline = report.observations.find(
    ({ item }) => item.state === "offline" && item.revision > online.revision,
  );
  assert.equal(offline.item.activeDeviceCount, 0);
  assert.equal(offline.item.connectionCount, 0);
  assert.ok(offline.item.revision > online.revision);
  const elapsedMs = offline.receivedAtMs - source.resumeSentAt;
  assert.ok(elapsedMs >= DEFAULTS.livenessLeaseMs);
  assert.equal(source.socket.readyState, WebSocket.OPEN);
  assert.equal(source.closeCode, null);
  report.offlineDelayMsSinceResume = elapsedMs;
  report.offlinePresence = offline.item;
  report.sourceSocketReadyStateAtOffline = source.socket.readyState;
  report.sourceCloseCodeBeforeCleanup = source.closeCode;
  report.observerPongs = observer.pongs;
  report.authoritativeTargetQueriesDuringMeasurement = 0;
  report.snapshotsDuringMeasurement = 0;
  report.sourceControlFramesDuringMeasurement =
    source.sentControlFrames - sourceControlsBeforeMeasurement;
  report.result = "passed";
} catch {
  report.result = "failed";
  report.failureCode = "PRESENCE_ALARM_MEASUREMENT_FAILED";
  process.exitCode = 1;
} finally {
  report.clients = [];
  for (const client of clients) {
    client.heartbeat?.stop();
    const closeCodeBeforeCleanup = client.closeCode;
    const forcedClose = await closeOwnedSocket(client.socket, {
      timeoutMs: 2000,
    });
    if (forcedClose && report.result === "passed") {
      report.result = "failed";
      report.failureCode = "OWNED_SOCKET_CLOSE_TIMEOUT";
      process.exitCode = 1;
    }
    report.clients.push({
      userId: client.userId,
      deviceId: client.deviceId,
      sqliteFile: client.sqliteFile,
      lastCommittedSeq: client.cursor(),
      committedEventCount: client.db
        .prepare("SELECT COUNT(*) AS n FROM events")
        .get().n,
      closeCodeBeforeCleanup,
      closeCodeAfterCleanup: client.closeCode,
      forcedClose,
    });
    client.db.close();
  }
  report.completedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      result: report.result,
      phase: report.phase,
      offlineDelayMsSinceResume: report.offlineDelayMsSinceResume ?? null,
      reportFile,
    }),
  );
}
