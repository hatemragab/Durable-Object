throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** Bounded real-cloud transport probes against a previously verified demo deployment.
 * No message writes or durable event appends. Owned devices commit replay to SQLite
 * before ACK. Idle-socket survival is observable; actual DO hibernation is not.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
import { DEFAULTS, isUuid, parseBatch } from "../shared/dist/index.js";

const cfRequire = createRequire(
  new URL("../cloudflare/package.json", import.meta.url),
);
const apiRequire = createRequire(
  new URL("../nestjs/package.json", import.meta.url),
);
const { SignJWT } = await import(pathToFileURL(cfRequire.resolve("jose")).href);
const { WebSocket } = apiRequire("ws");
const maxReplayEvents = 2_000;
const idleMs = 35_000;
const probeTimeoutMs = 180_000;
const cleanupGraceMs = 3_000;
const startedMs = Date.now();
const directory = resolve(
  root,
  ".local/cloud-transport",
  `${startedMs}-${randomUUID()}`,
);
const reportFile = resolve(root, ".local/cloud-transport-report.json");
const clients = [];
const report = {
  scope:
    "real Cloudflare Worker HTTPS/WSS and owned Node SQLite clients; no native mobile test",
  startedAt: new Date(startedMs).toISOString(),
  result: "in-progress",
  phase: "deployment-guard",
  bounds: {
    maxReplayEventsPerConnection: maxReplayEvents,
    maxHttpRequests: 12,
    maxWebSocketAttempts: 12,
    idleMs,
    probeTimeoutMs,
    cleanupGraceMs,
  },
  httpRequests: 0,
  webSocketAttempts: 0,
  checks: [],
  credentialBoundary: {
    managementTokenTransmitted: false,
    negativeMarker:
      "Invented non-secret marker; this is not an actual management-token test.",
  },
};
let env;
let origin;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function ensure(condition, code) {
  if (!condition) throw new ProbeFailure(code);
}
function passed(name, evidence = {}) {
  report.checks.push({ name, result: "passed", ...evidence });
  console.log(
    JSON.stringify({ phase: name, checksPassed: report.checks.length }),
  );
}
function remainingMs(limit) {
  const remaining = startedMs + probeTimeoutMs - Date.now();
  ensure(remaining > 0, "PROBE_DEADLINE_EXCEEDED");
  return Math.min(limit, remaining);
}
async function waitFor(predicate, timeoutMs, code) {
  const deadline = Date.now() + remainingMs(timeoutMs);
  while (!predicate()) {
    ensure(Date.now() < deadline, code);
    const broken = clients.find((client) => client.failure);
    ensure(!broken, broken?.failure ?? "SOCKET_FAILED");
    await sleep(20);
  }
}
function internalHeaders(
  secret = env.REALTIME_INTERNAL_SECRET,
  dataset = env.DATASET_ID,
) {
  return { authorization: `Bearer ${secret}`, "x-dataset-id": dataset };
}
async function http(path, headers = {}) {
  ensure(
    ++report.httpRequests <= report.bounds.maxHttpRequests,
    "HTTP_PROBE_LIMIT",
  );
  const response = await fetch(new URL(path, origin), {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(remainingMs(10_000)),
  });
  const body = await response.text();
  ensure(
    Buffer.byteLength(body) <= DEFAULTS.maxBatchBytes,
    "HTTP_RESPONSE_LIMIT",
  );
  return { status: response.status, body: body ? JSON.parse(body) : null };
}
function checkStream(response) {
  ensure(
    response.status === 200 &&
      response.body?.datasetId === env.DATASET_ID &&
      response.body?.userId === "1",
    "STREAM_IDENTITY",
  );
  const { headSeq, retainedFromSeq, eventCount } = response.body;
  ensure(
    Number.isSafeInteger(headSeq) && headSeq >= 0 && headSeq <= maxReplayEvents,
    "REPLAY_PROBE_LIMIT",
  );
  ensure(
    retainedFromSeq === 1 && eventCount === headSeq,
    "RETAINED_STREAM_INTEGRITY",
  );
  return headSeq;
}
async function ticket(
  userId,
  deviceId,
  {
    datasetId = env.DATASET_ID,
    sessionSeconds = DEFAULTS.sessionValiditySeconds,
    issuedAt = Math.floor(Date.now() / 1000),
    expiresAt,
    secret = env.WS_TICKET_SECRET,
    audience = "chat-poc-realtime",
  } = {},
) {
  const sessionExp = Math.floor(Date.now() / 1000) + sessionSeconds;
  return new SignJWT({ deviceId, datasetId, sessionExp })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("chat-poc-nestjs")
    .setAudience(audience)
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(
      expiresAt ??
        Math.min(issuedAt + DEFAULTS.ticketValiditySeconds, sessionExp),
    )
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(secret));
}
function socketUrl(signedTicket) {
  ensure(
    ++report.webSocketAttempts <= report.bounds.maxWebSocketAttempts,
    "WEBSOCKET_PROBE_LIMIT",
  );
  const url = new URL("/v1/ws", origin);
  url.protocol = "wss:";
  url.searchParams.set("ticket", signedTicket);
  return url;
}
async function rejectedTicket(name, signedTicket) {
  await new Promise((done, reject) => {
    const timeoutBudget = remainingMs(12_000);
    const socket = new WebSocket(socketUrl(signedTicket), {
      handshakeTimeout: Math.min(10_000, timeoutBudget),
      followRedirects: false,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else done();
    };
    const timer = setTimeout(
      () => finish(new ProbeFailure("REJECTED_TICKET_TIMEOUT")),
      timeoutBudget,
    );
    socket.on("error", () => {
      if (!settled) finish(new ProbeFailure("REJECTED_TICKET_TRANSPORT"));
    });
    socket.on("open", () =>
      finish(new ProbeFailure("INVALID_TICKET_ACCEPTED")),
    );
    socket.on("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > DEFAULTS.maxControlBytes)
          finish(new ProbeFailure("REJECTED_TICKET_BODY_LIMIT"));
      });
      response.on("error", () =>
        finish(new ProbeFailure("REJECTED_TICKET_RESPONSE")),
      );
      response.on("end", () => {
        try {
          ensure(
            response.statusCode === 401 &&
              JSON.parse(body).error?.code === "UNAUTHORIZED",
            "INVALID_TICKET_STATUS",
          );
          finish();
        } catch {
          finish(new ProbeFailure("INVALID_TICKET_STATUS"));
        }
      });
    });
  });
  passed(name, { httpStatus: 401 });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const fingerprint = (value) => JSON.stringify(canonical(value));
function applyBatch(client, frame) {
  const batch = parseBatch(frame);
  ensure(batch.toSeq <= maxReplayEvents, "REPLAY_PROBE_LIMIT");
  const db = client.db;
  db.exec("BEGIN");
  try {
    for (const event of batch.events) {
      ensure(
        event.datasetId === env.DATASET_ID && event.userId === client.userId,
        "EVENT_IDENTITY",
      );
      const json = JSON.stringify(event);
      const existing = db
        .prepare("SELECT json FROM events WHERE seq=?")
        .get(event.streamSeq);
      if (existing) {
        ensure(
          existing.json === json && event.streamSeq <= client.cursor(),
          "CONFLICTING_REPLAY",
        );
        continue;
      }
      ensure(event.streamSeq === client.cursor() + 1, "REPLAY_SEQUENCE_GAP");
      const room = event.data.room;
      const previousRoom = db
        .prepare("SELECT version,json FROM rooms WHERE id=?")
        .get(room.id);
      if (previousRoom?.version === room.version)
        ensure(
          fingerprint(JSON.parse(previousRoom.json)) === fingerprint(room),
          "ROOM_VERSION_CONFLICT",
        );
      if (!previousRoom || previousRoom.version < room.version)
        db.prepare(
          "INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,json=excluded.json",
        ).run(room.id, room.version, JSON.stringify(room));
      if (event.type === "message.created") {
        const message = event.data.message;
        const existingMessages = db
          .prepare(
            "SELECT json FROM messages WHERE id=? OR (sender_id=? AND client_id=?)",
          )
          .all(message.id, message.senderId, message.clientMessageId);
        ensure(
          existingMessages.every(
            (row) => fingerprint(JSON.parse(row.json)) === fingerprint(message),
          ),
          "MESSAGE_IDENTITY_CONFLICT",
        );
        db.prepare("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?)").run(
          message.id,
          message.senderId,
          message.clientMessageId,
          message.roomSeq,
          JSON.stringify(message),
        );
      }
      db.prepare("INSERT INTO events VALUES(?,?,?)").run(
        event.streamSeq,
        event.eventId,
        json,
      );
      db.prepare("UPDATE cursor SET seq=? WHERE id=1").run(event.streamSeq);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  client.batches++;
  const current = JSON.stringify(batch);
  if (client.holdFirstAck && !client.heldBatch) {
    client.heldBatch = current;
    client.heldBatchAt = Date.now();
    return;
  }
  if (client.heldBatch && !client.retransmission) {
    ensure(current === client.heldBatch, "RETRANSMISSION_CHANGED_BATCH");
    client.retransmission = {
      delayMs: Date.now() - client.heldBatchAt,
      fromSeq: batch.fromSeq,
      toSeq: batch.toSeq,
    };
    ensure(
      client.retransmission.delayMs >= DEFAULTS.ackTimeoutMs - 1_000,
      "EARLY_RETRANSMISSION",
    );
  }
  // Entity/cursor transaction is durable before this ACK is transmitted.
  client.send({ type: "ack", batchId: batch.batchId, throughSeq: batch.toSeq });
  client.acks++;
}
async function connect({
  name,
  userId = "1",
  deviceId = randomUUID(),
  replay = false,
  holdFirstAck = false,
  sessionSeconds,
  forgedHeaders = false,
}) {
  const signedTicket = await ticket(userId, deviceId, {
    ...(sessionSeconds ? { sessionSeconds } : {}),
  });
  const client = {
    name,
    userId,
    deviceId,
    hello: null,
    ready: false,
    closeCode: null,
    closeReceivedAt: null,
    failure: null,
    batches: 0,
    acks: 0,
    pongs: 0,
    controlsSent: 0,
    holdFirstAck,
    receivedFrames: 0,
    errors: [],
    replayTarget: null,
    sqliteFile: null,
    db: null,
    send(frame) {
      ensure(
        this.socket.readyState === WebSocket.OPEN,
        "SEND_ON_CLOSED_SOCKET",
      );
      this.controlsSent++;
      this.socket.send(JSON.stringify({ v: 1, ...frame }));
    },
    cursor() {
      return this.db.prepare("SELECT seq FROM cursor WHERE id=1").get().seq;
    },
  };
  if (replay) {
    client.sqliteFile = resolve(directory, `${name}-${deviceId}.sqlite`);
    client.db = new DatabaseSync(client.sqliteFile);
    client.db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE cursor(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL); INSERT INTO cursor VALUES(1,0); CREATE TABLE events(seq INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL); CREATE TABLE rooms(id TEXT PRIMARY KEY,version INTEGER NOT NULL,json TEXT NOT NULL); CREATE TABLE messages(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,client_id TEXT NOT NULL,room_seq INTEGER NOT NULL,json TEXT NOT NULL,UNIQUE(sender_id,client_id));",
    );
    await chmod(client.sqliteFile, 0o600);
  }
  clients.push(client);
  client.socket = new WebSocket(socketUrl(signedTicket), {
    handshakeTimeout: remainingMs(10_000),
    followRedirects: false,
    maxPayload: DEFAULTS.maxBatchBytes,
    ...(forgedHeaders
      ? { headers: { "x-poc-user": "3", "x-poc-dataset": randomUUID() } }
      : {}),
  });
  client.socket.on("error", () => {
    client.failure = "SOCKET_TRANSPORT_ERROR";
  });
  client.socket.on("unexpected-response", (_request, response) => {
    response.resume();
    client.failure = "VALID_TICKET_REJECTED";
    client.socket.terminate();
  });
  client.socket.on("close", (code) => {
    client.closeCode = code;
    client.closeReceivedAt = Date.now();
  });
  client.socket.on("message", (data, isBinary) => {
    try {
      ensure(!isBinary, "BINARY_SERVER_FRAME");
      const raw = data.toString("utf8");
      if (raw === "pong") {
        client.pongs++;
        return;
      }
      const frame = JSON.parse(raw);
      ensure(frame.v === 1, "SERVER_PROTOCOL_VERSION");
      client.receivedFrames++;
      if (frame.type === "hello") {
        ensure(
          !client.hello &&
            frame.datasetId === env.DATASET_ID &&
            frame.userId === userId &&
            frame.deviceId === deviceId &&
            isUuid(frame.connectionId),
          "HELLO_IDENTITY",
        );
        ensure(
          Number.isSafeInteger(frame.headSeq) &&
            frame.headSeq >= 0 &&
            frame.headSeq <= maxReplayEvents &&
            frame.retainedFromSeq === 1,
          "REPLAY_PROBE_LIMIT",
        );
        client.hello = frame;
        if (replay) client.send({ type: "resume", afterSeq: client.cursor() });
      } else if (frame.type === "sync.started") {
        ensure(
          replay &&
            frame.afterSeq === 0 &&
            Number.isSafeInteger(frame.targetSeq) &&
            frame.targetSeq >= client.hello.headSeq &&
            frame.targetSeq <= maxReplayEvents,
          "RESUME_BOUNDARY",
        );
        client.replayTarget = frame.targetSeq;
      } else if (frame.type === "events.batch") {
        ensure(
          replay && client.replayTarget !== null,
          "UNEXPECTED_EVENT_BATCH",
        );
        applyBatch(client, frame);
      } else if (frame.type === "sync.ready") {
        ensure(
          replay &&
            frame.throughSeq === client.replayTarget &&
            client.cursor() >= frame.throughSeq,
          "READY_BEFORE_COMMIT",
        );
        client.ready = true;
      } else if (frame.type === "error") client.errors.push(frame.code);
      else throw new ProbeFailure("UNEXPECTED_SERVER_FRAME");
    } catch (error) {
      client.failure =
        error instanceof ProbeFailure ? error.code : "INVALID_SERVER_FRAME";
    }
  });
  await waitFor(
    () => client.hello !== null || client.closeCode !== null,
    12_000,
    "HELLO_TIMEOUT",
  );
  ensure(
    client.hello !== null && client.closeCode === null,
    "HELLO_NOT_ACCEPTED",
  );
  if (replay) {
    await waitFor(
      () => client.ready || client.closeCode !== null,
      60_000,
      "REPLAY_TIMEOUT",
    );
    ensure(client.ready && client.closeCode === null, "REPLAY_CLOSED");
    ensure(client.cursor() >= client.hello.headSeq, "REPLAY_INCOMPLETE");
  }
  return client;
}
async function ping(client) {
  const before = client.pongs;
  const sentAt = Date.now();
  ensure(
    client.socket.readyState === WebSocket.OPEN,
    "HEARTBEAT_SOCKET_CLOSED",
  );
  client.controlsSent++;
  client.socket.send("ping");
  await waitFor(
    () => client.pongs > before,
    DEFAULTS.heartbeatTimeoutMs,
    "PONG_TIMEOUT",
  );
  return Date.now() - sentAt;
}
async function expectClose(client, code, timeoutMs = 12_000) {
  await waitFor(() => client.closeCode !== null, timeoutMs, "CLOSE_TIMEOUT");
  ensure(client.closeCode === code, "UNEXPECTED_CLOSE_CODE");
}

try {
  // Retain the correction only when the preceding local receipt records that
  // initial boundary mistake. Never copy any credential or authorization value.
  const previous = await readFile(reportFile, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (
    previous?.checks?.some(
      (check) => check.name === "management-token-denied-runtime",
    )
  )
    report.credentialBoundary.priorAttemptCorrection = {
      startedAt: previous.startedAt,
      issue:
        "The initial attempt sent a real management bearer once as a negative runtime probe. It was rejected with401; no raw credential was written to these reports.",
      correction:
        "Removed that request and credential requirement. This run sends only an invented non-secret marker; no credential rotation or account-setting change was made.",
    };
  env = await readEnvironment();
  const deployment = JSON.parse(
    await readFile(resolve(root, ".local/deployment.json"), "utf8"),
  );
  ensure(
    env.APP_ENV === "development" &&
      env.CLOUDFLARE_ENVIRONMENT === "development" &&
      isUuid(env.DATASET_ID),
    "DEVELOPMENT_CONFIG_REQUIRED",
  );
  ensure(
    deployment.worker === env.CLOUDFLARE_WORKER_NAME &&
      deployment.environment === "development" &&
      deployment.datasetId === env.DATASET_ID,
    "DEPLOYMENT_CONFIG_MISMATCH",
  );
  const actual = new URL(deployment.origin);
  ensure(
    actual.protocol === "https:" &&
      actual.hostname.endsWith(".workers.dev") &&
      actual.hostname.startsWith(`${env.CLOUDFLARE_WORKER_NAME}.`) &&
      actual.origin === deployment.origin &&
      actual.pathname === "/" &&
      !actual.port &&
      !actual.username &&
      !actual.password &&
      !actual.search &&
      !actual.hash,
    "VERIFIED_CLOUD_ORIGIN_REQUIRED",
  );
  ensure(env.REALTIME_BASE_URL === actual.origin, "REALTIME_ORIGIN_MISMATCH");
  ensure(
    Number.isFinite(Date.parse(deployment.verifiedAt)) &&
      Date.parse(deployment.verifiedAt) <= Date.now() + 5_000 &&
      Date.now() - Date.parse(deployment.verifiedAt) < 86_400_000,
    "RECENT_DEPLOYMENT_REQUIRED",
  );
  for (const check of [
    "health",
    "authenticated-stream",
    "missing-key-negative",
    "ticket-socket-hello",
  ])
    ensure(
      deployment.checks?.includes(check),
      "SUCCESSFUL_DEPLOYMENT_REQUIRED",
    );
  for (const key of [
    "WS_TICKET_SECRET",
    "REALTIME_INTERNAL_SECRET",
    "DEV_SESSION_SECRET",
  ])
    ensure(
      typeof env[key] === "string" && Buffer.byteLength(env[key]) >= 32,
      "CONFIGURED_CREDENTIALS_REQUIRED",
    );
  origin = actual.origin;
  report.origin = origin;
  report.worker = deployment.worker;
  report.datasetId = env.DATASET_ID;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  report.phase = "runtime-http-security";
  const health = await http("/health");
  ensure(
    health.status === 200 &&
      health.body?.service === "chat-poc-realtime" &&
      health.body?.protocolVersion === 1 &&
      health.body?.development === true,
    "CLOUD_HEALTH_FAILED",
  );
  passed("cloud-health");
  for (const [name, headers] of [
    ["missing-internal-key", {}],
    ["incorrect-internal-key", internalHeaders("not-a-valid-integration-key")],
    [
      "invented-management-marker-denied-runtime",
      internalHeaders("invented-non-secret-management-marker"),
    ],
    [
      "api-session-denied-runtime",
      internalHeaders(
        await ticket("1", randomUUID(), {
          secret: env.DEV_SESSION_SECRET,
          audience: "chat-poc-api",
        }),
      ),
    ],
  ]) {
    const response = await http("/internal/v1/users/1/stream", headers);
    ensure(
      response.status === 401 && response.body?.error?.code === "UNAUTHORIZED",
      "RUNTIME_AUTHORIZATION_FAILED",
    );
    passed(name, { httpStatus: 401 });
  }
  const wrongDataset = await http(
    "/internal/v1/users/1/stream",
    internalHeaders(env.REALTIME_INTERNAL_SECRET, randomUUID()),
  );
  ensure(
    wrongDataset.status === 409 &&
      wrongDataset.body?.error?.code === "DATASET_MISMATCH",
    "DATASET_AUTHORIZATION_FAILED",
  );
  passed("incorrect-internal-dataset", { httpStatus: 409 });
  report.initialHeadSeq = checkStream(
    await http("/internal/v1/users/1/stream", internalHeaders()),
  );
  ensure(report.initialHeadSeq > 0, "RETAINED_MONGO_HISTORY_REQUIRED");

  report.phase = "ticket-security";
  const issuedAt = Math.floor(Date.now() / 1000);
  const good = await ticket("1", randomUUID());
  const parts = good.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  for (const [name, value] of [
    ["malformed-ticket", "not-a-jwt"],
    ["tampered-ticket", parts.join(".")],
    [
      "expired-ticket",
      await ticket("1", randomUUID(), {
        issuedAt: issuedAt - 120,
        expiresAt: issuedAt - 60,
      }),
    ],
    [
      "wrong-dataset-ticket",
      await ticket("1", randomUUID(), { datasetId: randomUUID() }),
    ],
    [
      "api-session-denied-as-ticket",
      await ticket("1", randomUUID(), {
        secret: env.DEV_SESSION_SECRET,
        audience: "chat-poc-api",
      }),
    ],
  ])
    await rejectedTicket(name, value);

  report.phase = "durable-replay-and-retransmission";
  const first = await connect({
    name: "first",
    replay: true,
    holdFirstAck: true,
    forgedHeaders: true,
  });
  ensure(first.retransmission !== undefined, "RETRANSMISSION_NOT_OBSERVED");
  passed("sqlite-before-ack-and-identical-retransmission", {
    committedThroughSeq: first.cursor(),
    batches: first.batches,
    retransmission: first.retransmission,
    forgedRoutingHeadersIgnored: true,
  });
  const other = await connect({ name: "independent", replay: true });
  passed("independent-device-replay", { committedThroughSeq: other.cursor() });
  report.phase = "same-device-replacement";
  const replacement = await connect({
    name: "replacement",
    deviceId: first.deviceId,
    replay: true,
  });
  await expectClose(first, 4009);
  await ping(other);
  passed("same-device-replaced-other-device-survives", {
    replacedCloseCode: first.closeCode,
    replacementReplayedFrom: 0,
    replacementThroughSeq: replacement.cursor(),
    independentConnectionId: other.hello.connectionId,
  });

  report.phase = "protocol-close-boundaries";
  const binary = await connect({ name: "binary" });
  binary.socket.send(Buffer.from([0, 1, 2]));
  await expectClose(binary, 4002);
  ensure(
    binary.errors.includes("VALIDATION_ERROR"),
    "BINARY_ERROR_FRAME_MISSING",
  );
  passed("binary-control-rejected", { closeCode: binary.closeCode });
  const oversized = await connect({ name: "oversized" });
  oversized.socket.send("x".repeat(DEFAULTS.maxControlBytes + 1));
  await expectClose(oversized, 1009);
  ensure(
    oversized.errors.includes("FRAME_TOO_LARGE"),
    "OVERSIZED_ERROR_FRAME_MISSING",
  );
  passed("oversized-control-rejected", { closeCode: oversized.closeCode });

  report.phase = "session-expiry-and-idle-socket";
  const expires = await connect({
    name: "session-expiry",
    userId: "2",
    sessionSeconds: 8,
  });
  const expiryAt = Date.parse(expires.hello.sessionExpiresAt);
  // No resume: authorization expires before the 10-second resume deadline.
  await expectClose(expires, 4001, 15_000);
  ensure(
    expires.closeReceivedAt >= expiryAt - DEFAULTS.clockSkewSeconds * 1000,
    "SESSION_EXPIRED_TOO_EARLY",
  );
  passed("application-session-expiry", {
    closeCode: expires.closeCode,
    mode: "awaiting-resume",
    closeDelayMsFromAuthorizationExpiry: expires.closeReceivedAt - expiryAt,
  });
  await ping(replacement);
  await ping(other);
  const idleStarted = Date.now();
  const before = {
    controls: replacement.controlsSent,
    frames: replacement.receivedFrames,
    cursor: replacement.cursor(),
  };
  await waitFor(
    () => Date.now() - idleStarted >= idleMs,
    idleMs + 5_000,
    "IDLE_OBSERVATION_TIMEOUT",
  );
  ensure(
    replacement.socket.readyState === WebSocket.OPEN &&
      replacement.closeCode === null,
    "IDLE_SOCKET_CLOSED",
  );
  const idleEvidence = {
    elapsedMs: Date.now() - idleStarted,
    connectionId: replacement.hello.connectionId,
    controlsSentDuringInterval: replacement.controlsSent - before.controls,
    receivedFramesDuringInterval: replacement.receivedFrames - before.frames,
    cursorBefore: before.cursor,
    cursorAfter: replacement.cursor(),
    observedTransportOpen: true,
    actualHibernationObserved: false,
    limitation:
      "Constructor re-entry is not exposed by this protocol. Central alarms may wake the object; idle transport survival does not prove hibernation.",
  };
  ensure(
    idleEvidence.controlsSentDuringInterval === 0 &&
      idleEvidence.receivedFramesDuringInterval === 0,
    "IDLE_DIAGNOSTIC_INTERRUPTED_BY_ACTIVITY",
  );
  idleEvidence.pongRoundTripAfterIdleMs = await ping(replacement);
  await ping(other);
  passed("retained-idle-socket-diagnostic", idleEvidence);
  report.idleDiagnostic = idleEvidence;
  report.finalHeadSeq = checkStream(
    await http("/internal/v1/users/1/stream", internalHeaders()),
  );
  ensure(
    report.finalHeadSeq === report.initialHeadSeq,
    "RETAINED_LOG_CHANGED_DURING_PROBE",
  );
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failureCode =
    error instanceof ProbeFailure ? error.code : "CLOUD_TRANSPORT_PROBE_FAILED";
  process.exitCode = 1;
} finally {
  report.clients = [];
  const cleanupDeadline = Date.now() + cleanupGraceMs;
  for (const client of clients)
    client.closeCodeBeforeCleanup = client.closeCode;
  await Promise.all(
    clients.map(async (client) => {
      if (client.socket && client.socket.readyState !== WebSocket.CLOSED) {
        try {
          client.socket.close(1000, "owned cloud transport cleanup");
        } catch {
          /* Already closing. */
        }
        while (client.closeCode === null && Date.now() < cleanupDeadline)
          await sleep(20);
        if (client.closeCode === null) client.socket.terminate();
      }
    }),
  );
  // Allow owned terminate()/close() events to settle before writing the receipt.
  if (clients.some((client) => client.closeCode === null)) await sleep(20);
  for (const client of clients) {
    report.clients.push({
      name: client.name,
      userId: client.userId,
      deviceId: client.deviceId,
      connectionId: client.hello?.connectionId ?? null,
      batches: client.batches,
      acks: client.acks,
      closeCodeBeforeCleanup: client.closeCodeBeforeCleanup,
      closeCodeAfterCleanup: client.closeCode,
      sqliteFile: client.sqliteFile,
      committedThroughSeq: client.db ? client.cursor() : null,
    });
    client.db?.close();
  }
  report.allOwnedSocketsClosed = clients.every(
    (client) => client.closeCode !== null,
  );
  if (!report.allOwnedSocketsClosed) {
    report.result = "failed";
    report.failureCode ??= "OWNED_SOCKET_CLEANUP_INCOMPLETE";
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await mkdir(resolve(root, ".local"), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  if (origin)
    await writeFile(
      resolve(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  console.log(
    JSON.stringify({
      result: report.result,
      phase: report.phase,
      checksPassed: report.checks.length,
      failureCode: report.failureCode ?? null,
      reportFile,
    }),
  );
}
