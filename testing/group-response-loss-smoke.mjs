throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
/** S06: lose a real committed group response, then retry its original intent. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import mongoose from "../nestjs/node_modules/mongoose/index.js";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";

const env = await readEnvironment();
const base = "http://127.0.0.1:3000/api/v1";
const intent = {
  clientRequestId: randomUUID(),
  title: `Response loss ${randomUUID().slice(0, 8)}`,
  memberUserIds: ["2", "3"],
};
let stage = "preflight",
  firstResponse,
  proxyFailure,
  committedResponseDropped = false,
  proxy,
  mongo,
  report;
const checks = [];
try {
  assert.equal(env.APP_ENV, "development");
  const uri = new URL(env.MONGO_URI);
  assert.equal(uri.protocol, "mongodb:");
  assert.ok(["localhost", "127.0.0.1"].includes(uri.hostname));
  assert.ok(uri.pathname.startsWith("/chat_poc_"));
  assert.equal(uri.searchParams.get("replicaSet"), "rs0");
  assert.ok(
    (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok,
  );
  mongo = new mongoose.mongo.MongoClient(env.MONGO_URI, {
    serverSelectionTimeoutMS: 3000,
  });
  await mongo.connect();
  const db = mongo.db();
  assert.equal(
    (await db.collection("dataset_metadata").findOne({ _id: "dataset" }))
      .datasetId,
    env.DATASET_ID,
  );
  const sessionResponse = await fetch(`${base}/dev/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "1", deviceId: randomUUID() }),
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(sessionResponse.ok);
  const { sessionToken } = await sessionResponse.json();
  proxy = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/rooms/group");
      const parts = [];
      let length = 0;
      for await (const part of request) {
        length += part.length;
        assert.ok(length <= 4096);
        parts.push(part);
      }
      const upstream = await fetch(`${base}/rooms/group`, {
        method: "POST",
        headers: {
          Authorization: request.headers.authorization,
          "Content-Type": "application/json",
        },
        body: Buffer.concat(parts),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await upstream.text();
      if (!committedResponseDropped) {
        assert.equal(upstream.status, 201);
        firstResponse = JSON.parse(body);
        committedResponseDropped = true;
        // Mongo has committed and the entire success body is available here.
        // Deliberately close before returning any HTTP headers/body to the caller.
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, {
        "Content-Type": "application/json",
      });
      response.end(body);
    } catch {
      proxyFailure = true;
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${proxy.address().port}/rooms/group`;
  const send = (body) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  stage = "drop committed group response";
  await assert.rejects(send(intent));
  assert.equal(proxyFailure, undefined);
  assert.equal(committedResponseDropped, true);
  checks.push(
    "real committed201 group response lost before any downstream bytes",
  );

  stage = "retry original group intent";
  const retryResponse = await send(intent);
  assert.equal(retryResponse.status, 200);
  const retry = await retryResponse.json();
  assert.equal(firstResponse.created, true);
  assert.equal(retry.created, false);
  assert.deepEqual(retry.room, firstResponse.room);
  assert.deepEqual(retry.room.memberIds, ["1", "2", "3"]);
  checks.push("same original request ID returns the identical committed group");

  stage = "inspect immutable group journal and conflicting retry";
  const rooms = await db
    .collection("rooms")
    .find({
      datasetId: env.DATASET_ID,
      createdBy: "1",
      clientRequestId: intent.clientRequestId,
    })
    .toArray();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0]._id, retry.room.id);
  const events = await db
    .collection("event_outbox")
    .find({
      datasetId: env.DATASET_ID,
      envelopeJson: { $regex: `"id":"${retry.room.id}"` },
    })
    .toArray();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.userId).sort(), ["1", "2", "3"]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 1);
  for (const event of events) {
    const envelope = JSON.parse(event.envelopeJson);
    assert.equal(envelope.type, "room.upserted");
    assert.deepEqual(envelope.data.room, retry.room);
  }
  const conflict = await send({ ...intent, title: `${intent.title} changed` });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  const after = await db
    .collection("event_outbox")
    .find({ datasetId: env.DATASET_ID, eventId: events[0].eventId })
    .toArray();
  assert.deepEqual(
    after.map((event) => event.envelopeJson).sort(),
    events.map((event) => event.envelopeJson).sort(),
  );
  checks.push("exactly one group and one immutable creation event per member");
  checks.push("changed fingerprint rejected without changing original journal");
  report = {
    status: "passed",
    scenario: "S06",
    scope:
      "actual loopback HTTP response loss + local NestJS/Mongo; not native or real Cloudflare",
    completedAt: new Date().toISOString(),
    roomId: retry.room.id,
    clientRequestId: intent.clientRequestId,
    checks,
  };
} catch {
  process.exitCode = 1;
  report = {
    status: "failed",
    scenario: "S06",
    completedAt: new Date().toISOString(),
    stage,
    checks,
  };
  console.error(
    `Group response-loss smoke failed during ${stage}; no credentials or text printed.`,
  );
} finally {
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  await mongo?.close();
  await mkdir(resolve(root, ".local"), { recursive: true });
  await writeFile(
    resolve(root, ".local/group-response-loss-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
}
