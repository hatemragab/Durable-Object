throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** Local workerd lease measurement. No NestJS dependency or network manipulation.
 * Withhold application heartbeats on this harness's own socket, then cleanly close it.
 * This does not simulate an actual mobile network cut or prove Cloudflare behavior.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
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
const origin = "http://127.0.0.1:8787";
const userId = "3";
const pollIntervalMs = 2_000;
const timeoutMs = 130_000;
const directory = resolve(root, ".local");
const reportFile = resolve(directory, "presence-lease-report.json");
const report = {
  scope:
    "local workerd, one owned User3 WebSocket and Node SQLite; not native mobile or real Cloudflare",
  simulation:
    "application heartbeat deliberately withheld; no actual mobile network cut",
  observationMechanism:
    "authenticated authoritative presence query every 2 seconds; queries can discover lease expiry before an alarm sweep",
  userId,
  pollIntervalMs,
  timeoutMs,
  configuredLeaseMs: DEFAULTS.livenessLeaseMs,
  configuredSweepMs: DEFAULTS.presenceSweepMs,
  startedAt: new Date().toISOString(),
  result: "in-progress",
  samples: [],
};
let socket;
let database;
let socketFailure = false;
let closeCode = null;
let resumeSentAt;
let ready = false;
let replayTarget;
let lastPresence;
let settledMeasurement = false;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cursor = () =>
  database.prepare("SELECT seq FROM cursor WHERE id=1").get().seq;

async function queryPresence(env) {
  const response = await fetch(`${origin}/internal/v1/presence/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.REALTIME_INTERNAL_SECRET}`,
      "x-dataset-id": env.DATASET_ID,
      "content-type": "application/json",
    },
    body: JSON.stringify({ userIds: [userId] }),
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  assert.equal(response.status, 200, "Local presence query must succeed.");
  const body = await response.json();
  assert.equal(
    body.datasetId,
    env.DATASET_ID,
    "Local Worker dataset must match.",
  );
  assert.equal(body.items?.length, 1, "Presence query must return one source.");
  const item = parsePresence(body.items[0]);
  assert.equal(item.userId, userId, "Presence source must match User3.");
  assert.notEqual(
    item.state,
    "unknown",
    "Unknown is not an offline observation.",
  );
  lastPresence = item;
  return item;
}

function receive(raw, env, deviceId) {
  // This client intentionally never sends ping. A server pong here is unexpected.
  assert.notEqual(raw, "pong", "No application heartbeat was requested.");
  const frame = JSON.parse(String(raw));
  assert.equal(frame.v, 1, "Protocol version must be 1.");
  if (frame.type === "hello") {
    assert.equal(frame.datasetId, env.DATASET_ID);
    assert.equal(frame.userId, userId);
    assert.equal(frame.deviceId, deviceId);
    report.headSeqAtHello = frame.headSeq;
    resumeSentAt = Date.now();
    socket.send(JSON.stringify({ v: 1, type: "resume", afterSeq: cursor() }));
  } else if (frame.type === "sync.started") {
    assert.equal(frame.afterSeq, 0);
    assert.ok(Number.isSafeInteger(frame.targetSeq));
    replayTarget = frame.targetSeq;
  } else if (frame.type === "events.batch") {
    const batch = parseBatch(frame);
    database.exec("BEGIN");
    try {
      for (const event of batch.events) {
        assert.equal(event.datasetId, env.DATASET_ID);
        assert.equal(event.userId, userId);
        const json = JSON.stringify(event);
        if (event.streamSeq <= cursor()) {
          const stored = database
            .prepare("SELECT json FROM events WHERE seq=?")
            .get(event.streamSeq);
          assert.equal(
            stored?.json,
            json,
            "Duplicate event content must match committed bytes.",
          );
          continue;
        }
        assert.equal(
          event.streamSeq,
          cursor() + 1,
          "Replay must be contiguous.",
        );
        database
          .prepare("INSERT INTO events(seq,event_id,json) VALUES(?,?,?)")
          .run(event.streamSeq, event.eventId, json);
        database
          .prepare("UPDATE cursor SET seq=? WHERE id=1")
          .run(event.streamSeq);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    // Durable SQLite transaction completes before ACK; ACK does not renew the heartbeat lease.
    socket.send(
      JSON.stringify({
        v: 1,
        type: "ack",
        batchId: batch.batchId,
        throughSeq: batch.toSeq,
      }),
    );
  } else if (frame.type === "sync.ready") {
    assert.equal(frame.throughSeq, replayTarget);
    assert.ok(cursor() >= replayTarget);
    ready = true;
  } else if (frame.type === "error") {
    throw new Error("Local Worker rejected the owned test session.");
  }
}

try {
  const env = await readEnvironment();
  assert.equal(
    env.APP_ENV,
    "development",
    "Only the development dataset is authorized.",
  );
  assert.ok(isUuid(env.DATASET_ID), "A configured dataset UUID is required.");
  for (const key of ["WS_TICKET_SECRET", "REALTIME_INTERNAL_SECRET"]) {
    assert.ok(
      typeof env[key] === "string" && Buffer.byteLength(env[key]) >= 32,
      "Local runtime secrets must be configured.",
    );
  }
  report.datasetId = env.DATASET_ID;
  const initial = await queryPresence(env);
  report.initialPresence = initial;
  assert.equal(
    initial.state,
    "offline",
    "User3 must have no active sessions before this test.",
  );
  assert.equal(initial.activeDeviceCount, 0);
  assert.equal(initial.connectionCount, 0);

  await mkdir(resolve(directory, "presence-lease"), { recursive: true });
  const deviceId = randomUUID();
  report.deviceId = deviceId;
  const sqliteFile = resolve(
    directory,
    "presence-lease",
    `${Date.now()}-${deviceId}.sqlite`,
  );
  database = new DatabaseSync(sqliteFile);
  database.exec(
    "CREATE TABLE cursor(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL); INSERT INTO cursor VALUES(1,0); CREATE TABLE events(seq INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL);",
  );
  report.sqliteFile = sqliteFile;
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
  const url = new URL("/v1/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("ticket", ticket);
  socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    try {
      receive(event.data, env, deviceId);
    } catch {
      socketFailure = true;
    }
  });
  socket.addEventListener("error", () => {
    socketFailure = true;
  });
  socket.addEventListener("close", (event) => {
    closeCode = event.code;
  });

  const connectDeadline = Date.now() + 20_000;
  while (
    !ready &&
    !socketFailure &&
    closeCode === null &&
    Date.now() < connectDeadline
  )
    await sleep(25);
  assert.ok(
    ready && !socketFailure && closeCode === null,
    "Owned socket must resume and commit its backlog.",
  );
  const online = await queryPresence(env);
  assert.equal(online.state, "online");
  assert.equal(
    online.activeDeviceCount,
    1,
    "Only this test device may qualify.",
  );
  assert.equal(online.connectionCount, 1);
  report.resumeSentAt = new Date(resumeSentAt).toISOString();
  report.initialOnlinePresence = online;
  console.log(
    JSON.stringify({
      phase: "measuring-no-heartbeat-lease",
      userId,
      resumeSentAt: report.resumeSentAt,
      configuredLeaseMs: DEFAULTS.livenessLeaseMs,
    }),
  );

  while (Date.now() - resumeSentAt <= timeoutMs) {
    await sleep(pollIntervalMs);
    assert.ok(
      !socketFailure && closeCode === null,
      "Socket must remain open during the no-heartbeat measurement.",
    );
    const presence = await queryPresence(env);
    const elapsedMs = Date.now() - resumeSentAt;
    report.samples.push({
      elapsedMs,
      state: presence.state,
      activeDeviceCount: presence.activeDeviceCount,
      connectionCount: presence.connectionCount,
      observedAt: presence.observedAt,
    });
    assert.ok(
      presence.activeDeviceCount <= 1 && presence.connectionCount <= 1,
      "Another User3 device would invalidate this isolated measurement.",
    );
    if (presence.state === "offline") {
      assert.equal(presence.activeDeviceCount, 0);
      assert.equal(presence.connectionCount, 0);
      assert.ok(
        elapsedMs >= DEFAULTS.livenessLeaseMs,
        "Lease must not expire before its configured duration.",
      );
      report.offlineDelayMsSinceResume = elapsedMs;
      report.offlinePresence = presence;
      report.socketReadyStateAtOffline = socket.readyState;
      report.closeCodeBeforeCleanup = closeCode;
      assert.equal(socket.readyState, WebSocket.OPEN);
      report.result = "passed";
      settledMeasurement = true;
      break;
    }
  }
  assert.ok(
    settledMeasurement,
    "Offline transition must be observed within 130 seconds.",
  );
} catch {
  // Never echo an exception that might include a URL containing an upgrade ticket.
  report.result = "failed";
  report.failureCode = "PRESENCE_LEASE_MEASUREMENT_FAILED";
  report.lastPresence = lastPresence ?? null;
  process.exitCode = 1;
} finally {
  report.closeCodeBeforeCleanup ??= closeCode;
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    report.cleanupCloseInitiatedAt = new Date().toISOString();
    const closed = new Promise((done) =>
      socket.addEventListener("close", done, { once: true }),
    );
    try {
      socket.close(1000, "owned lease harness cleanup");
    } catch {
      /* Already closing. */
    }
    await Promise.race([closed, sleep(2_000)]);
  }
  report.closeCodeAfterCleanup = closeCode;
  if (database) {
    report.lastCommittedSeq = cursor();
    report.committedEventCount = database
      .prepare("SELECT COUNT(*) AS n FROM events")
      .get().n;
    database.close();
  }
  report.completedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      result: report.result,
      userId,
      offlineDelayMsSinceResume: report.offlineDelayMsSinceResume ?? null,
      lastCommittedSeq: report.lastCommittedSeq ?? null,
      closeCodeBeforeCleanup: report.closeCodeBeforeCleanup,
      closeCodeAfterCleanup: report.closeCodeAfterCleanup,
      reportFile,
    }),
  );
}
