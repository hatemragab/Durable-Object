import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { INestApplication, LoggerService } from "@nestjs/common";
import {
  DEFAULTS,
  parseRoomUpdate,
  type RoomDto,
  type UserId,
} from "@chat-poc/contracts";
import { createApp } from "../src/app.js";
import { readConfig, type AppConfig } from "../src/config/config.js";
import {
  RoomProjectionDispatcher,
  PublicationProbe,
} from "../src/room-sync/dispatcher.service.js";
import { RoomsService } from "../src/rooms/rooms.service.js";
import {
  MessagesService,
  MutationProbe,
  type Identity,
} from "../src/messages/messages.service.js";
import { SessionService } from "../src/dev-session/session.service.js";
import {
  RealtimeClient,
  type WorkerFetch,
} from "../src/realtime/realtime.client.js";
import { ApiError } from "../src/common/errors.js";

class WorkerFixture {
  readonly projections = new Map<
    UserId,
    Map<string, { room: RoomDto; seq: number; json: string }>
  >([
    ["1", new Map()],
    ["2", new Map()],
    ["3", new Map()],
  ]);
  readonly heads = new Map<UserId, number>([
    ["1", 0],
    ["2", 0],
    ["3", 0],
  ]);
  epoch = randomUUID();
  readonly failures = new Set<UserId>();
  readonly dropAfterAccept = new Set<UserId>();
  readonly inFlight = new Map<UserId, number>();
  readonly maxInFlight = new Map<UserId, number>();
  invalidHead = false;
  legacyHead = false;
  malformedAppend = false;
  readonly publicationConflicts = new Set<UserId>();
  beforeAppend: (() => Promise<void>) | undefined;
  afterHead: (() => Promise<void>) | undefined;
  constructor(readonly config: AppConfig) {}
  json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  readonly fetch: WorkerFetch = async (input, options) => {
    const url = new URL(String(input)),
      headers = new Headers(options?.headers);
    if (
      headers.get("Authorization") !== `Bearer ${this.config.internalSecret}` ||
      headers.get("X-Dataset-Id") !== this.config.datasetId
    )
      return this.json({ error: { code: "UNAUTHORIZED" } }, 401);
    if (url.pathname === "/internal/v1/presence/query") {
      const { userIds } = JSON.parse(String(options?.body)) as {
        userIds: UserId[];
      };
      return this.json({
        datasetId: this.config.datasetId,
        items: userIds.map((userId) => ({
          userId,
          state: "offline",
          activeDeviceCount: 0,
          connectionCount: 0,
          revision: 1,
          observedAt: new Date().toISOString(),
        })),
      });
    }
    const match = /^\/internal\/v1\/users\/([123])\/(events|stream)$/.exec(
      url.pathname,
    );
    if (!match) return this.json({}, 404);
    const userId = match[1] as UserId;
    if (this.failures.has(userId))
      throw new Error("Injected transport timeout");
    const projections = this.projections.get(userId)!,
      headSeq = this.heads.get(userId)!;
    if (match[2] === "stream") {
      if (this.legacyHead)
        return this.json({
          datasetId: this.config.datasetId,
          userId,
          headSeq,
          retainedFromSeq: 1,
          eventCount: headSeq,
        });
      const result = this.json({
        datasetId: this.config.datasetId,
        userId,
        epoch: this.epoch,
        headSeq,
        replayFloor: this.invalidHead ? headSeq + 1 : 0,
        retainedFromSeq: 1,
        eventCount: projections.size,
        retentionMs: DEFAULTS.eventRetentionMs,
      });
      await this.afterHead?.();
      return result;
    }
    if (this.publicationConflicts.has(userId))
      return this.json({ error: { code: "EVENT_CONFLICT" } }, 409);
    this.inFlight.set(userId, (this.inFlight.get(userId) ?? 0) + 1);
    this.maxInFlight.set(
      userId,
      Math.max(this.inFlight.get(userId)!, this.maxInFlight.get(userId) ?? 0),
    );
    try {
      await this.beforeAppend?.();
      const json = String(options?.body),
        update = parseRoomUpdate(JSON.parse(json)),
        prior = projections.get(update.data.room.id);
      if (
        prior &&
        prior.room.revision === update.data.room.revision &&
        prior.json !== json
      )
        return this.json({ error: { code: "EVENT_CONFLICT" } }, 409);
      const duplicate =
        !!prior && prior.room.revision >= update.data.room.revision;
      const acceptedSeq = duplicate ? prior!.seq : headSeq + 1;
      if (!duplicate) {
        projections.set(update.data.room.id, {
          room: update.data.room,
          seq: acceptedSeq,
          json,
        });
        this.heads.set(userId, acceptedSeq);
      }
      if (this.dropAfterAccept.delete(userId))
        throw new Error("Injected lost acceptance response");
      if (this.malformedAppend)
        return this.json({
          datasetId: this.config.datasetId,
          userId,
          acceptedSeq,
        });
      return this.json({
        datasetId: this.config.datasetId,
        userId,
        epoch: this.epoch,
        acceptedSeq,
        headSeq: this.heads.get(userId),
        duplicate,
      });
    } finally {
      this.inFlight.set(userId, this.inFlight.get(userId)! - 1);
    }
  };
}
function testConfig(): AppConfig {
  const mongo = new URL(
    process.env.TEST_MONGO_URI ??
      "mongodb://127.0.0.1:27028/chat_poc_tests?replicaSet=rs0&directConnection=true",
  );
  mongo.pathname = `/chat_poc_test_${randomUUID().replaceAll("-", "")}`;
  return readConfig({
    APP_ENV: "development",
    DATASET_ID: randomUUID(),
    MONGO_URI: mongo.toString(),
    DEV_SESSION_SECRET: `session-${randomUUID()}`,
    WS_TICKET_SECRET: `ticket-${randomUUID()}`,
    REALTIME_INTERNAL_SECRET: `internal-${randomUUID()}`,
    REALTIME_BASE_URL: "http://127.0.0.1:8787",
    HOST: "127.0.0.1",
  });
}
function identity(userId: UserId = "1"): Identity {
  return {
    userId,
    deviceId: randomUUID(),
    sessionExp: Math.floor(Date.now() / 1000) + 3600,
  };
}
async function fixture(
  config = testConfig(),
  logger: LoggerService | false = false,
) {
  const worker = new WorkerFixture(config);
  return {
    config,
    worker,
    app: await createApp(config, {
      logger,
      relay: false,
      workerFetch: worker.fetch,
    }),
  };
}
async function token(
  app: INestApplication,
  userId: UserId = "1",
): Promise<string> {
  return (await app.get(SessionService).issue(userId, randomUUID()))
    .sessionToken as string;
}
async function snapshot(app: INestApplication) {
  const rooms = app.get(RoomsService);
  return {
    rooms: await rooms.rooms.find().sort({ _id: 1 }).lean(),
    members: await rooms.members.find().sort({ _id: 1 }).lean(),
    users: await rooms.users.find().sort({ _id: 1 }).lean(),
    messages: await app
      .get(MessagesService)
      .messages.find()
      .sort({ _id: 1 })
      .lean(),
  };
}

describe("Mongo authority, room projections and unread state", () => {
  let app: INestApplication,
    worker: WorkerFixture,
    rooms: RoomsService,
    messages: MessagesService;
  beforeAll(async () => {
    ({ app, worker } = await fixture());
    rooms = app.get(RoomsService);
    messages = app.get(MessagesService);
  });
  afterAll(async () => {
    await app.close();
  });
  const group = () =>
    rooms.group("1", "Projection test", ["2", "3"], randomUUID());
  test("creates only current-state collections and three users", async () => {
    expect(await rooms.users.countDocuments()).toBe(3);
    const names = (
      await rooms.rooms.db.db!.listCollections({}, { nameOnly: true }).toArray()
    ).map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "room_members",
        "messages",
        "rooms",
        "users",
        "dataset_metadata",
      ]),
    );
    expect(names).not.toContain("event_outbox");
  });
  test("direct-room races create one room and exactly two membership projections", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        rooms.direct(i % 2 ? "2" : "1", i % 2 ? "1" : "2"),
      ),
    );
    expect(new Set(results.map((result) => result.room.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(
      await rooms.members.countDocuments({ roomId: results[0]!.room.id }),
    ).toBe(2);
  });
  test("group retries preserve identity and reject different content", async () => {
    const key = randomUUID(),
      first = await rooms.group("1", "  One  ", ["2"], key),
      retry = await rooms.group("1", "One", ["2"], key);
    expect(retry.created).toBe(false);
    expect(retry.room).toEqual(first.room);
    await expect(
      rooms.group("1", "Different", ["2"], key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  test("one message increments every room revision, unread only recipients, with no event collection", async () => {
    const { room } = await group();
    const result = await messages.send(
      identity(),
      room.id,
      randomUUID(),
      "Hello مرحبا 👋",
    );
    expect(result.room).toMatchObject({
      revision: 2,
      unreadCount: 0,
      lastReadSeq: 0,
      lastMessageSeq: 1,
    });
    expect(await rooms.get("2", room.id)).toMatchObject({
      revision: 2,
      unreadCount: 1,
      lastReadSeq: 0,
    });
    expect(await rooms.get("3", room.id)).toMatchObject({
      revision: 2,
      unreadCount: 1,
    });
    expect(await rooms.members.countDocuments({ roomId: room.id })).toBe(3);
    expect(
      await rooms.rooms.db
        .db!.listCollections({ name: "event_outbox" })
        .toArray(),
    ).toEqual([]);
  });
  test("message idempotency does not increment unread or room revision twice", async () => {
    const { room } = await group(),
      id = randomUUID(),
      first = await messages.send(identity(), room.id, id, "Stable");
    const before = await snapshot(app),
      second = await messages.send(identity(), room.id, id, "Stable");
    expect(second.duplicate).toBe(true);
    expect(second.message).toEqual(first.message);
    expect(await snapshot(app)).toEqual(before);
    await expect(
      messages.send(identity(), room.id, id, "Changed"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  test.each(["room", "message", "summary", "members"])(
    "rollback at %s preserves message, room, counters and membership states",
    async (stage) => {
      const { room } = await group(),
        before = await snapshot(app),
        probe = jest
          .spyOn(app.get(MutationProbe), "check")
          .mockImplementation((actual) => {
            if (actual === stage) throw new Error("Injected rollback");
          });
      try {
        await expect(
          messages.send(identity(), room.id, randomUUID(), "Rollback"),
        ).rejects.toThrow("Injected rollback");
      } finally {
        probe.mockRestore();
      }
      expect(await snapshot(app)).toEqual(before);
    },
  );
  test("concurrent sends allocate contiguous room sequences and exact unread counts", async () => {
    const { room } = await group();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        messages.send(
          identity(i % 2 ? "1" : "2"),
          room.id,
          randomUUID(),
          `Concurrent ${i}`,
        ),
      ),
    );
    expect(results.map((r) => r.message.roomSeq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(await rooms.get("1", room.id)).toMatchObject({
      unreadCount: 6,
      revision: 13,
    });
    expect(await rooms.get("2", room.id)).toMatchObject({
      unreadCount: 6,
      revision: 13,
    });
    expect(await rooms.get("3", room.id)).toMatchObject({
      unreadCount: 12,
      revision: 13,
    });
  });
  test("own sends do not clear older unread messages", async () => {
    const { room } = await group();
    await messages.send(identity("2"), room.id, randomUUID(), "Unread");
    await messages.send(identity(), room.id, randomUUID(), "My reply");
    expect(await rooms.get("1", room.id)).toMatchObject({
      unreadCount: 1,
      lastReadSeq: 0,
    });
  });
  test("read cursor is monotonic, excludes own messages, changes only this account and preserves room ordering", async () => {
    const { room } = await group();
    for (const id of ["2", "1", "2", "3"] as const)
      await messages.send(identity(id), room.id, randomUUID(), "Read boundary");
    const before = await rooms.get("1", room.id),
      peer = await rooms.get("2", room.id),
      read = await messages.read("1", room.id, 2);
    expect(read).toMatchObject({
      unreadCount: 2,
      lastReadSeq: 2,
      revision: before.revision + 1,
      updatedAt: before.updatedAt,
      version: before.version,
    });
    expect(await messages.read("1", room.id, 1)).toEqual(read);
    expect(await rooms.get("2", room.id)).toEqual(peer);
    expect(await messages.read("1", room.id, 4)).toMatchObject({
      unreadCount: 0,
      lastReadSeq: 4,
    });
  });
  test("concurrent read and send retain all later unread messages", async () => {
    const { room } = await group();
    await messages.send(identity("2"), room.id, randomUUID(), "First");
    await Promise.all([
      messages.read("1", room.id, 1),
      messages.send(identity("2"), room.id, randomUUID(), "Second"),
    ]);
    expect(await rooms.get("1", room.id)).toMatchObject({
      lastReadSeq: 1,
      unreadCount: 1,
    });
  });
  test("failed read transaction preserves unread state", async () => {
    const { room } = await group();
    await messages.send(identity("2"), room.id, randomUUID(), "Unread");
    const before = await snapshot(app),
      probe = jest
        .spyOn(app.get(MutationProbe), "check")
        .mockImplementation((stage) => {
          if (stage === "read") throw new Error("Read rollback");
        });
    try {
      await expect(messages.read("1", room.id, 1)).rejects.toThrow(
        "Read rollback",
      );
    } finally {
      probe.mockRestore();
    }
    expect(await snapshot(app)).toEqual(before);
  });
  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid read cursor %s",
    async (value) => {
      const { room } = await group();
      await expect(messages.read("1", room.id, value)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    },
  );
  test("rejects read cursor beyond room head", async () => {
    const { room } = await group();
    await expect(messages.read("1", room.id, 1)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
  test("history has latest30 authoritative range, stable strict pagination and no unread side effect", async () => {
    const { room } = await group();
    for (let i = 0; i < 35; i++)
      await messages.send(identity("2"), room.id, randomUUID(), `History ${i}`);
    const before = await rooms.get("1", room.id),
      newest = await messages.history("1", room.id, 30);
    expect(newest.messages).toHaveLength(30);
    expect(newest.messages[0]!.roomSeq).toBe(6);
    expect(newest.window).toEqual({ fromRoomSeq: 6, throughRoomSeq: 35 });
    expect(newest.nextBeforeRoomSeq).toBe(6);
    const older = await messages.history("1", room.id, 30, 6);
    expect(older.messages.map((m) => m.roomSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(older.window).toEqual({ fromRoomSeq: 1, throughRoomSeq: 5 });
    expect(older.hasMore).toBe(false);
    expect(await rooms.get("1", room.id)).toEqual(before);
  });
  test("empty message page has an empty covered range", async () => {
    const { room } = await group();
    expect(await messages.history("1", room.id, 30)).toMatchObject({
      messages: [],
      window: { fromRoomSeq: 1, throughRoomSeq: 0 },
    });
  });
  test("room list defaults20, keyset pagination has no duplicates and ties sort by room id", async () => {
    for (let i = 0; i < 23; i++) await group();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await rooms.list("1", 20, cursor);
      expect(page.rooms.length).toBeLessThanOrEqual(20);
      seen.push(...page.rooms.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(
      await rooms.members.countDocuments({ userId: "1" }),
    );
  });
  test("room snapshot captures Worker barrier BEFORE Mongo snapshot", async () => {
    const { room } = await group(),
      beforeHead = worker.heads.get("1")!;
    worker.afterHead = async () => {
      worker.afterHead = undefined;
      await messages.send(
        identity("2"),
        room.id,
        randomUUID(),
        "Commit after barrier",
      );
    };
    const page = await rooms.list("1", 100);
    expect(page.sync.throughSeq).toBe(beforeHead);
    expect(page.rooms.find((item) => item.id === room.id)?.lastMessageSeq).toBe(
      1,
    );
  });
  test.each([
    "bad!",
    "e30",
    Buffer.from(
      JSON.stringify({ roomId: "not-a-uuid", updatedAt: "today" }),
    ).toString("base64url"),
  ])("rejects malformed cursor %s", async (cursor) => {
    await expect(rooms.list("1", 20, cursor)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
  test("a missing Worker blocks a new synchronization barrier but Mongo message writes remain available", async () => {
    const { room } = await group();
    worker.failures.add("1");
    try {
      await expect(rooms.list("1")).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });
      expect(
        (
          await messages.send(
            identity(),
            room.id,
            randomUUID(),
            "Available Mongo",
          )
        ).message.roomSeq,
      ).toBe(1);
    } finally {
      worker.failures.delete("1");
    }
  });
  test("membership blocks outsiders for reads, writes and read cursors", async () => {
    const { room } = await rooms.direct("1", "2");
    await expect(rooms.get("3", room.id)).rejects.toMatchObject({
      code: "ROOM_FORBIDDEN",
    });
    await expect(messages.history("3", room.id, 30)).rejects.toMatchObject({
      code: "ROOM_FORBIDDEN",
    });
    await expect(
      messages.send(identity("3"), room.id, randomUUID(), "Forbidden"),
    ).rejects.toMatchObject({ code: "ROOM_FORBIDDEN" });
    await expect(messages.read("3", room.id, 0)).rejects.toMatchObject({
      code: "ROOM_FORBIDDEN",
    });
  });
  test("HTTP default page sizes, read route, strict queries and identity validation", async () => {
    const authorization = `Bearer ${await token(app)}`,
      { room } = await group();
    await messages.send(identity("2"), room.id, randomUUID(), "HTTP unread");
    const list = await request(app.getHttpServer())
      .get("/api/v1/rooms")
      .set("Authorization", authorization)
      .expect(200);
    expect(list.body.rooms).toHaveLength(20);
    expect(list.body.sync.epoch).toBe(worker.epoch);
    const history = await request(app.getHttpServer())
      .get(`/api/v1/rooms/${room.id}/messages`)
      .set("Authorization", authorization)
      .expect(200);
    expect(history.body.window).toEqual({ fromRoomSeq: 1, throughRoomSeq: 1 });
    const read = await request(app.getHttpServer())
      .post(`/api/v1/rooms/${room.id}/read`)
      .set("Authorization", authorization)
      .send({ throughRoomSeq: 1 })
      .expect(200);
    expect(read.body.room.unreadCount).toBe(0);
    for (const path of [
      "/rooms?limit=101",
      "/rooms?extra=1",
      `/rooms/${room.id}/messages?beforeRoomSeq=0`,
    ])
      await request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .set("Authorization", authorization)
        .expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${room.id}/read`)
      .set("Authorization", authorization)
      .send({ throughRoomSeq: "1" })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/rooms/${room.id}/messages`)
      .set("Authorization", authorization)
      .send({ clientMessageId: randomUUID(), text: "Invalid", senderId: "2" })
      .expect(400);
    await request(app.getHttpServer()).get("/api/v1/rooms").expect(401);
  });
  test("API tickets are short-lived websocket credentials and never internal credentials", async () => {
    const authorization = `Bearer ${await token(app)}`;
    const ticket = await request(app.getHttpServer())
      .post("/api/v1/realtime/ticket")
      .set("Authorization", authorization)
      .send({})
      .expect(200);
    expect(ticket.body.ticket).toEqual(expect.any(String));
    expect(ticket.body.ticket).not.toBe(worker.config.internalSecret);
    await request(app.getHttpServer())
      .get("/api/v1/rooms")
      .set("Authorization", `Bearer ${ticket.body.ticket}`)
      .expect(401);
  });
});

describe("recoverable compact current-state relay", () => {
  test("reduces idle head checks while publishing dirty state immediately and repairing a replaced epoch", async () => {
    const { app, worker } = await fixture();
    const head = jest.spyOn(app.get(RealtimeClient), "head");
    const clock = jest.spyOn(Date, "now");
    let now = Date.now();
    clock.mockImplementation(() => now);
    try {
      const relay = app.get(RoomProjectionDispatcher),
        rooms = app.get(RoomsService);
      const { room } = await rooms.direct("1", "2");
      await relay.tick("1");
      expect(head).toHaveBeenCalledTimes(1);
      expect(worker.heads.get("1")).toBe(1);
      await app
        .get(MessagesService)
        .send(identity(), room.id, randomUUID(), "Immediate dirty state");
      now += 1_000;
      await relay.tick("1");
      expect(head).toHaveBeenCalledTimes(1);
      expect(
        worker.projections.get("1")!.get(room.id)?.room.lastMessageSeq,
      ).toBe(1);
      now += DEFAULTS.reconcileIntervalMs - 1_001;
      await relay.tick("1");
      expect(head).toHaveBeenCalledTimes(1);
      const oldEpoch = worker.epoch;
      worker.epoch = randomUUID();
      worker.projections.get("1")!.clear();
      worker.heads.set("1", 0);
      now += 1;
      await relay.tick("1");
      expect(DEFAULTS.reconcileIntervalMs).toBe(300_000);
      expect(head).toHaveBeenCalledTimes(2);
      expect(worker.epoch).not.toBe(oldEpoch);
      expect(
        worker.projections.get("1")!.get(room.id)?.room.lastMessageSeq,
      ).toBe(1);
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(false);
      await relay.tick("1", true);
      expect(head).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
      head.mockRestore();
      await app.close();
    }
  });
  test("coalesces many offline writes into one latest room projection per user", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        messages = app.get(MessagesService),
        relay = app.get(RoomProjectionDispatcher),
        { room } = await rooms.direct("1", "2");
      for (let i = 0; i < 8; i++)
        await messages.send(
          identity(),
          room.id,
          randomUUID(),
          `Coalesced ${i}`,
        );
      await Promise.all([relay.tick("1", true), relay.tick("2", true)]);
      expect(worker.projections.get("1")!.size).toBe(1);
      expect(worker.heads.get("1")).toBe(1);
      expect(worker.projections.get("2")!.get(room.id)?.room).toMatchObject({
        lastMessageSeq: 8,
        unreadCount: 8,
        revision: 9,
      });
      expect(await rooms.members.countDocuments({ dirty: true })).toBe(0);
    } finally {
      await app.close();
    }
  });
  test("lost acceptance response retries idempotently without retaining a Mongo event", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        relay = app.get(RoomProjectionDispatcher),
        { room } = await rooms.direct("1", "2");
      worker.dropAfterAccept.add("1");
      await relay.tick("1", true);
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(true);
      await relay.tick("1", true);
      expect(worker.heads.get("1")).toBe(1);
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(false);
    } finally {
      await app.close();
    }
  });
  test("crash after acceptance before publication mark leaves recoverable dirty state", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        relay = app.get(RoomProjectionDispatcher),
        { room } = await rooms.direct("1", "2"),
        probe = jest
          .spyOn(app.get(PublicationProbe), "check")
          .mockImplementation(() => {
            throw new Error("Process crash boundary");
          });
      await relay.tick("1", true);
      probe.mockRestore();
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(true);
      await relay.tick("1", true);
      expect(worker.heads.get("1")).toBe(1);
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(false);
    } finally {
      await app.close();
    }
  });
  test("concurrent update during publish cannot clear the newer dirty revision", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        messages = app.get(MessagesService),
        relay = app.get(RoomProjectionDispatcher),
        { room } = await rooms.direct("1", "2");
      worker.beforeAppend = async () => {
        worker.beforeAppend = undefined;
        await messages.send(
          identity("2"),
          room.id,
          randomUUID(),
          "Concurrent publication",
        );
      };
      await relay.tick("1", true);
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(true);
      await relay.tick("1", true);
      expect(worker.projections.get("1")!.get(room.id)?.room.unreadCount).toBe(
        1,
      );
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(false);
    } finally {
      await app.close();
    }
  });
  test("one unavailable user does not block others and each user has one relay owner", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        relay = app.get(RoomProjectionDispatcher);
      await rooms.direct("1", "2");
      worker.failures.add("1");
      await Promise.all([
        relay.tick("1", true),
        ...Array.from({ length: 10 }, () => relay.tick("2", true)),
      ]);
      expect(worker.heads.get("1")).toBe(0);
      expect(worker.heads.get("2")).toBe(1);
      expect(worker.maxInFlight.get("2")).toBe(1);
      expect(await relay.diagnostics("1")).toMatchObject({
        pendingRoomCount: 1,
        dependencyStatus: { realtime: "unavailable" },
      });
    } finally {
      await app.close();
    }
  });
  test("restart after committed mutation resumes current dirty projections", async () => {
    const { app, config, worker } = await fixture();
    let restarted: INestApplication | undefined;
    try {
      const { room } = await app.get(RoomsService).direct("1", "2");
      await app
        .get(MessagesService)
        .send(identity(), room.id, randomUUID(), "Durable current state");
      await app.close();
      restarted = await createApp(config, {
        logger: false,
        relay: false,
        workerFetch: worker.fetch,
      });
      await restarted.get(RoomProjectionDispatcher).tick("1", true);
      expect(
        worker.projections.get("1")!.get(room.id)?.room.lastMessageSeq,
      ).toBe(1);
      expect(
        (await restarted.get(RoomsService).requireMemberState("1", room.id))
          .dirty,
      ).toBe(false);
    } finally {
      await restarted?.close();
      if (!restarted) await app.close();
    }
  });
  test("replaced Durable Object epoch republishes current snapshots without message history", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        relay = app.get(RoomProjectionDispatcher),
        { room } = await rooms.direct("1", "2");
      await relay.tick("1", true);
      worker.epoch = randomUUID();
      worker.heads.set("1", 0);
      worker.projections.get("1")!.clear();
      await relay.tick("1", true);
      expect(
        worker.projections.get("1")!.get(room.id)?.room.lastMessageSeq,
      ).toBe(0);
      expect(
        (await rooms.requireMemberState("1", room.id)).publishedEpoch,
      ).toBe(worker.epoch);
    } finally {
      await app.close();
    }
  });
  test.each(["invalidHead", "legacyHead"] as const)(
    "%s is retryable during staged rollout and recovers without restart or data loss",
    async (flag) => {
      const { app, worker } = await fixture();
      try {
        const rooms = app.get(RoomsService),
          relay = app.get(RoomProjectionDispatcher),
          { room } = await rooms.direct("1", "2");
        await app
          .get(MessagesService)
          .send(
            identity("2"),
            room.id,
            randomUUID(),
            "Retain authoritative state during deployment",
          );
        const before = await snapshot(app);
        worker[flag] = true;
        await expect(app.get(RealtimeClient).head("1")).rejects.toMatchObject({
          status: 503,
          code: "DEPENDENCY_UNAVAILABLE",
          retryable: true,
        });
        await relay.tick("1", true);
        expect(await relay.diagnostics("1")).toMatchObject({
          blockedCode: null,
          pendingRoomCount: 1,
          dependencyStatus: { realtime: "unavailable" },
        });
        expect(await snapshot(app)).toEqual(before);
        worker[flag] = false;
        await relay.tick("1", true);
        expect(await relay.diagnostics("1")).toMatchObject({
          blockedCode: null,
          pendingRoomCount: 0,
          dependencyStatus: { realtime: "available" },
        });
        expect(worker.projections.get("1")!.get(room.id)?.room).toMatchObject({
          unreadCount: 1,
          lastMessageSeq: 1,
        });
        const after = await snapshot(app);
        expect(after.rooms).toEqual(before.rooms);
        expect(after.messages).toEqual(before.messages);
        expect(after.users).toEqual(before.users);
      } finally {
        await app.close();
      }
    },
  );
  test("malformed acceptance keeps current state dirty and retries the accepted revision", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        relay = app.get(RoomProjectionDispatcher),
        { room } = await rooms.direct("1", "2"),
        before = await snapshot(app);
      worker.malformedAppend = true;
      await relay.tick("1", true);
      expect(await relay.diagnostics("1")).toMatchObject({
        blockedCode: null,
        pendingRoomCount: 1,
      });
      expect(await snapshot(app)).toEqual(before);
      worker.malformedAppend = false;
      await relay.tick("1", true);
      expect((await rooms.requireMemberState("1", room.id)).dirty).toBe(false);
      expect(worker.heads.get("1")).toBe(1);
    } finally {
      await app.close();
    }
  });
  test("explicit Worker integrity conflicts still block publication", async () => {
    const { app, worker } = await fixture();
    try {
      const rooms = app.get(RoomsService),
        relay = app.get(RoomProjectionDispatcher);
      await rooms.direct("1", "2");
      worker.publicationConflicts.add("1");
      await relay.tick("1", true);
      expect(await relay.diagnostics("1")).toMatchObject({
        blockedCode: "EVENT_CONFLICT",
        pendingRoomCount: 1,
      });
    } finally {
      await app.close();
    }
  });
  test("presence dependency errors remain unknown, not fabricated offline", async () => {
    const { app } = await fixture();
    try {
      const realtime = app.get(RealtimeClient);
      const transport = jest
        .spyOn(
          realtime as unknown as { request: () => Promise<unknown> },
          "request",
        )
        .mockRejectedValue(
          new ApiError(503, "DEPENDENCY_UNAVAILABLE", "Unavailable"),
        );
      expect(await realtime.presence(["2"])).toMatchObject([
        { userId: "2", state: "unknown", activeDeviceCount: null },
      ]);
      transport.mockRestore();
    } finally {
      await app.close();
    }
  });
});

describe("safe runtime HTTP and publication logging", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let app: INestApplication, worker: WorkerFixture;
  beforeAll(async () => {
    ({ app, worker } = await fixture(testConfig(), logger));
  });
  afterAll(async () => {
    await app.close();
  });
  const logs = () =>
    logger.log.mock.calls
      .filter((args) => args[1] === "HTTP")
      .map((args) => String(args[0]));
  test("logs status, duration, route template and correlated request ID without private input", async () => {
    const id = randomUUID();
    const marker = "private-test-marker";
    await request(app.getHttpServer())
      .get(`/api/v1/health?ticket=${marker}`)
      .set("Authorization", `Bearer ${marker}`)
      .set("X-Request-Id", id)
      .expect(200);
    expect(logs().at(-1)).toMatch(
      new RegExp(
        `GET /api/v1/health status=200 durationMs=[0-9.]+ requestId=${id}`,
      ),
    );
    const invalidId = await request(app.getHttpServer())
      .get("/api/v1/health")
      .set("X-Request-Id", marker)
      .expect(200);
    expect(logs().at(-1)).toContain(
      `requestId=${invalidId.headers["x-request-id"]}`,
    );
    const response = await request(app.getHttpServer())
      .post("/api/v1/realtime/ticket")
      .set("Authorization", `Bearer ${marker}`)
      .send({ private: marker })
      .expect(401);
    expect(logs().at(-1)).toContain(`requestId=${response.body.requestId}`);
    expect(logs().at(-1)).toContain("code=UNAUTHORIZED");
    await request(app.getHttpServer())
      .get(`/api/v1/${marker}?secret=${marker}`)
      .expect(404);
    expect(logs().at(-1)).toContain("GET unmatched status=404");
    expect(logs().join("\n")).not.toContain(marker);
  });
  test("logs parser failures and oversized bodies without changing their error responses", async () => {
    const marker = "unlogged-body-marker";
    const malformed = await request(app.getHttpServer())
      .post("/api/v1/dev/session")
      .set("Content-Type", "application/json")
      .send(`{"private":"${marker}",`)
      .expect(400);
    expect(logs().at(-1)).toContain(`POST unmatched status=400`);
    expect(logs().at(-1)).toContain(`requestId=${malformed.body.requestId}`);
    const oversized = await request(app.getHttpServer())
      .post("/api/v1/dev/session")
      .send({ private: marker.repeat(3000) })
      .expect(413);
    expect(logs().at(-1)).toContain(`status=413`);
    expect(logs().at(-1)).toContain(`requestId=${oversized.body.requestId}`);
    expect(logs().join("\n")).not.toContain(marker);
  });
  test("distinguishes full room snapshots from paging without logging query values", async () => {
    const access = await token(app);
    await app.get(RoomsService).direct("1", "2");
    await app
      .get(RoomsService)
      .group("1", "Snapshot monitoring", ["2"], randomUUID());
    const first = await request(app.getHttpServer())
      .get("/api/v1/rooms?limit=1")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(logs().at(-1)).toContain(
      "GET /api/v1/rooms operation=ROOMS_FULL_SNAPSHOT status=200",
    );
    expect(logs().at(-1)).toContain(
      `requestId=${first.headers["x-request-id"]}`,
    );
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const cursor = first.body.nextCursor as string;
    await request(app.getHttpServer())
      .get(`/api/v1/rooms?limit=1&cursor=${encodeURIComponent(cursor)}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(logs().at(-1)).toContain("operation=ROOMS_PAGE status=200");
    expect(logs().join("\n")).not.toContain(cursor);
    expect(logs().join("\n")).not.toContain(access);
    worker.failures.add("1");
    try {
      await request(app.getHttpServer())
        .get("/api/v1/rooms")
        .set("Authorization", `Bearer ${access}`)
        .expect(503);
      expect(logs().at(-1)).toContain(
        "operation=ROOMS_FULL_SNAPSHOT status=503",
      );
      expect(logs().at(-1)).toContain("code=DEPENDENCY_UNAVAILABLE");
    } finally {
      worker.failures.delete("1");
    }
  });
  test("relay reports failure once and recovery without flooding unchanged poll failures", async () => {
    const relay = app.get(RoomProjectionDispatcher);
    worker.failures.add("1");
    await relay.tick("1", true);
    await relay.tick("1", true);
    const failures = logger.warn.mock.calls.filter((args) =>
      String(args[0]).startsWith("Realtime unavailable user=1"),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toContain("code=DEPENDENCY_UNAVAILABLE");
    worker.failures.delete("1");
    await relay.tick("1", true);
    expect(
      logger.log.mock.calls.some((args) =>
        String(args[0]).startsWith("Realtime recovered user=1"),
      ),
    ).toBe(true);
    await app.get(RoomsService).direct("1", "2");
    await relay.tick("1", true);
    expect(
      logger.log.mock.calls.some((args) =>
        /^Published room states user=1 count=[1-9]/.test(String(args[0])),
      ),
    ).toBe(true);
  });
});
