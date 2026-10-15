/** Loopback-only fault injection. No production application routes are changed. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "../nestjs/node_modules/ws/index.js";

const { WebSocketServer } = WebSocket;
const root = fileURLToPath(new URL("..", import.meta.url));
const REQUEST_BYTES = 16_384;
const CONTROL_BYTES = 4_096;
const FRAME_BYTES = 65_536;
const RESPONSE_BYTES = 2_097_152;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUuid = (value) =>
  typeof value === "string" && uuidPattern.test(value);
const jsonObject = (data) => {
  try {
    const value = JSON.parse(data.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
};
const allowedRequestHeaders = [
  "authorization",
  "content-type",
  "accept",
  "x-request-id",
];
const allowedResponseHeaders = [
  "content-type",
  "cache-control",
  "x-request-id",
  "retry-after",
];
const messageRoute = /^\/api\/v1\/rooms\/[0-9a-f-]{36}\/messages$/i;

function allowedRoute(method, pathname) {
  if (method === "GET")
    return /^\/api\/v1\/(?:health|dev\/(?:users|diagnostics)|rooms|presence|rooms\/[0-9a-f-]{36}(?:\/messages)?)$/i.test(
      pathname,
    );
  return (
    method === "POST" &&
    (/^\/api\/v1\/(?:dev\/session|realtime\/ticket|rooms\/(?:direct|group))$/.test(
      pathname,
    ) ||
      messageRoute.test(pathname))
  );
}

function closePeer(peer, code, reason) {
  if (
    !peer ||
    peer.readyState === WebSocket.CLOSED ||
    peer.readyState === WebSocket.CLOSING
  )
    return;
  if (peer.readyState !== WebSocket.OPEN || code === 1006 || code === 1015) {
    peer.terminate();
    return;
  }
  if (code === 1005) {
    peer.close();
    return;
  }
  const permitted =
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999);
  if (permitted) peer.close(code, reason);
  else peer.terminate();
}

async function readBounded(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) {
      const error = new Error("The local proxy byte limit was exceeded.");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

export async function createFaultProxy({
  port = 3002,
  apiOrigin = "http://127.0.0.1:3000",
  workerOrigin = "ws://127.0.0.1:8787",
  reportPath = resolve(root, ".local/fault-proxy-report.json"),
  holdFirstMessage = false,
  holdMessageMarker = null,
  onCommittedHeld = () => {},
} = {}) {
  const apiTarget = new URL(apiOrigin),
    workerTarget = new URL(workerOrigin);
  assert.equal(apiTarget.hostname, "127.0.0.1");
  assert.equal(apiTarget.protocol, "http:");
  assert.equal(workerTarget.hostname, "127.0.0.1");
  assert.equal(workerTarget.protocol, "ws:");
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
  assert.ok(
    holdMessageMarker === null ||
      /^[A-Za-z0-9_-]{1,60}$/.test(holdMessageMarker),
  );
  const state = {
    scope:
      "loopback HTTP/WebSocket fault injection; native SQLite/visible convergence must be verified by the Flutter integration test",
    phase: "waiting-for-faults",
    mode: holdFirstMessage ? "hold-first-message" : "response-and-ack-loss",
    startedAt: new Date().toISOString(),
    counts: {
      httpRequests: 0,
      messagePosts: 0,
      apiResponsesForwarded: 0,
      committedHttpResponsesDropped: 0,
      committedHttpResponsesHeld: 0,
      serverBatchesSuppressed: 0,
      webSocketConnections: 0,
      serverBatches: 0,
      clientAcksDropped: 0,
      clientAcksForwarded: 0,
      duplicateBatchAfterAckLoss: 0,
      bridgeErrors: 0,
    },
    droppedHttp: null,
    droppedAck: null,
    duplicateBatchObserved: false,
    exactDuplicateBatchBytes: false,
    ackForwardedAfterRetransmission: false,
    heldMessage: null,
    holdReleased: false,
  };
  let reportWrites = Promise.resolve(),
    active = true,
    connectionNumber = 0,
    listenPort;
  const pairs = new Set(),
    httpSockets = new Set(),
    aborts = new Set(),
    heldResponses = new Set();
  function record() {
    if (holdFirstMessage && state.heldMessage?.fullCommittedResponseRead) {
      state.phase = state.holdReleased
        ? "hold-released"
        : "committed-message-held";
      if (
        state.holdReleased &&
        state.heldMessage.duplicateResponsesAfterRelease > 0
      )
        state.phase = "inflight-retry-observed";
    }
    if (
      state.droppedHttp &&
      state.droppedAck &&
      state.duplicateBatchObserved &&
      state.exactDuplicateBatchBytes &&
      state.ackForwardedAfterRetransmission
    )
      state.phase = "faults-exercised";
    if (!reportPath) return;
    const snapshot =
      JSON.stringify(
        { ...state, updatedAt: new Date().toISOString() },
        null,
        2,
      ) + "\n";
    reportWrites = reportWrites
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(reportPath), { recursive: true });
        const temporary = `${reportPath}.${process.pid}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, reportPath);
      });
  }
  function announceHeld() {
    const held = state.heldMessage;
    if (
      !held?.fullCommittedResponseRead ||
      !held.suppressedBatchId ||
      held.heldSentinelAt
    )
      return;
    held.heldSentinelAt = new Date().toISOString();
    record();
    void reportWrites.then(() => onCommittedHeld()).catch(() => {});
  }
  function failResponse(response, status) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        error: {
          code: status === 413 ? "VALIDATION_ERROR" : "LOCAL_PROXY_ERROR",
          message: "The local test proxy request failed.",
          retryable: status === 502,
        },
      }),
    );
  }
  const server = createServer(async (request, response) => {
    state.counts.httpRequests++;
    const controller = new AbortController();
    aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!allowedRoute(request.method, url.pathname)) {
        failResponse(response, 404);
        return;
      }
      const declared = Number(request.headers["content-length"] ?? 0);
      if (
        !Number.isSafeInteger(declared) ||
        declared < 0 ||
        declared > REQUEST_BYTES
      ) {
        failResponse(response, 413);
        request.resume();
        return;
      }
      request.setTimeout(10_000, () => request.destroy());
      const body = await readBounded(request, REQUEST_BYTES);
      const headers = {};
      for (const name of allowedRequestHeaders)
        if (typeof request.headers[name] === "string")
          headers[name] = request.headers[name];
      const isMessage =
        request.method === "POST" && messageRoute.test(url.pathname);
      const input = isMessage ? jsonObject(body) : null;
      if (isMessage) {
        state.counts.messagePosts++;
        if (
          holdFirstMessage &&
          !state.heldMessage &&
          validUuid(input?.clientMessageId) &&
          (holdMessageMarker === null ||
            (typeof input.text === "string" &&
              input.text.includes(holdMessageMarker)))
        ) {
          // Capture before the fetch: the outbox may publish before HTTP returns.
          state.heldMessage = {
            clientMessageId: input.clientMessageId,
            serverMessageId: null,
            deviceId: null,
            senderId: null,
            requestCapturedBeforeForward: true,
            capturedAt: new Date().toISOString(),
            fullCommittedResponseRead: false,
            connection: null,
            requestsForClientId: 1,
            duplicateResponsesAfterRelease: 0,
          };
          record();
        } else if (
          state.heldMessage?.clientMessageId === input?.clientMessageId
        )
          state.heldMessage.requestsForClientId++;
        if (state.droppedHttp?.clientMessageId === input?.clientMessageId)
          state.droppedHttp.requestsForClientId++;
      }
      const upstream = await fetch(
        new URL(`${url.pathname}${url.search}`, apiTarget),
        {
          method: request.method,
          headers,
          ...(["GET", "HEAD"].includes(request.method) ? {} : { body }),
          signal: controller.signal,
          redirect: "error",
        },
      );
      let payload = await readBounded(upstream.body, RESPONSE_BYTES);
      const result = jsonObject(payload);
      if (
        isMessage &&
        upstream.ok &&
        validUuid(input?.clientMessageId) &&
        validUuid(result?.message?.id) &&
        result.message.clientMessageId === input.clientMessageId
      ) {
        if (
          holdFirstMessage &&
          state.heldMessage?.clientMessageId === input.clientMessageId
        ) {
          if (!state.holdReleased) {
            const held = state.heldMessage;
            held.serverMessageId = result.message.id;
            held.deviceId = result.message.originDeviceId;
            held.senderId = result.message.senderId;
            held.upstreamStatus = upstream.status;
            held.fullCommittedResponseRead = true;
            held.committedAt = new Date().toISOString();
            for (const pair of pairs)
              if (
                pair.deviceId === held.deviceId &&
                pair.userId === held.senderId
              )
                held.connection = pair.number;
            request.setTimeout(0);
            heldResponses.add(response);
            response.once("close", () => heldResponses.delete(response));
            state.counts.committedHttpResponsesHeld++;
            record();
            await reportWrites;
            announceHeld();
            // No headers/body reach the app until its process is externally terminated.
            return;
          }
          if (result.duplicate === true)
            state.heldMessage.duplicateResponsesAfterRelease++;
        } else if (!holdFirstMessage && !state.droppedHttp) {
          state.droppedHttp = {
            clientMessageId: input.clientMessageId,
            serverMessageId: result.message.id,
            upstreamStatus: upstream.status,
            fullCommittedResponseRead: true,
            droppedAt: new Date().toISOString(),
            requestsForClientId: 1,
            duplicateResponsesAfterDrop: 0,
          };
          state.counts.committedHttpResponsesDropped++;
          record();
          // Mongo commit is represented by the fully read successful canonical API response.
          // Discard that response only; the application/Worker retain the committed mutation.
          response.destroy();
          return;
        }
        if (
          !holdFirstMessage &&
          state.droppedHttp.clientMessageId === input.clientMessageId &&
          result.duplicate === true
        )
          state.droppedHttp.duplicateResponsesAfterDrop++;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/realtime/ticket" &&
        upstream.ok
      ) {
        if (!result || typeof result.url !== "string")
          throw new Error("The upstream ticket response is invalid.");
        result.url = `ws://127.0.0.1:${listenPort}/v1/ws`;
        payload = Buffer.from(JSON.stringify(result));
      }
      const outgoing = { "Content-Length": String(payload.length) };
      for (const name of allowedResponseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) outgoing[name] = value;
      }
      response.writeHead(upstream.status, outgoing);
      response.end(payload);
      state.counts.apiResponsesForwarded++;
      record();
    } catch (error) {
      state.counts.bridgeErrors++;
      failResponse(response, error.status === 413 ? 413 : 502);
      record();
    } finally {
      clearTimeout(timeout);
      aborts.delete(controller);
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    httpSockets.add(socket);
    socket.once("close", () => httpSockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: CONTROL_BYTES,
    perMessageDeflate: false,
  });
  sockets.on("error", () => {
    state.counts.bridgeErrors++;
    record();
  });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    let url;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get("ticket");
    if (
      url.pathname !== "/v1/ws" ||
      [...url.searchParams.keys()].some((key) => key !== "ticket") ||
      url.searchParams.getAll("ticket").length !== 1 ||
      !ticket ||
      ticket.length > CONTROL_BYTES
    ) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const number = ++connectionNumber;
    const upstream = new WebSocket(
      new URL(`/v1/ws${url.search}`, workerTarget),
      {
        handshakeTimeout: 10_000,
        maxPayload: FRAME_BYTES,
        perMessageDeflate: false,
      },
    );
    const pair = {
      upstream,
      downstream: null,
      number,
      batches: new Map(),
      deviceId: null,
      userId: null,
    };
    pairs.add(pair);
    function send(peer, data, isBinary, maxBuffered) {
      if (!peer || peer.readyState !== WebSocket.OPEN) return;
      if (peer.bufferedAmount > maxBuffered) {
        closePeer(peer, 1013, "local proxy backpressure");
        return;
      }
      peer.send(data, { binary: isBinary }, (error) => {
        if (error) {
          state.counts.bridgeErrors++;
          closePeer(peer, 1013, "local proxy transport failure");
          record();
        }
      });
    }
    upstream.on("open", () => {
      if (socket.destroyed || !active) {
        upstream.close(1000, "local proxy closed");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (downstream) => {
        pair.downstream = downstream;
        state.counts.webSocketConnections++;
        record();
        downstream.on("message", (data, isBinary) => {
          const frame = !isBinary ? jsonObject(data) : null;
          const batch =
            frame?.type === "ack" ? pair.batches.get(frame.batchId) : null;
          const validAck =
            frame?.v === 1 &&
            frame.type === "ack" &&
            batch &&
            frame.throughSeq === batch.toSeq &&
            Number.isSafeInteger(frame.throughSeq);
          if (validAck && !holdFirstMessage && !state.droppedAck) {
            state.droppedAck = {
              connection: number,
              batchId: frame.batchId,
              throughSeq: frame.throughSeq,
              fromSeq: batch.fromSeq,
              frameHash: batch.hash,
              droppedAt: new Date().toISOString(),
            };
            state.counts.clientAcksDropped++;
            record();
            return;
          }
          if (validAck) {
            state.counts.clientAcksForwarded++;
            if (
              state.droppedAck?.connection === number &&
              state.droppedAck.batchId === frame.batchId &&
              state.droppedAck.throughSeq === frame.throughSeq &&
              state.duplicateBatchObserved
            )
              state.ackForwardedAfterRetransmission = true;
            record();
          }
          send(upstream, data, isBinary, FRAME_BYTES);
        });
        downstream.on("close", (code, reason) => {
          const held = state.heldMessage;
          if (
            holdFirstMessage &&
            !state.holdReleased &&
            held?.fullCommittedResponseRead &&
            (held.connection === number ||
              (held.deviceId === pair.deviceId &&
                held.senderId === pair.userId))
          ) {
            state.holdReleased = true;
            held.releasedAt = new Date().toISOString();
            held.releaseCloseCode = code;
            for (const response of heldResponses) response.destroy();
            heldResponses.clear();
            record();
          }
          closePeer(upstream, code, reason);
          pairs.delete(pair);
        });
        downstream.on("error", () => {
          state.counts.bridgeErrors++;
          closePeer(upstream, 1013, "local proxy client failure");
          record();
        });
      });
    });
    upstream.on("message", (data, isBinary) => {
      const frame = !isBinary ? jsonObject(data) : null;
      if (frame?.type === "hello") {
        pair.deviceId = frame.deviceId;
        pair.userId = frame.userId;
      }
      if (
        frame?.v === 1 &&
        frame.type === "events.batch" &&
        validUuid(frame.batchId) &&
        Number.isSafeInteger(frame.fromSeq) &&
        Number.isSafeInteger(frame.toSeq)
      ) {
        const hash = createHash("sha256").update(data).digest("hex");
        pair.batches.set(frame.batchId, {
          fromSeq: frame.fromSeq,
          toSeq: frame.toSeq,
          hash,
        });
        if (pair.batches.size > 128)
          pair.batches.delete(pair.batches.keys().next().value);
        state.counts.serverBatches++;
        if (
          state.droppedAck?.connection === number &&
          state.droppedAck.batchId === frame.batchId
        ) {
          state.duplicateBatchObserved = true;
          state.exactDuplicateBatchBytes =
            state.droppedAck.frameHash === hash &&
            state.droppedAck.throughSeq === frame.toSeq &&
            state.droppedAck.fromSeq === frame.fromSeq;
          state.counts.duplicateBatchAfterAckLoss++;
        }
        record();
        if (
          holdFirstMessage &&
          !state.holdReleased &&
          state.heldMessage &&
          Array.isArray(frame.events)
        ) {
          const held = state.heldMessage;
          const matching = frame.events.find(
            (event) =>
              event?.type === "message.created" &&
              event.data?.message?.clientMessageId === held.clientMessageId &&
              event.data.message.originDeviceId === pair.deviceId &&
              event.data.message.senderId === pair.userId,
          );
          if (matching) {
            held.connection = number;
            held.deviceId = matching.data.message.originDeviceId;
            held.senderId = matching.data.message.senderId;
            held.suppressedBatchId = frame.batchId;
            held.suppressedThroughSeq = frame.toSeq;
            state.counts.serverBatchesSuppressed++;
            record();
            announceHeld();
            return;
          }
        }
      }
      send(pair.downstream, data, isBinary, FRAME_BYTES * 4);
    });
    upstream.on("close", (code, reason) => {
      closePeer(pair.downstream, code, reason);
      if (!pair.downstream && !socket.destroyed) socket.destroy();
      pairs.delete(pair);
    });
    upstream.on("unexpected-response", (_request, response) => {
      const status =
        response.statusCode >= 400 && response.statusCode <= 599
          ? response.statusCode
          : 502;
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${status} Upstream Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      response.resume();
      upstream.terminate();
    });
    upstream.on("error", () => {
      state.counts.bridgeErrors++;
      if (pair.downstream)
        closePeer(pair.downstream, 1013, "local proxy upstream unavailable");
      else if (!socket.destroyed) socket.destroy();
      record();
    });
    socket.once("close", () => {
      if (!pair.downstream) {
        upstream.terminate();
        pairs.delete(pair);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  listenPort = server.address().port;
  state.port = listenPort;
  record();
  await reportWrites;
  return {
    state,
    port: listenPort,
    server,
    async close() {
      if (!active) return;
      active = false;
      for (const controller of aborts) controller.abort();
      for (const response of heldResponses) response.destroy();
      for (const pair of pairs) {
        closePeer(pair.downstream, 1000, "local fault proxy shutdown");
        closePeer(pair.upstream, 1000, "local fault proxy shutdown");
      }
      const closed = new Promise((resolve) => server.close(resolve));
      const deadline = setTimeout(() => {
        for (const pair of pairs) {
          pair.downstream?.terminate();
          pair.upstream.terminate();
        }
        for (const socket of httpSockets) socket.destroy();
      }, 1000);
      await closed;
      clearTimeout(deadline);
      sockets.close();
      state.stoppedAt = new Date().toISOString();
      if (
        ![
          "faults-exercised",
          "hold-released",
          "inflight-retry-observed",
        ].includes(state.phase)
      )
        state.phase = "stopped-incomplete";
      record();
      await reportWrites;
    },
  };
}

async function selfTest() {
  const messages = new Map(),
    bodyId = randomUUID(),
    serverId = randomUUID(),
    batchId = randomUUID();
  let upstreamAcks = 0,
    binarySeen = false,
    proxy;
  const fixture = createServer(async (req, res) => {
    const body = await readBounded(req, REQUEST_BYTES);
    if (req.url === "/api/v1/realtime/ticket") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          url: "ws://127.0.0.1:1/v1/ws",
          ticket: "synthetic-self-test-ticket",
        }),
      );
      return;
    }
    const input = jsonObject(body),
      duplicate = messages.has(input.clientMessageId);
    messages.set(input.clientMessageId, serverId);
    res.writeHead(duplicate ? 200 : 201, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        message: { id: serverId, clientMessageId: input.clientMessageId },
        duplicate,
      }),
    );
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = fixture.address().port;
  const wsFixture = new WebSocketServer({ server: fixture });
  wsFixture.on("connection", (ws) => {
    const batch = JSON.stringify({
      v: 1,
      type: "events.batch",
      batchId,
      fromSeq: 1,
      toSeq: 1,
      events: [],
    });
    ws.send(JSON.stringify({ v: 1, type: "hello" }));
    ws.send(Buffer.from([0, 1, 2]), { binary: true });
    ws.on("message", (data, binary) => {
      if (binary) {
        binarySeen = Buffer.from(data).equals(Buffer.from([3, 4]));
        return;
      }
      const frame = jsonObject(data);
      if (frame?.type === "resume") {
        ws.send(batch);
        const timer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(batch);
        }, 100);
        timer.unref();
      }
      if (frame?.type === "ack") {
        upstreamAcks++;
        ws.close(4009, "synthetic replacement");
      }
    });
  });
  let client;
  try {
    proxy = await createFaultProxy({
      port: 0,
      apiOrigin: `http://127.0.0.1:${fixturePort}`,
      workerOrigin: `ws://127.0.0.1:${fixturePort}`,
      reportPath: null,
    });
    const base = `http://127.0.0.1:${proxy.port}`;
    const ticket = await (
      await fetch(`${base}/api/v1/realtime/ticket`, {
        method: "POST",
        body: "{}",
      })
    ).json();
    assert.equal(ticket.url, `ws://127.0.0.1:${proxy.port}/v1/ws`);
    assert.equal(ticket.ticket, "synthetic-self-test-ticket");
    const route = `/api/v1/rooms/${randomUUID()}/messages`,
      body = JSON.stringify({
        clientMessageId: bodyId,
        text: "synthetic fixture",
      });
    await assert.rejects(
      fetch(`${base}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );
    assert.equal(messages.size, 1);
    const retry = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).message.id, serverId);
    assert.equal((await fetch(`${base}/unapproved`)).status, 404);
    assert.equal(
      (
        await fetch(`${base}${route}`, {
          method: "POST",
          body: "x".repeat(REQUEST_BYTES + 1),
        })
      ).status,
      413,
    );
    const closed = new Promise((resolve, reject) => {
      client = new WebSocket(`${ticket.url}?ticket=${ticket.ticket}`);
      client.on("error", reject);
      client.on("message", (data, binary) => {
        if (binary) {
          assert.deepEqual(Buffer.from(data), Buffer.from([0, 1, 2]));
          client.send(Buffer.from([3, 4]), { binary: true });
          return;
        }
        const frame = jsonObject(data);
        if (frame.type === "hello")
          client.send(JSON.stringify({ v: 1, type: "resume", afterSeq: 0 }));
        if (frame.type === "events.batch")
          client.send(
            JSON.stringify({ v: 1, type: "ack", batchId, throughSeq: 1 }),
          );
      });
      client.on("close", (code, reason) => {
        try {
          assert.equal(code, 4009);
          assert.equal(reason.toString(), "synthetic replacement");
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    let timer;
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Self-test socket timed out.")),
          3000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(upstreamAcks, 1);
    assert.ok(binarySeen);
    assert.equal(proxy.state.counts.clientAcksDropped, 1);
    assert.equal(proxy.state.counts.committedHttpResponsesDropped, 1);
    assert.equal(proxy.state.duplicateBatchObserved, true);
    assert.equal(proxy.state.exactDuplicateBatchBytes, true);
    assert.equal(proxy.state.ackForwardedAfterRetransmission, true);
    assert.equal(proxy.state.droppedHttp.clientMessageId, bodyId);
    assert.equal(proxy.state.droppedHttp.serverMessageId, serverId);
    assert.equal(proxy.state.droppedHttp.duplicateResponsesAfterDrop, 1);
    assert.equal(proxy.state.phase, "faults-exercised");
    console.log(
      "FAULT_PROXY_SELFTEST_PASS: committed response loss, retry, exact batch retransmission, ACK loss, binary flags, close code/reason, route/body limits.",
    );
  } finally {
    client?.terminate();
    await proxy?.close();
    for (const client of wsFixture.clients) client.terminate();
    wsFixture.close();
    await new Promise((resolve) => fixture.close(resolve));
  }
}

async function holdSelfTest() {
  const clientId = randomUUID(),
    messageId = randomUUID(),
    deviceId = randomUUID(),
    batchId = randomUUID();
  const message = {
    id: messageId,
    clientMessageId: clientId,
    originDeviceId: deviceId,
    senderId: "1",
  };
  const batch = JSON.stringify({
    v: 1,
    type: "events.batch",
    batchId,
    fromSeq: 1,
    toSeq: 1,
    events: [{ type: "message.created", data: { message } }],
  });
  let committed = false,
    upstreamAcks = 0,
    heldSignals = 0,
    originalReceivedBatch = false,
    proxy,
    original,
    relaunched;
  const workerClients = new Set();
  const fixture = createServer(async (req, res) => {
    const input = jsonObject(await readBounded(req, REQUEST_BYTES));
    assert.equal(input.clientMessageId, clientId);
    const duplicate = committed;
    committed = true;
    // Publish before the successful HTTP body is read: the proxy must already know the key.
    if (!duplicate) for (const ws of workerClients) ws.send(batch);
    res.writeHead(duplicate ? 200 : 201, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ message, duplicate }));
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = fixture.address().port;
  const wsFixture = new WebSocketServer({ server: fixture });
  wsFixture.on("connection", (ws) => {
    workerClients.add(ws);
    ws.once("close", () => workerClients.delete(ws));
    ws.send(JSON.stringify({ v: 1, type: "hello", userId: "1", deviceId }));
    ws.on("message", (raw) => {
      const frame = jsonObject(raw);
      if (frame?.type === "resume" && committed) ws.send(batch);
      if (frame?.type === "ack") upstreamAcks++;
    });
  });
  async function until(check) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Hold self-test timed out.");
  }
  try {
    proxy = await createFaultProxy({
      port: 0,
      apiOrigin: `http://127.0.0.1:${fixturePort}`,
      workerOrigin: `ws://127.0.0.1:${fixturePort}`,
      reportPath: null,
      holdFirstMessage: true,
      onCommittedHeld: () => heldSignals++,
    });
    const url = `ws://127.0.0.1:${proxy.port}/v1/ws?ticket=synthetic-hold-self-test`;
    let originalHello = false;
    original = new WebSocket(url);
    original.on("error", () => {});
    original.on("message", (raw) => {
      const frame = jsonObject(raw);
      if (frame?.type === "hello") originalHello = true;
      if (frame?.type === "events.batch") originalReceivedBatch = true;
    });
    await until(() => originalHello);
    let responseSettled = false;
    const response = fetch(
      `http://127.0.0.1:${proxy.port}/api/v1/rooms/${randomUUID()}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: clientId,
          text: "synthetic hold fixture",
        }),
      },
    ).then(
      () => {
        responseSettled = true;
        return "forwarded";
      },
      () => {
        responseSettled = true;
        return "disconnected";
      },
    );
    await until(
      () =>
        proxy.state.heldMessage?.fullCommittedResponseRead &&
        proxy.state.counts.serverBatchesSuppressed > 0,
    );
    assert.equal(responseSettled, false);
    assert.equal(originalReceivedBatch, false);
    assert.equal(upstreamAcks, 0);
    assert.equal(heldSignals, 1);
    original.terminate();
    await until(() => proxy.state.holdReleased);
    assert.equal(await response, "disconnected");
    const retry = await fetch(
      `http://127.0.0.1:${proxy.port}/api/v1/rooms/${randomUUID()}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: clientId,
          text: "synthetic hold fixture",
        }),
      },
    );
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).duplicate, true);
    let replayed = false;
    relaunched = new WebSocket(url);
    relaunched.on("error", () => {});
    relaunched.on("message", (raw) => {
      const frame = jsonObject(raw);
      if (frame?.type === "hello")
        relaunched.send(JSON.stringify({ v: 1, type: "resume", afterSeq: 0 }));
      if (frame?.type === "events.batch") {
        replayed = true;
        relaunched.send(
          JSON.stringify({ v: 1, type: "ack", batchId, throughSeq: 1 }),
        );
      }
    });
    await until(() => replayed && upstreamAcks === 1);
    assert.equal(proxy.state.counts.clientAcksDropped, 0);
    assert.equal(proxy.state.counts.committedHttpResponsesDropped, 0);
    assert.equal(proxy.state.counts.committedHttpResponsesHeld, 1);
    assert.equal(proxy.state.heldMessage.duplicateResponsesAfterRelease, 1);
    assert.equal(proxy.state.phase, "inflight-retry-observed");
    console.log(
      "FAULT_PROXY_HOLD_SELFTEST_PASS: pre-forward capture, held committed response, sender echo suppression, disconnect release, normal retry/replay.",
    );
  } finally {
    original?.terminate();
    relaunched?.terminate();
    await proxy?.close();
    for (const client of wsFixture.clients) client.terminate();
    wsFixture.close();
    await new Promise((resolve) => fixture.close(resolve));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.includes("--self-test")) await selfTest();
    else if (process.argv.includes("--self-test-hold")) await holdSelfTest();
    else {
      const proxy = await createFaultProxy({
        holdFirstMessage: process.argv.includes("--hold-first-message"),
        holdMessageMarker:
          process.argv
            .find((value) => value.startsWith("--hold-message-marker="))
            ?.slice("--hold-message-marker=".length) ?? null,
        onCommittedHeld: () => console.log("COMMITTED_MESSAGE_HELD"),
      });
      const stop = async () => {
        await proxy.close();
        process.exit(0);
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      console.log("FAULT_PROXY_READY");
    }
  } catch {
    console.error(
      "The local fault proxy failed. No authorization, ticket, or message content is printed.",
    );
    process.exitCode = 1;
  }
}
