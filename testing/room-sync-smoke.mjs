/** Protocol-v2 HTTP + WebSocket proof. Additive fixtures only; no database reset. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "../nestjs/node_modules/ws/wrapper.mjs";
import mongoose from "../nestjs/node_modules/mongoose/index.js";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
import { DEFAULTS, parseBatch } from "../shared/dist/index.js";
import {
  validateCloudDeployment,
  validateTicketOrigin,
  startHeartbeat,
  closeOwnedSocket,
} from "./smoke-support.mjs";

export async function runRoomSyncSmoke(cloud = false) {
  const env = await readEnvironment();
  const base =
    process.env.CHAT_POC_SMOKE_API_BASE || "http://127.0.0.1:3000/api/v1";
  const deployment = cloud
    ? validateCloudDeployment(
        env,
        JSON.parse(
          await readFile(resolve(root, ".local/deployment.json"), "utf8"),
        ),
      )
    : null;
  const streamOrigin = cloud ? env.REALTIME_BASE_URL : "http://127.0.0.1:8787";
  const directory = resolve(
    root,
    `.local/room-sync-${cloud ? "cloud" : "local"}/${Date.now()}`,
  );
  await mkdir(directory, { recursive: true });
  const checks = [],
    skipped = [],
    devices = [];
  const check = (name) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  async function api(path, { token, body, status } = {}) {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    assert.equal(
      r.status,
      status ?? 200,
      `${path}: ${data.error?.code ?? r.status}`,
    );
    assert.ok(!data.datasetId || data.datasetId === env.DATASET_ID);
    return data;
  }
  async function until(test, label, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const d of devices) if (d.error) throw d.error;
      if (await test()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("Timed out: " + label);
  }
  class Device {
    constructor(user, name) {
      this.user = user;
      this.name = name;
      this.id = randomUUID();
      this.ready = false;
      this.rows = 0;
      this.frames = 0;
      this.error = null;
      this.db = new DatabaseSync(resolve(directory, name + ".sqlite"));
      this.db.exec(
        "CREATE TABLE meta(epoch TEXT,seq INTEGER,synced_at TEXT); CREATE TABLE rooms(id TEXT PRIMARY KEY,revision INTEGER,json TEXT);",
      );
      devices.push(this);
    }
    get meta() {
      return this.db.prepare("SELECT * FROM meta").get();
    }
    room(id) {
      const row = this.db.prepare("SELECT json FROM rooms WHERE id=?").get(id);
      return row ? JSON.parse(row.json) : null;
    }
    upsert(room) {
      this.db
        .prepare(
          "INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json WHERE excluded.revision>rooms.revision",
        )
        .run(room.id, room.revision, JSON.stringify(room));
    }
    async session() {
      this.token = (
        await api("/dev/session", {
          body: { userId: this.user, deviceId: this.id },
        })
      ).sessionToken;
    }
    async snapshot() {
      const p = await api("/rooms?limit=20", { token: this.token });
      assert.ok(p.rooms.length <= 20);
      assert.ok(p.sync.epoch);
      this.db.exec("BEGIN");
      try {
        this.db.exec("DELETE FROM rooms;DELETE FROM meta");
        for (const r of p.rooms) this.upsert(r);
        this.db
          .prepare("INSERT INTO meta VALUES(?,?,?)")
          .run(p.sync.epoch, p.sync.throughSeq, p.sync.syncedAt);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return p;
    }
    async connect({ syncedAt } = {}) {
      this.ready = false;
      const t = await api("/realtime/ticket", { token: this.token, body: {} });
      const u = validateTicketOrigin(t.url, deployment?.origin);
      u.searchParams.set("ticket", t.ticket);
      this.ws = new WebSocket(u);
      this.heartbeat = startHeartbeat(this.ws, () => {
        this.error = new Error("Owned client heartbeat failed");
      });
      this.ws.on("message", (raw) => {
        if (String(raw) === "pong") {
          this.heartbeat.pong();
          return;
        }
        try {
          const f = JSON.parse(String(raw));
          assert.equal(f.v, 2);
          if (f.type === "hello") {
            assert.equal(f.epoch, this.meta.epoch);
            this.ws.send(
              JSON.stringify({
                v: 2,
                type: "resume",
                epoch: this.meta.epoch,
                afterSeq: this.meta.seq,
                syncedAt: syncedAt ?? this.meta.synced_at,
              }),
            );
          } else if (f.type === "events.batch") {
            parseBatch(f);
            const m = this.meta;
            assert.equal(f.epoch, m.epoch);
            this.db.exec("BEGIN");
            try {
              if (f.toSeq > m.seq) {
                assert.equal(f.fromSeq, m.seq + 1);
                for (const e of f.events) {
                  assert.equal(e.userId, this.user);
                  assert.equal(e.datasetId, env.DATASET_ID);
                  assert.equal(e.type, "room.upserted");
                  assert.equal(e.data.message, undefined);
                  this.upsert(e.data.room);
                }
                this.db.prepare("UPDATE meta SET seq=?").run(f.toSeq);
              }
              this.db.exec("COMMIT");
            } catch (e) {
              this.db.exec("ROLLBACK");
              throw e;
            }
            this.frames++;
            this.rows += f.events.length;
            this.ws.send(
              JSON.stringify({
                v: 2,
                type: "ack",
                batchId: f.batchId,
                throughSeq: f.toSeq,
              }),
            );
          } else if (f.type === "sync.ready") {
            assert.equal(this.meta.seq, f.throughSeq);
            this.ready = true;
          } else if (f.type === "sync.required") {
            this.required = f.reason ?? true;
          } else if (f.type === "error") throw new Error("Worker " + f.code);
        } catch (e) {
          this.error = e;
        }
      });
      this.ws.on("error", () => {
        this.error = new Error("Owned socket transport failed");
      });
      this.ws.on("close", (code) => {
        this.closeCode = code;
        this.heartbeat.stop();
      });
    }
    async disconnect() {
      this.heartbeat?.stop();
      await closeOwnedSocket(this.ws);
      this.ws = null;
    }
    close() {
      this.db.close();
    }
  }
  const mongo = new mongoose.mongo.MongoClient(env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  let report;
  try {
    await mongo.connect();
    // Existing retained projections may outlive an operator's Mongo-only cleanup.
    // Bound growth caused by THIS run instead of assuming an empty/matching history.
    const initial = new Map();
    for (const user of ["1", "2", "3"]) {
      const r = await fetch(
        `${streamOrigin}/internal/v1/users/${user}/stream`,
        {
          headers: {
            Authorization: `Bearer ${env.REALTIME_INTERNAL_SECRET}`,
            "X-Dataset-Id": env.DATASET_ID,
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      assert.equal(r.status, 200);
      const stream = await r.json();
      assert.equal(stream.datasetId, env.DATASET_ID);
      const memberships = await mongo
        .db()
        .collection("room_members")
        .countDocuments({ datasetId: env.DATASET_ID, userId: user });
      initial.set(user, { retained: stream.eventCount, memberships });
    }
    assert.equal((await api("/health")).protocolVersion, 2);
    check("API protocol v2");
    const sender = new Device("1", "sender"),
      a = new Device("2", "recipient-a"),
      b = new Device("2", "recipient-b"),
      third = new Device("3", "third");
    for (const d of devices) {
      await d.session();
      await d.snapshot();
      await d.connect();
    }
    await until(
      () => devices.every((d) => d.ready),
      "initial snapshots and replay",
    );
    check("four independent SQLite clients snapshot and connect");
    const created = await api("/rooms/group", {
      token: sender.token,
      body: {
        title: "Room sync v2 " + Date.now(),
        memberUserIds: ["2", "3"],
        clientRequestId: randomUUID(),
      },
      status: 201,
    });
    const roomId = created.room.id;
    await until(() => devices.every((d) => d.room(roomId)), "room fanout");
    check("room projection reaches sender and all recipient devices");
    await b.disconnect();
    const previousRows = b.rows;
    const keys = [];
    for (let i = 1; i <= 35; i++) {
      const clientMessageId = randomUUID();
      keys.push(clientMessageId);
      await api(`/rooms/${roomId}/messages`, {
        token: sender.token,
        body: { clientMessageId, text: `room-state smoke ${i}` },
        status: 201,
      });
    }
    await until(
      () =>
        a.room(roomId)?.unreadCount === 35 &&
        third.room(roomId)?.unreadCount === 35,
      "unread fanout",
    );
    assert.equal(sender.room(roomId).unreadCount, 0);
    check("35 messages produce personalized unread counts");
    await b.connect();
    await until(
      () => b.ready && b.room(roomId)?.lastMessageSeq === 35,
      "compacted replay",
    );
    assert.equal(b.room(roomId).unreadCount, 35);
    assert.equal(b.rows - previousRows, 1);
    check("offline device receives one latest room snapshot for 35 messages");
    const history = await api(`/rooms/${roomId}/messages`, { token: a.token });
    assert.equal(history.messages.length, 30);
    assert.equal(history.messages[0].roomSeq, 6);
    assert.equal(history.messages.at(-1).roomSeq, 35);
    assert.deepEqual(history.window, { fromRoomSeq: 6, throughRoomSeq: 35 });
    const older = await api(
      `/rooms/${roomId}/messages?beforeRoomSeq=${history.nextBeforeRoomSeq}`,
      { token: a.token },
    );
    assert.equal(older.messages.length, 5);
    check("HTTP latest30 and older history have authoritative windows");
    const read = await api(`/rooms/${roomId}/read`, {
      token: a.token,
      body: { throughRoomSeq: 34 },
    });
    assert.equal(read.room.unreadCount, 1);
    assert.equal(read.room.lastReadSeq, 34);
    await until(
      () => b.room(roomId)?.unreadCount === 1,
      "cross device read cursor",
    );
    assert.equal(third.room(roomId).unreadCount, 35);
    assert.equal(sender.room(roomId).unreadCount, 0);
    check("read cursor synchronizes only this account");
    await api(`/rooms/${roomId}/messages`, {
      token: sender.token,
      body: { clientMessageId: randomUUID(), text: "newer than delayed read" },
      status: 201,
    });
    const delayed = await api(`/rooms/${roomId}/read`, {
      token: a.token,
      body: { throughRoomSeq: 33 },
    });
    assert.equal(delayed.room.lastReadSeq, 34);
    assert.equal(delayed.room.unreadCount, 2);
    check("delayed read preserves newer unread messages");
    const duplicate = await api(`/rooms/${roomId}/messages`, {
      token: sender.token,
      body: { clientMessageId: keys[0], text: "room-state smoke 1" },
      status: 200,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.message.roomSeq, 1);
    assert.equal(
      (
        await api(`/rooms/${roomId}/messages`, { token: sender.token })
      ).messages.at(-1).roomSeq,
      36,
    );
    check("idempotent retry preserves the message head");
    const first = await api("/rooms?limit=20", { token: a.token });
    assert.ok(first.rooms.length > 0 && first.rooms.length <= 20);
    if (first.nextCursor) {
      assert.equal(first.rooms.length, 20);
      const next = await api(
        "/rooms?limit=20&cursor=" + encodeURIComponent(first.nextCursor),
        { token: a.token },
      );
      const ids = [...first.rooms, ...next.rooms].map((r) => r.id);
      assert.equal(new Set(ids).size, ids.length);
      check("top20 room snapshot and cursor pagination");
    } else {
      assert.equal(first.nextCursor, null);
      skipped.push(
        "Older-room pagination: account has no continuation; covered by isolated integration tests.",
      );
      check("room snapshot boundary with no older-room continuation");
    }
    await until(async () => {
      const s = await Promise.all(
        [sender, a, third].map((d) =>
          api("/dev/diagnostics", { token: d.token }),
        ),
      );
      return s.every(
        (u) =>
          u.pendingRoomCount === 0 &&
          u.blockedCode === null &&
          u.dependencyStatus.realtime === "available",
      );
    }, "current projection relay drained");
    await mongo.connect();
    const db = mongo.db();
    assert.equal(
      await db
        .collection("messages")
        .countDocuments({ datasetId: env.DATASET_ID, roomId }),
      36,
    );
    assert.equal(
      (await db.listCollections({ name: "event_outbox" }).toArray()).length,
      0,
    );
    const retained = await Promise.all(
      ["1", "2", "3"].map(async (user) => {
        const r = await fetch(
          streamOrigin + `/internal/v1/users/${user}/stream`,
          {
            headers: {
              Authorization: `Bearer ${env.REALTIME_INTERNAL_SECRET}`,
              "X-Dataset-Id": env.DATASET_ID,
            },
          },
        );
        assert.equal(r.status, 200);
        const s = await r.json();
        const memberships = await db
          .collection("room_members")
          .countDocuments({ datasetId: env.DATASET_ID, userId: user });
        const baseline = initial.get(user);
        assert.ok(
          s.eventCount <=
            baseline.retained + Math.max(0, memberships - baseline.memberships),
        );
        assert.ok(s.eventCount <= DEFAULTS.maxRoomsPerUser);
        assert.equal(s.retentionMs, 172800000);
        return {
          userId: user,
          retainedRoomCount: s.eventCount,
          membershipCount: memberships,
          initialRetainedRoomCount: baseline.retained,
          initialMembershipCount: baseline.memberships,
        };
      }),
    );
    check("no Mongo outbox; retained payload growth bounded by new rooms");
    await b.disconnect();
    b.required = null;
    await b.connect({
      syncedAt: new Date(Date.now() - 172800001).toISOString(),
    });
    await until(() => !!b.required, "48h fullsync signal");
    await until(() => b.closeCode === 4010, "fullsync close");
    check("48-hour stale baseline requires fresh snapshot");
    await b.snapshot();
    b.required = null;
    await b.connect();
    await until(() => b.ready, "fullsync recovery");
    check("snapshot fallback reconnects successfully");
    report = {
      status: "passed",
      protocolVersion: 2,
      mode: cloud ? "cloud" : "local",
      verifiedAt: new Date().toISOString(),
      checks,
      skipped,
      roomId,
      retained,
      nativeDeviceTest: false,
    };
  } finally {
    await Promise.allSettled(devices.map((d) => d.disconnect()));
    for (const d of devices) d.close();
    await mongo.close();
  }
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    resolve(root, `.local/room-sync-${cloud ? "cloud" : "local"}-latest.json`),
    JSON.stringify({ ...report, directory }, null, 2) + "\n",
  );
  console.log(`Room sync v2: ${checks.length} checks passed.`);
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
)
  await runRoomSyncSmoke(process.argv.includes("--cloud"));
