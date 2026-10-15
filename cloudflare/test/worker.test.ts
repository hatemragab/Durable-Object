import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import type { EventBatch, RoomUpdate, UserId } from "@chat-poc/contracts";
import { LIMITS, objectName } from "../src/env";
import { parseControl } from "../src/protocol";
import { EventStore } from "../src/store";

const connections: WebSocket[] = [];
const data = () => env.DATASET_ID;
function stub(userId: UserId = "1") {
  return env.USER_REALTIME.getByName(objectName(data(), userId));
}
async function inspect(userId: UserId = "1") {
  const result = await stub(userId).inspect(userId);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function event(
  revision = 1,
  userId: UserId = "1",
  roomId = crypto.randomUUID(),
): RoomUpdate {
  return {
    v: 2,
    datasetId: data(),
    userId,
    type: "room.upserted",
    data: {
      room: {
        id: roomId,
        type: "direct",
        title: null,
        memberIds: ["1", "2"],
        createdBy: "1",
        createdAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:00:00.000Z",
        version: revision,
        revision,
        unreadCount: 0,
        lastReadSeq: 0,
        lastMessageSeq: 0,
        lastMessage: null,
      },
    },
  };
}
function messageEvent(text: string): RoomUpdate {
  const update = event();
  update.data.room.lastMessageSeq = 1;
  update.data.room.lastMessage = {
    messageId: crypto.randomUUID(),
    senderId: "1",
    text,
    roomSeq: 1,
    createdAt: "2026-10-15T00:00:00.000Z",
  };
  return update;
}
const epochs = new WeakMap<WebSocket, string>();
async function ticket(
  userId: UserId = "1",
  deviceId = crypto.randomUUID(),
  overrides: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    deviceId,
    datasetId: data(),
    sessionExp: now + 86_400,
    ...overrides,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("chat-poc-nestjs")
    .setAudience("chat-poc-realtime")
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(env.WS_TICKET_SECRET));
}
function frames(socket: WebSocket) {
  const queue: Record<string, any>[] = [];
  const waiters: ((value: Record<string, any>) => void)[] = [];
  socket.addEventListener("message", (message) => {
    const value =
      message.data === "pong"
        ? { type: "pong" }
        : JSON.parse(String(message.data));
    const waiting = waiters.shift();
    if (waiting) waiting(value);
    else queue.push(value);
  });
  return {
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : new Promise<Record<string, any>>((resolve) => waiters.push(resolve)),
    queue,
  };
}
async function connect(
  userId: UserId = "1",
  deviceId = crypto.randomUUID(),
  headers: Record<string, string> = {},
) {
  const response = await SELF.fetch(
    `https://poc/v1/ws?ticket=${await ticket(userId, deviceId)}`,
    { headers: { upgrade: "websocket", ...headers } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const inbox = frames(socket);
  socket.accept();
  connections.push(socket);
  const hello = await inbox.next();
  expect(hello.type).toBe("hello");
  epochs.set(socket, hello.epoch);
  return { socket, inbox, hello };
}
function send(socket: WebSocket, frame: object) {
  const resume =
    (frame as { type?: string }).type === "resume"
      ? { epoch: epochs.get(socket), syncedAt: new Date().toISOString() }
      : {};
  socket.send(JSON.stringify({ v: 2, ...resume, ...frame }));
}
function internalHeaders() {
  return {
    authorization: `Bearer ${env.REALTIME_INTERNAL_SECRET}`,
    "x-dataset-id": data(),
    "content-type": "application/json",
  };
}
async function append(value: RoomUpdate) {
  return SELF.fetch(`https://poc/internal/v1/users/${value.userId}/events`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify(value),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    connections.splice(0).map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          socket.addEventListener("close", () => resolve(), { once: true });
          try {
            socket.close(1000);
          } catch {
            resolve();
          }
        }),
    ),
  );
  for (const userId of ["1", "2", "3"] as const) {
    await stub(userId).localPresence(userId);
    await runDurableObjectAlarm(stub(userId));
  }
  // Each test gets a fresh dataset without deleting another dataset's retained data.
  (env as { DATASET_ID: string }).DATASET_ID = crypto.randomUUID();
});

describe("development routing and security", () => {
  it("returns minimal health and refuses public internal-route access", async () => {
    expect(await (await SELF.fetch("https://poc/health")).json()).toEqual({
      service: "chat-poc-realtime",
      protocolVersion: 2,
      development: true,
    });
    expect(
      (await SELF.fetch("https://poc/internal/v1/users/1/stream")).status,
    ).toBe(401);
    expect((await SELF.fetch("https://poc/no-such-route")).status).toBe(404);
  });
  it("rejects expired, forged, wrong-dataset tickets and body identity mismatches", async () => {
    for (const bad of [
      "not-a-jwt",
      await ticket("1", crypto.randomUUID(), {
        datasetId: crypto.randomUUID(),
      }),
      await ticket("1", crypto.randomUUID(), { sessionExp: 0 }),
    ]) {
      expect(
        (
          await SELF.fetch(`https://poc/v1/ws?ticket=${bad}`, {
            headers: { upgrade: "websocket" },
          })
        ).status,
      ).toBe(401);
    }
    const socket = await connect("1", crypto.randomUUID(), {
      "x-poc-user": "3",
      "x-poc-dataset": crypto.randomUUID(),
    });
    expect(socket.hello.userId).toBe("1");
    expect(
      (
        await SELF.fetch("https://poc/internal/v1/users/1/stream", {
          headers: {
            ...internalHeaders(),
            "x-dataset-id": crypto.randomUUID(),
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await SELF.fetch("https://poc/internal/v1/users/1/events", {
          method: "POST",
          headers: internalHeaders(),
          body: JSON.stringify(event(1, "2")),
        })
      ).status,
    ).toBe(409);
  });
  it("validates control frames, versions, integer cursors, byte limits and forbidden writes", () => {
    for (const value of [
      "null",
      "{",
      '{"v":2,"type":"resume","afterSeq":0}',
      '{"v":1,"type":"resume","afterSeq":-1}',
      '{"v":1,"type":"message.create"}',
      '{"v":1,"type":"presence.watch","userIds":["4"]}',
    ])
      expect(() => parseControl(value)).toThrow();
    expect(() => parseControl("x".repeat(LIMITS.controlBytes + 1))).toThrow();
    expect(() => parseControl(new ArrayBuffer(1))).toThrow();
  });
  it("rejects wrong audience/signature and truly expired upgrade tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [audience, expiry, key] of [
      ["wrong-audience", now + 60, env.WS_TICKET_SECRET],
      ["chat-poc-realtime", now - 30, env.WS_TICKET_SECRET],
      [
        "chat-poc-realtime",
        now + 60,
        "wrong-signing-secret-00000000000000000000000000000",
      ],
    ] as const) {
      const token = await new SignJWT({
        deviceId: crypto.randomUUID(),
        datasetId: data(),
        sessionExp: now + 86_400,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("chat-poc-nestjs")
        .setAudience(audience)
        .setSubject("1")
        .setIssuedAt(now - 60)
        .setExpirationTime(expiry)
        .setJti(crypto.randomUUID())
        .sign(new TextEncoder().encode(key));
      expect(
        (
          await SELF.fetch(`https://poc/v1/ws?ticket=${token}`, {
            headers: { upgrade: "websocket" },
          })
        ).status,
      ).toBe(401);
    }
  });
  it("rejects API-session credentials as internal bearer and WebSocket ticket", async () => {
    const now = Math.floor(Date.now() / 1000);
    const apiSession = await new SignJWT({
      deviceId: crypto.randomUUID(),
      datasetId: data(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("chat-poc-nestjs")
      .setAudience("chat-poc-api")
      .setSubject("1")
      .setIssuedAt(now)
      .setExpirationTime(now + 86_400)
      .setJti(crypto.randomUUID())
      .sign(
        new TextEncoder().encode(
          "fixture-only-api-session-secret-22222222222222222222",
        ),
      );
    const internal = await SELF.fetch(
      "https://poc/internal/v1/users/1/stream",
      {
        headers: {
          ...internalHeaders(),
          authorization: `Bearer ${apiSession}`,
        },
      },
    );
    expect(internal.status).toBe(401);
    expect(await internal.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", retryable: false },
    });
    const upgrade = await SELF.fetch(`https://poc/v1/ws?ticket=${apiSession}`, {
      headers: { upgrade: "websocket" },
    });
    expect(upgrade.status).toBe(401);
    expect(upgrade.webSocket).toBeNull();
    expect(await upgrade.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", retryable: false },
    });
    expect((await inspect()).headSeq).toBe(0);
  });
  it("rejects nonallowlisted recipients and wrong-dataset envelopes without allocating a stream", async () => {
    const invalidUser = await SELF.fetch(
      "https://poc/internal/v1/users/1/events",
      {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({ ...event(), userId: "4" }),
      },
    );
    expect(invalidUser.status).toBe(400);
    expect(await invalidUser.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const wrongDataset = await SELF.fetch(
      "https://poc/internal/v1/users/1/events",
      {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({ ...event(), datasetId: crypto.randomUUID() }),
      },
    );
    expect(wrongDataset.status).toBe(409);
    expect(await wrongDataset.json()).toMatchObject({
      error: { code: "DATASET_MISMATCH" },
    });
    expect(
      (
        await SELF.fetch("https://poc/internal/v1/users/4/stream", {
          headers: internalHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(await inspect()).toMatchObject({ headSeq: 0, eventCount: 0 });
    expect((await append(event())).status).toBe(200);
  });
  it.each([
    {
      label: "binary control frame",
      payload: new Uint8Array([1, 2, 3]),
      errorCode: "VALIDATION_ERROR",
      closeCode: 4002,
    },
    {
      label: "oversized UTF-8 control frame",
      payload: JSON.stringify({
        v: 2,
        type: "presence.refresh",
        padding: "é".repeat(2_100),
      }),
      errorCode: "FRAME_TOO_LARGE",
      closeCode: 1009,
    },
  ])(
    "closes the actual WebSocket for $label",
    async ({ payload, errorCode, closeCode }) => {
      const client = await connect();
      send(client.socket, { type: "resume", afterSeq: 0 });
      expect(await client.inbox.next()).toMatchObject({ type: "sync.started" });
      expect(await client.inbox.next()).toMatchObject({ type: "sync.ready" });
      const closed = new Promise<number>((resolve) => {
        client.socket.addEventListener(
          "close",
          (event) => resolve(event.code),
          { once: true },
        );
      });
      client.socket.send(payload);
      expect(await client.inbox.next()).toMatchObject({
        type: "error",
        code: errorCode,
        retryable: false,
      });
      expect(await closed).toBe(closeCode);
      await runInDurableObject(stub(), (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{
              max_ack_seq: number;
            }>(
              "SELECT max_ack_seq FROM devices WHERE device_id=?",
              client.hello.deviceId,
            )
            .one().max_ack_seq,
        ).toBe(0);
      });
      expect(await inspect()).toMatchObject({ headSeq: 0, eventCount: 0 });
    },
  );
  it("enforces input byte limits before storing and refuses production mode", async () => {
    const oversized = await SELF.fetch(
      "https://poc/internal/v1/users/1/events",
      {
        method: "POST",
        headers: internalHeaders(),
        body: " ".repeat(LIMITS.eventBytes + 1),
      },
    );
    expect(oversized.status).toBe(413);
    expect((await inspect()).headSeq).toBe(0);
    const before = env.APP_ENV;
    try {
      (env as { APP_ENV: string }).APP_ENV = "production";
      expect((await SELF.fetch("https://poc/health")).status).toBe(503);
    } finally {
      (env as { APP_ENV: string }).APP_ENV = before;
    }
  });
});

describe("compacted SQLite room state", () => {
  it("compacts each room, ignores older revisions and rejects same-revision conflicts", async () => {
    const first = messageEvent("first preview");
    expect((await append(first)).status).toBe(200);
    expect(await (await append(first)).json()).toMatchObject({
      acceptedSeq: 1,
      duplicate: true,
    });
    const next = structuredClone(first);
    next.data.room.revision = 2;
    next.data.room.unreadCount = 1;
    expect(await (await append(next)).json()).toMatchObject({
      acceptedSeq: 2,
      duplicate: false,
    });
    expect(await (await append(first)).json()).toMatchObject({
      acceptedSeq: 2,
      duplicate: true,
    });
    const conflict = structuredClone(next);
    conflict.data.room.unreadCount = 0;
    conflict.data.room.lastReadSeq = 1;
    expect((await append(conflict)).status).toBe(409);
    expect(await inspect()).toMatchObject({ headSeq: 2, eventCount: 1 });
    await runInDurableObject(stub(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{
          envelope_json: string;
        }>("SELECT envelope_json FROM room_changes")
        .one();
      expect(JSON.parse(row.envelope_json)).toMatchObject({
        streamSeq: 2,
        data: { room: { unreadCount: 1 } },
      });
      expect(row.envelope_json).not.toContain('"message":');
    });
  });

  it("rejects legacy immutable envelopes and does not refresh TTL on retries", async () => {
    const update = event();
    expect(
      (
        await SELF.fetch("https://poc/internal/v1/users/1/events", {
          method: "POST",
          headers: internalHeaders(),
          body: JSON.stringify({ ...update, streamSeq: 1 }),
        })
      ).status,
    ).toBe(400);
    await append(update);
    const deadline = await runInDurableObject(
      stub(),
      (_instance, state) =>
        state.storage.sql
          .exec<{
            expires_at_ms: number;
          }>("SELECT expires_at_ms FROM room_changes")
          .one().expires_at_ms,
    );
    await append(update);
    expect(
      await runInDurableObject(
        stub(),
        (_instance, state) =>
          state.storage.sql
            .exec<{
              expires_at_ms: number;
            }>("SELECT expires_at_ms FROM room_changes")
            .one().expires_at_ms,
      ),
    ).toBe(deadline);
  });

  it("expires payloads and preserves revision watermarks against stale resurrection", async () => {
    const update = event(2);
    await append(update);
    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql.exec(
        "UPDATE room_changes SET expires_at_ms=?",
        Date.now() - 1,
      ),
    );
    expect(await inspect()).toMatchObject({
      headSeq: 1,
      eventCount: 0,
      replayFloor: 1,
      retentionMs: LIMITS.retentionMs,
    });
    expect(await (await append(update)).json()).toMatchObject({
      acceptedSeq: 1,
      duplicate: true,
    });
    expect(await inspect()).toMatchObject({ headSeq: 1, eventCount: 0 });
    update.data.room.revision = 3;
    expect(await (await append(update)).json()).toMatchObject({
      acceptedSeq: 2,
      duplicate: false,
    });
    expect(await inspect()).toMatchObject({
      headSeq: 2,
      eventCount: 1,
      replayFloor: 1,
    });
  });

  it("schedules expiry with no sockets and keeps epoch/state across actual eviction", async () => {
    await append(event());
    const before = await inspect();
    expect(
      await runInDurableObject(stub(), (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
    await evictDurableObject(stub());
    expect(await inspect()).toEqual(before);
    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql.exec(
        "UPDATE room_changes SET expires_at_ms=?",
        Date.now() - 1,
      ),
    );
    await runInDurableObject(stub(), (instance) => instance.alarm());
    expect(await inspect()).toMatchObject({
      eventCount: 0,
      replayFloor: 1,
      epoch: before.epoch,
    });
  });

  it("migrates legacy history to a new epoch without retaining old event payloads", async () => {
    const id = env.USER_REALTIME.idFromName(objectName(data(), "2"));
    await runInDurableObject(env.USER_REALTIME.get(id), (_instance, state) => {
      state.storage.sql.exec(
        "DROP TABLE sync_meta; CREATE TABLE events(stream_seq INTEGER PRIMARY KEY,envelope_json TEXT); INSERT INTO events VALUES(1,'legacy message body'); CREATE TABLE schema_meta(id INTEGER PRIMARY KEY, schema_version INTEGER); INSERT INTO schema_meta VALUES(1,2)",
      );
    });
    await evictDurableObject(stub("2"));
    const value = await inspect("2");
    expect(value).toMatchObject({ headSeq: 0, eventCount: 0, replayFloor: 0 });
    await runInDurableObject(stub("2"), (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{
            name: string;
          }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','schema_meta')",
          )
          .toArray(),
      ).toEqual([]);
    });
  });

  it("enforces routing identity without replacing stored state", async () => {
    await append(event());
    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql.exec("UPDATE sync_meta SET user_id='2'"),
    );
    const result = await stub().inspect("1");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DATASET_MISMATCH" },
    });
    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql.exec("UPDATE sync_meta SET user_id='1'"),
    );
  });
});

describe("compacted replay and immutable in-flight frames", () => {
  it("replays sparse coverage once per room and independently acknowledges two devices", async () => {
    const a = event();
    const b = event();
    await append(a);
    await append(b);
    a.data.room.revision = 2;
    await append(a);
    const fast = await connect();
    const slow = await connect();
    for (const client of [fast, slow]) {
      send(client.socket, { type: "resume", afterSeq: 0 });
      expect(await client.inbox.next()).toMatchObject({ type: "sync.started" });
    }
    const fastBatch = await fast.inbox.next();
    const slowBatch = await slow.inbox.next();
    expect(fastBatch).toMatchObject({ fromSeq: 1, toSeq: 3 });
    expect(fastBatch.events.map((entry: any) => entry.streamSeq)).toEqual([
      2, 3,
    ]);
    send(fast.socket, {
      type: "ack",
      batchId: fastBatch.batchId,
      throughSeq: 3,
    });
    expect(await fast.inbox.next()).toMatchObject({
      type: "sync.ready",
      throughSeq: 3,
    });
    expect(await inspect()).toMatchObject({ eventCount: 2 });
    send(slow.socket, {
      type: "ack",
      batchId: slowBatch.batchId,
      throughSeq: 3,
    });
    expect(await slow.inbox.next()).toMatchObject({ type: "sync.ready" });
    send(fast.socket, {
      type: "ack",
      batchId: fastBatch.batchId,
      throughSeq: 3,
    });
    a.data.room.revision = 3;
    await append(a);
    expect(await fast.inbox.next()).toMatchObject({ fromSeq: 4, toSeq: 4 });
  });

  it("retransmits identical bytes after a room overwrite and actual hibernation", async () => {
    const update = messageEvent("preview");
    await append(update);
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    const original = await client.inbox.next();
    update.data.room.revision = 2;
    update.data.room.unreadCount = 1;
    await append(update);
    await evictDurableObject(stub(), { webSockets: "hibernate" });
    await runInDurableObject(stub(), (_instance, state) => {
      const socket = state.getWebSockets()[0]!;
      const a = socket.deserializeAttachment() as any;
      a.inFlight.sentAt = Date.now() - LIMITS.ackMs - 1;
      socket.serializeAttachment(a);
    });
    await runInDurableObject(stub(), (instance) => instance.alarm());
    expect(await client.inbox.next()).toEqual(original);
    send(client.socket, {
      type: "ack",
      batchId: original.batchId,
      throughSeq: original.toSeq,
    });
    expect(await client.inbox.next()).toMatchObject({
      fromSeq: 2,
      toSeq: 2,
      events: [{ data: { room: { unreadCount: 1 } } }],
    });
  });

  it("rejects ACKs not matching the frozen batch and leaves its data replayable", async () => {
    await append(event());
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    const batch = await client.inbox.next();
    send(client.socket, {
      type: "ack",
      batchId: crypto.randomUUID(),
      throughSeq: batch.toSeq,
    });
    expect(await client.inbox.next()).toMatchObject({
      type: "error",
      code: "VALIDATION_ERROR",
    });
    expect(await inspect()).toMatchObject({ eventCount: 1 });
    await runInDurableObject(stub(), (_instance, state) =>
      expect(
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM inflight_batches")
          .one().n,
      ).toBe(0),
    );
  });

  it.each([
    {
      reason: "EPOCH_CHANGED",
      overrides: { epoch: "90000000-0000-4000-8000-000000000099" },
    },
    { reason: "CURSOR_AHEAD", overrides: { afterSeq: 2 } },
    {
      reason: "CURSOR_EXPIRED",
      overrides: {
        syncedAt: new Date(Date.now() - LIMITS.retentionMs - 1).toISOString(),
      },
    },
  ])("requires an HTTP snapshot for $reason", async ({ reason, overrides }) => {
    const client = await connect();
    const closed = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    send(client.socket, { type: "resume", afterSeq: 0, ...overrides });
    expect(await client.inbox.next()).toMatchObject({
      type: "sync.required",
      reason,
    });
    expect(await closed).toBe(4010);
  });

  it("requires a snapshot below the retention floor or for a large cursor distance", async () => {
    await append(event());
    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql.exec(
        "UPDATE room_changes SET expires_at_ms=?",
        Date.now() - 1,
      ),
    );
    const expired = await connect();
    send(expired.socket, { type: "resume", afterSeq: 0 });
    expect(await expired.inbox.next()).toMatchObject({
      type: "sync.required",
      reason: "CURSOR_EXPIRED",
    });
    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql.exec(
        "UPDATE sync_meta SET head_seq=?,replay_floor=0",
        LIMITS.maxDeltaGap + 1,
      ),
    );
    const large = await connect();
    send(large.socket, { type: "resume", afterSeq: 0 });
    expect(await large.inbox.next()).toMatchObject({
      type: "sync.required",
      reason: "DELTA_TOO_LARGE",
    });
  });

  it("bounds complete frames by bytes and count, including changes arriving during replay", async () => {
    for (let i = 0; i < 60; i++) await append(messageEvent("😀".repeat(2_000)));
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    let frame = await client.inbox.next();
    let total = 0;
    await append(event());
    while (frame.type === "events.batch") {
      expect(
        new TextEncoder().encode(JSON.stringify(frame)).byteLength,
      ).toBeLessThanOrEqual(LIMITS.batchBytes);
      expect(frame.events.length).toBeLessThanOrEqual(LIMITS.eventsPerBatch);
      total += frame.events.length;
      send(client.socket, {
        type: "ack",
        batchId: frame.batchId,
        throughSeq: frame.toSeq,
      });
      frame = await client.inbox.next();
    }
    expect(frame).toMatchObject({ type: "sync.ready", throughSeq: 61 });
    expect(total).toBe(61);
  });

  it("pages at 50 rooms and includes an unseen room compacted past the initial replay head", async () => {
    const updates = Array.from({ length: 60 }, () => event());
    for (const update of updates)
      expect((await append(update)).status).toBe(200);
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    expect(await client.inbox.next()).toMatchObject({
      type: "sync.started",
      targetSeq: 60,
      epoch: client.hello.epoch,
    });
    const first = await client.inbox.next();
    expect(first).toMatchObject({ fromSeq: 1, toSeq: 50 });
    expect(first.events).toHaveLength(50);
    updates[59]!.data.room.revision = 2;
    await append(updates[59]!);
    send(client.socket, {
      type: "ack",
      batchId: first.batchId,
      throughSeq: first.toSeq,
    });
    const second = await client.inbox.next();
    expect(second).toMatchObject({ fromSeq: 51, toSeq: 61 });
    expect(second.events).toHaveLength(10);
    expect(second.events.at(-1)).toMatchObject({
      streamSeq: 61,
      data: { room: { id: updates[59]!.data.room.id, revision: 2 } },
    });
    send(client.socket, {
      type: "ack",
      batchId: second.batchId,
      throughSeq: second.toSeq,
    });
    expect(await client.inbox.next()).toMatchObject({
      type: "sync.ready",
      throughSeq: 61,
    });
  });

  it("requires a new snapshot when object epoch changes under a hibernating socket", async () => {
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    await client.inbox.next();
    const closed = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql.exec(
        "UPDATE sync_meta SET epoch=?",
        crypto.randomUUID(),
      ),
    );
    await evictDurableObject(stub(), { webSockets: "hibernate" });
    // The next event reconstructs the object and compares the attachment epoch.
    await inspect();
    expect(await client.inbox.next()).toMatchObject({
      type: "sync.required",
      reason: "EPOCH_CHANGED",
    });
    expect(await closed).toBe(4010);
  });

  it("rolls back an append on SQL failure and never acknowledges a failed device ACK", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      // Inject at the version write, after the room row insert, to verify rollback.
      vi.spyOn(state.storage.sql, "exec").mockImplementation(((
        query: string,
        ...args: any[]
      ) => {
        if (query.startsWith("INSERT INTO room_versions"))
          throw new Error("Injected SQL failure");
        return exec(query, ...args);
      }) as typeof state.storage.sql.exec);
    });
    expect((await append(event())).status).toBe(503);
    vi.restoreAllMocks();
    expect(await inspect()).toMatchObject({ headSeq: 0, eventCount: 0 });
    await append(event());
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    const batch = await client.inbox.next();
    await runInDurableObject(stub(), (_instance, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      vi.spyOn(state.storage.sql, "exec").mockImplementation(((
        query: string,
        ...args: any[]
      ) => {
        if (query.startsWith("UPDATE devices SET max_ack_seq"))
          throw new Error("Injected ACK failure");
        return exec(query, ...args);
      }) as typeof state.storage.sql.exec);
    });
    send(client.socket, {
      type: "ack",
      batchId: batch.batchId,
      throughSeq: batch.toSeq,
    });
    expect(await client.inbox.next()).toMatchObject({
      type: "error",
      code: "DEPENDENCY_UNAVAILABLE",
    });
    vi.restoreAllMocks();
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{
            max_ack_seq: number;
          }>(
            "SELECT max_ack_seq FROM devices WHERE device_id=?",
            client.hello.deviceId,
          )
          .one().max_ack_seq,
      ).toBe(0);
    });
    expect(await inspect()).toMatchObject({ headSeq: 1, eventCount: 1 });
  });

  it("replaces only the same device and permits a restored cache below its historical ACK", async () => {
    await append(event());
    const device = crypto.randomUUID();
    const first = await connect("1", device);
    send(first.socket, { type: "resume", afterSeq: 0 });
    await first.inbox.next();
    const batch = await first.inbox.next();
    send(first.socket, {
      type: "ack",
      batchId: batch.batchId,
      throughSeq: batch.toSeq,
    });
    await first.inbox.next();
    const closed = new Promise<number>((resolve) =>
      first.socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    const restored = await connect("1", device);
    expect(await closed).toBe(4009);
    send(restored.socket, { type: "resume", afterSeq: 0 });
    await restored.inbox.next();
    expect(await restored.inbox.next()).toMatchObject({ fromSeq: 1, toSeq: 1 });
  });
});

describe("presence and deadlines", () => {
  it("does not postpone an existing presence sweep under repeated activity or hibernation", async () => {
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    await client.inbox.next();
    // Finish initial presence notification work so only the periodic sweep remains.
    await runInDurableObject(stub(), (instance) => instance.alarm());
    const originalDeadline = await runInDurableObject(
      stub(),
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(originalDeadline).not.toBeNull();
    const acceptedAt = originalDeadline! - LIMITS.sweepMs;
    const now = vi.spyOn(Date, "now");
    for (const elapsed of [5_000, 10_000, 15_000, 20_000]) {
      now.mockReturnValue(acceptedAt + elapsed);
      send(client.socket, { type: "presence.refresh" });
      expect(await client.inbox.next()).toMatchObject({
        type: "presence.snapshot",
      });
      expect(
        await runInDurableObject(stub(), (_instance, state) =>
          state.storage.getAlarm(),
        ),
      ).toBe(originalDeadline);
    }
    await evictDurableObject(stub(), { webSockets: "hibernate" });
    send(client.socket, { type: "presence.refresh" });
    expect(await client.inbox.next()).toMatchObject({
      type: "presence.snapshot",
    });
    expect(
      await runInDurableObject(stub(), (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(originalDeadline);
    now.mockReturnValue(originalDeadline!);
    await runInDurableObject(stub(), (instance) => instance.alarm());
    expect(
      await runInDurableObject(stub(), (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(originalDeadline! + LIMITS.sweepMs);
    now.mockRestore();
  });
  it("returns source observations and represents one failed dependency as unknown", async () => {
    await stub("2").localPresence("2");
    await runInDurableObject(stub("2"), (instance) => {
      vi.spyOn(instance, "localPresence").mockImplementation(() => {
        throw new Error("Injected dependency failure");
      });
    });
    const response = await SELF.fetch(
      "https://poc/internal/v1/presence/query",
      {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({ userIds: ["1", "2"] }),
      },
    );
    expect(await response.json()).toMatchObject({
      datasetId: data(),
      items: [
        { userId: "1", state: "offline" },
        { userId: "2", state: "unknown", activeDeviceCount: null },
      ],
    });
  });
  it("refreshes watched snapshots and computes silent-loss and session/resume deadlines", async () => {
    const { socket, inbox } = await connect();
    send(socket, { type: "resume", afterSeq: 0 });
    await inbox.next();
    await inbox.next();
    send(socket, { type: "presence.watch", userIds: ["1", "2"] });
    expect(await inbox.next()).toMatchObject({
      type: "presence.snapshot",
      items: [
        { userId: "1", state: "online" },
        { userId: "2", state: "offline" },
      ],
    });
    await runInDurableObject(stub(), (_instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const a = ws.deserializeAttachment() as any;
      a.resumedAt = Date.now() - LIMITS.leaseMs - 1;
      ws.serializeAttachment(a);
    });
    expect((await stub().localPresence("1")).state).toBe("offline");
    const other = await connect("2");
    await runInDurableObject(stub("2"), (_instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const a = ws.deserializeAttachment() as any;
      a.acceptedAt = Date.now() - LIMITS.resumeMs - 1;
      ws.serializeAttachment(a);
    });
    const closed = new Promise<number>((resolve) =>
      other.socket.addEventListener("close", (e) => resolve(e.code)),
    );
    await runDurableObjectAlarm(stub("2"));
    expect(await closed).toBe(4002);
  });
  it("delivers aggregated transitions and snapshots repair a failed notification", async () => {
    const observer = await connect("2");
    send(observer.socket, { type: "resume", afterSeq: 0 });
    await observer.inbox.next();
    await observer.inbox.next();
    send(observer.socket, { type: "presence.watch", userIds: ["1"] });
    expect(await observer.inbox.next()).toMatchObject({
      items: [{ userId: "1", state: "offline" }],
    });
    const first = await connect("1");
    send(first.socket, { type: "resume", afterSeq: 0 });
    await first.inbox.next();
    await first.inbox.next();
    await runDurableObjectAlarm(stub("1"));
    expect(await observer.inbox.next()).toMatchObject({
      type: "presence.changed",
      item: { userId: "1", state: "online", activeDeviceCount: 1 },
    });
    const second = await connect("1");
    send(second.socket, { type: "resume", afterSeq: 0 });
    await second.inbox.next();
    await second.inbox.next();
    await runDurableObjectAlarm(stub("1"));
    expect(await observer.inbox.next()).toMatchObject({
      item: { state: "online", activeDeviceCount: 2 },
    });
    // Drop one binding-only transition; a subsequent refresh is authoritative.
    await runInDurableObject(stub("2"), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const a = ws.deserializeAttachment() as any;
        a.watchIds = [];
        ws.serializeAttachment(a);
      }
    });
    const closed = new Promise<void>((resolve) =>
      first.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    first.socket.close(1000);
    await closed;
    await runInDurableObject(stub("1"), (instance) => instance.alarm());
    await runInDurableObject(stub("2"), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const a = ws.deserializeAttachment() as any;
        a.watchIds = ["1"];
        ws.serializeAttachment(a);
      }
    });
    send(observer.socket, { type: "presence.refresh" });
    expect(await observer.inbox.next()).toMatchObject({
      type: "presence.snapshot",
      items: [{ userId: "1", state: "online", activeDeviceCount: 1 }],
    });
    const finalClose = new Promise<void>((resolve) =>
      second.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    second.socket.close(1000);
    await finalClose;
    await runInDurableObject(stub("1"), (instance) => instance.alarm());
    expect(await observer.inbox.next()).toMatchObject({
      type: "presence.changed",
      item: { userId: "1", state: "offline", activeDeviceCount: 0 },
    });
  });
  it("closes authorization-expired sessions and retains the earlier ACK alarm", async () => {
    await append(event());
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    await client.inbox.next();
    await runInDurableObject(stub(), (instance) => instance.alarm());
    await runInDurableObject(stub(), async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm! - Date.now()).toBeLessThanOrEqual(LIMITS.ackMs);
      const ws = state.getWebSockets()[0]!;
      const a = ws.deserializeAttachment() as any;
      a.sessionExpiresAt = Date.now() - 1;
      ws.serializeAttachment(a);
    });
    const closed = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (e) => resolve(e.code)),
    );
    await runDurableObjectAlarm(stub());
    expect(await closed).toBe(4001);
    expect((await stub().localPresence("1")).state).toBe("offline");
  });
});

// These measure the real entry points, not hand-written approximations of their SQL.
// Cursor counters exclude schema/fixture setup and include all SQL in this object.
describe("SQL read budgets", () => {
  for (const roomCount of [1, 30, 100]) {
    it(`measures operations with ${roomCount} retained rooms`, async () => {
      const updates = Array.from({ length: roomCount }, () => event());
      for (const update of updates)
        expect((await append(update)).status).toBe(200);
      const measure = async (
        operation: "inspect" | "presence" | "append" | "alarm" | "resume",
      ) =>
        runInDurableObject(stub(), async (instance, state) => {
          const exec = state.storage.sql.exec.bind(state.storage.sql);
          const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] =
            [];
          const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation(((
            query: string,
            ...args: SqlStorageValue[]
          ) => {
            const cursor = exec(query, ...args);
            cursors.push(cursor);
            return cursor;
          }) as typeof state.storage.sql.exec);
          try {
            if (operation === "inspect") instance.inspect("1");
            if (operation === "presence") instance.localPresence("1");
            if (operation === "append") {
              const update = structuredClone(updates[0]!);
              update.data.room.revision = 2;
              expect(
                (await instance.append(JSON.stringify(update), "1")).ok,
              ).toBe(true);
            }
            if (operation === "alarm") await instance.alarm();
            if (operation === "resume") {
              const ws = state
                .getWebSockets()
                .find((s) => !(s.deserializeAttachment() as any).retired)!;
              await instance.webSocketMessage(
                ws,
                JSON.stringify({
                  v: 2,
                  type: "resume",
                  epoch: epochs.get(replay.socket),
                  afterSeq: 0,
                  syncedAt: new Date().toISOString(),
                }),
              );
            }
            return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
          } finally {
            spy.mockRestore();
          }
        });
      const reads: Record<string, number> = {};
      reads.inspect = await measure("inspect");
      reads.presence = await measure("presence");
      reads.append = await measure("append");
      const live = await connect();
      send(live.socket, { type: "resume", afterSeq: roomCount + 1 });
      expect((await live.inbox.next()).type).toBe("sync.started");
      expect((await live.inbox.next()).type).toBe("sync.ready");
      await runInDurableObject(stub(), (instance) => instance.alarm());
      reads.idleAlarm = await measure("alarm");
      // Close the caught-up device before measuring a fresh device's replay.
      const closed = new Promise<void>((resolve) =>
        live.socket.addEventListener("close", () => resolve(), { once: true }),
      );
      live.socket.close(1000);
      await closed;
      const replay = await connect();
      reads.replayFirstPage = await measure("resume");
      expect((await replay.inbox.next()).type).toBe("sync.started");
      let frame = await replay.inbox.next();
      let through = 0;
      while (frame.type === "events.batch") {
        through = frame.toSeq;
        send(replay.socket, {
          type: "ack",
          batchId: frame.batchId,
          throughSeq: through,
        });
        frame = await replay.inbox.next();
      }
      expect(frame.type).toBe("sync.ready");
      expect(through).toBe(roomCount + 1);
      expect(await inspect()).toMatchObject({
        eventCount: roomCount,
        headSeq: roomCount + 1,
      });
      expect(reads).toMatchSnapshot();
      expect(reads.inspect).toBeLessThanOrEqual(5);
      expect(reads.idleAlarm).toBeLessThanOrEqual(7);
      expect(reads.append).toBeLessThanOrEqual(11);
      expect(reads.replayFirstPage).toBeLessThanOrEqual(65);
    });
  }
});

describe("optimized retention and counter migration", () => {
  it("keeps compacted payloads until their exact 48-hour deadline and never extends duplicate TTL", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const store = new EventStore(state.storage);
      const base = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);
      const a = event(),
        b = event();
      const check = (count: number, floor: number) => {
        expect(store.inspect()).toMatchObject({
          eventCount: count,
          replayFloor: floor,
        });
        expect(
          state.storage.sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM room_changes")
            .one().n,
        ).toBe(count);
      };
      try {
        await store.append(JSON.stringify(a), data(), "1");
        clock.mockReturnValue(base + 3_600_000);
        await store.append(JSON.stringify(b), data(), "1");
        clock.mockReturnValue(base + 7_200_000);
        a.data.room.revision = 2;
        await store.append(JSON.stringify(a), data(), "1");
        check(2, 0);
        clock.mockReturnValue(base + LIMITS.retentionMs);
        check(2, 0); // The overwritten A1's deadline no longer expires A2.
        clock.mockReturnValue(base + LIMITS.retentionMs + 3_600_000 - 1);
        check(2, 0);
        const epoch = store.meta().epoch;
        expect(store.createBatch(crypto.randomUUID(), 0)?.events).toHaveLength(
          2,
        );
        clock.mockReturnValue(base + LIMITS.retentionMs + 3_600_000);
        check(1, 2);
        expect(
          store.fullSyncReason(epoch, 0, new Date(Date.now()).toISOString()),
        ).toBe("CURSOR_EXPIRED");
        clock.mockReturnValue(base + LIMITS.retentionMs + 7_200_000 - 1);
        expect(
          (await store.append(JSON.stringify(a), data(), "1")).duplicate,
        ).toBe(true);
        check(1, 2);
        clock.mockReturnValue(base + LIMITS.retentionMs + 7_200_000);
        check(0, 3); // Exact 48h since A2 acceptance, despite its recent retry.
        expect(
          (await store.append(JSON.stringify(a), data(), "1")).duplicate,
        ).toBe(true);
        check(0, 3);
        expect(
          store.fullSyncReason(
            epoch,
            3,
            new Date(Date.now() - LIMITS.retentionMs).toISOString(),
          ),
        ).toBe("CURSOR_EXPIRED");
        expect(
          store.fullSyncReason(epoch, 3, new Date(Date.now()).toISOString()),
        ).toBeNull();
        a.data.room.revision = 3;
        await store.append(JSON.stringify(a), data(), "1");
        check(1, 3);
        expect(store.createBatch(crypto.randomUUID(), 3)).toMatchObject({
          fromSeq: 4,
          toSeq: 4,
          events: [{ data: { room: { revision: 3 } } }],
        });
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("migrates schema3 additively across hibernation without changing the epoch or in-flight bytes", async () => {
    await append(event());
    const client = await connect();
    send(client.socket, { type: "resume", afterSeq: 0 });
    await client.inbox.next();
    const batch = await client.inbox.next();
    const before = await inspect();
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(
        "ALTER TABLE sync_meta DROP COLUMN retained_count; UPDATE sync_meta SET schema_version=3 WHERE id=1",
      );
    });
    await evictDurableObject(stub(), { webSockets: "hibernate" });
    expect(await inspect()).toEqual(before);
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{
            schema_version: number;
            retained_count: number;
          }>("SELECT schema_version,retained_count FROM sync_meta")
          .one(),
      ).toEqual({ schema_version: 4, retained_count: 1 });
      expect(
        JSON.parse(
          state.storage.sql
            .exec<{
              batch_json: string;
            }>("SELECT batch_json FROM inflight_batches")
            .one().batch_json,
        ),
      ).toEqual(batch);
    });
    send(client.socket, {
      type: "ack",
      batchId: batch.batchId,
      throughSeq: batch.toSeq,
    });
    expect(await client.inbox.next()).toMatchObject({
      type: "sync.ready",
      throughSeq: 1,
    });
    expect(await inspect()).toEqual(before); // ACK cannot decrement retention.
    await evictDurableObject(stub(), { webSockets: "hibernate" });
    expect(await inspect()).toEqual(before);
  });

  it("rolls back the replay floor and retained count together when expiry deletion fails", async () => {
    await append(event());
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_changes SET expires_at_ms=?",
        Date.now() - 1,
      );
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      vi.spyOn(state.storage.sql, "exec").mockImplementation(((
        query: string,
        ...args: SqlStorageValue[]
      ) => {
        if (query.startsWith("DELETE FROM room_changes"))
          throw new Error("Injected retention deletion failure");
        return exec(query, ...args);
      }) as typeof state.storage.sql.exec);
    });
    expect(await stub().inspect("1")).toMatchObject({ ok: false, status: 503 });
    vi.restoreAllMocks();
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT replay_floor,retained_count FROM sync_meta")
          .one(),
      ).toEqual({ replay_floor: 0, retained_count: 1 });
      expect(
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM room_changes")
          .one().n,
      ).toBe(1);
    });
    expect(await inspect()).toMatchObject({
      eventCount: 0,
      replayFloor: 1,
      headSeq: 1,
    });
  });
});
