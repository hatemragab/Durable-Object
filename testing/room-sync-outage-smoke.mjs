/** Owns its API on loopback3001 and stops it before replaying via real Cloudflare. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeFile, readFile } from "node:fs/promises";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
import { readConfig } from "../nestjs/dist/src/config/config.js";
import { createApp } from "../nestjs/dist/src/app.js";
import WebSocket from "../nestjs/node_modules/ws/wrapper.mjs";
import { parseBatch } from "../shared/dist/index.js";
import {
  validateCloudDeployment,
  validateTicketOrigin,
  closeOwnedSocket,
} from "./smoke-support.mjs";
const env = await readEnvironment();
const deployment = validateCloudDeployment(
  env,
  JSON.parse(await readFile(root + "/.local/deployment.json", "utf8")),
);
const base = "http://127.0.0.1:3001/api/v1";
const app = await createApp(
  readConfig({ ...env, PORT: "3001", HOST: "127.0.0.1" }),
);
const db = new DatabaseSync(":memory:");
db.exec(
  "CREATE TABLE meta(seq INTEGER);CREATE TABLE rooms(id TEXT PRIMARY KEY,revision INTEGER,json TEXT)",
);
let ws,
  stopped = false;
try {
  await app.listen(3001, "127.0.0.1");
  async function api(path, token, body) {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(r.ok, `API ${path} failed: ${r.status}`);
    return r.json();
  }
  const deviceId = randomUUID();
  const recipient = await api("/dev/session", null, { userId: "2", deviceId });
  const sender = await api("/dev/session", null, {
    userId: "1",
    deviceId: randomUUID(),
  });
  const token = recipient.sessionToken;
  const snapshot = await api("/rooms?limit=20", token);
  db.prepare("INSERT INTO meta VALUES(?)").run(snapshot.sync.throughSeq);
  for (const room of snapshot.rooms)
    db.prepare("INSERT INTO rooms VALUES(?,?,?)").run(
      room.id,
      room.revision,
      JSON.stringify(room),
    );
  const room = (
    await api("/rooms/group", sender.sessionToken, {
      title: "API outage v2 " + Date.now(),
      memberUserIds: ["2"],
      clientRequestId: randomUUID(),
    })
  ).room;
  await api(`/rooms/${room.id}/messages`, sender.sessionToken, {
    clientMessageId: randomUUID(),
    text: "Current room state remains replayable while API is stopped.",
  });
  const end = Date.now() + 30000;
  let ready = false;
  while (Date.now() < end) {
    const diagnostics = await api("/dev/diagnostics", token);
    if (
      diagnostics.pendingRoomCount === 0 &&
      diagnostics.dependencyStatus.realtime === "available"
    ) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Publication did not settle");
  const ticket = await api("/realtime/ticket", token, {});
  const url = validateTicketOrigin(ticket.url, deployment.origin);
  url.searchParams.set("ticket", ticket.ticket);
  await app.close();
  stopped = true;
  await assert.rejects(
    fetch(base + "/health", { signal: AbortSignal.timeout(1000) }),
  );
  let items = 0,
    batches = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Cloud replay after API stop timed out")),
      20000,
    );
    ws = new WebSocket(url);
    ws.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Cloud transport failed"));
    });
    ws.on("message", (raw) => {
      try {
        const f = JSON.parse(String(raw));
        if (f.type === "hello")
          ws.send(
            JSON.stringify({
              v: 2,
              type: "resume",
              epoch: snapshot.sync.epoch,
              afterSeq: snapshot.sync.throughSeq,
              syncedAt: snapshot.sync.syncedAt,
            }),
          );
        else if (f.type === "events.batch") {
          parseBatch(f);
          assert.equal(
            f.fromSeq,
            db.prepare("SELECT seq FROM meta").get().seq + 1,
          );
          db.exec("BEGIN");
          try {
            for (const e of f.events) {
              assert.equal(e.type, "room.upserted");
              assert.equal(e.data.message, undefined);
              db.prepare(
                "INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json WHERE excluded.revision>rooms.revision",
              ).run(
                e.data.room.id,
                e.data.room.revision,
                JSON.stringify(e.data.room),
              );
            }
            db.prepare("UPDATE meta SET seq=?").run(f.toSeq);
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          items += f.events.length;
          batches++;
          ws.send(
            JSON.stringify({
              v: 2,
              type: "ack",
              batchId: f.batchId,
              throughSeq: f.toSeq,
            }),
          );
        } else if (f.type === "sync.ready") {
          const actual = JSON.parse(
            db.prepare("SELECT json FROM rooms WHERE id=?").get(room.id).json,
          );
          assert.equal(actual.lastMessageSeq, 1);
          assert.equal(actual.unreadCount, 1);
          clearTimeout(timer);
          resolve();
        } else if (f.type === "error" || f.type === "sync.required")
          throw new Error("Cloud refused valid retained replay");
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  });
  const report = {
    status: "passed",
    protocolVersion: 2,
    verifiedAt: new Date().toISOString(),
    mode: "cloud",
    checks: [
      "owned test API stopped and its health unreachable",
      "previously committed current state replayed from real Cloudflare",
      "SQLite room/cursor committed before ACK",
      "no message history event in replay",
    ],
    roomId: room.id,
    batches,
    items,
    phoneTest: false,
    scope:
      "Only this probe-owned API on port3001 is stopped; other user-run APIs are untouched. Client replay uses only Cloudflare.",
  };
  await writeFile(
    root + "/.local/room-sync-cloud-outage.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await closeOwnedSocket(ws);
  if (!stopped) await app.close();
  db.close();
}
