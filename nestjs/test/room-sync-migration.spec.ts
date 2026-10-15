import { describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config/config.js";

const migrationModule = await import(
  new URL("../../scripts/migrate-room-sync.mjs", import.meta.url).href
);
const migrateRoomSync = migrationModule.migrateRoomSync as (
  client: mongoose.mongo.MongoClient,
  datasetId: string,
  options?: { dropLegacy?: boolean },
) => Promise<{
  schemaVersion: number;
  insertedMemberships: number;
  droppedLegacyOutbox: boolean;
}>;
function settings() {
  const uri = new URL(
    process.env.TEST_MONGO_URI ??
      "mongodb://127.0.0.1:27028/chat_poc_tests?replicaSet=rs0&directConnection=true",
  );
  uri.pathname = `/chat_poc_test_migration_${randomUUID().replaceAll("-", "")}`;
  return readConfig({
    APP_ENV: "development",
    DATASET_ID: randomUUID(),
    MONGO_URI: uri.toString(),
    DEV_SESSION_SECRET: `session-${randomUUID()}`,
    WS_TICKET_SECRET: `ticket-${randomUUID()}`,
    REALTIME_INTERNAL_SECRET: `internal-${randomUUID()}`,
    REALTIME_BASE_URL: "http://127.0.0.1:8787",
  });
}
async function legacy() {
  const config = settings(),
    client = new mongoose.mongo.MongoClient(config.mongoUri);
  await client.connect();
  const db = client.db(),
    now = new Date().toISOString(),
    roomId = randomUUID();
  const records = (name: string) =>
    db.collection<mongoose.mongo.Document & { _id: string }>(name);
  await records("dataset_metadata").insertOne({
    _id: "dataset",
    datasetId: config.datasetId,
    schemaVersion: 1,
  });
  await records("users").insertMany(
    (["1", "2", "3"] as const).map((_id) => ({
      _id,
      datasetId: config.datasetId,
      name: `User ${_id}`,
      lastEventSeq: _id === "3" ? 0 : 2,
      roomCount: _id === "3" ? 0 : 1,
      createdAt: now,
    })),
  );
  await records("rooms").insertOne({
    _id: roomId,
    datasetId: config.datasetId,
    type: "direct",
    title: null,
    memberIds: ["1", "2"],
    createdBy: "1",
    createdAt: now,
    updatedAt: now,
    version: 2,
    lastMessageSeq: 1,
    lastMessage: null,
    directKey: "1:2",
  });
  await records("messages").insertOne({
    _id: randomUUID(),
    datasetId: config.datasetId,
    roomId,
    roomSeq: 1,
    senderId: "2",
    text: "Original immutable message",
    createdAt: now,
  });
  await records("event_outbox").insertOne({
    _id: randomUUID(),
    datasetId: config.datasetId,
    userId: "1",
    streamSeq: 1,
    envelopeJson: "immutable legacy fixture",
  });
  return { client, config, db, records, roomId };
}
async function snapshot(db: mongoose.mongo.Db) {
  return Promise.all(
    (await db.listCollections({}, { nameOnly: true }).toArray())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (c) => ({
        name: c.name,
        rows: await db.collection(c.name).find().sort({ _id: 1 }).toArray(),
      })),
  );
}
describe("explicit owned-dataset room sync migration", () => {
  test("keeps message and room bytes, backfills read-at-cutover state, and explicitly drops legacy events", async () => {
    const { client, config, db } = await legacy();
    try {
      const rooms = await db.collection("rooms").find().toArray(),
        messages = await db.collection("messages").find().toArray();
      expect(
        await migrateRoomSync(client, config.datasetId, { dropLegacy: true }),
      ).toEqual({
        schemaVersion: 2,
        insertedMemberships: 2,
        droppedLegacyOutbox: true,
      });
      expect(await db.collection("rooms").find().toArray()).toEqual(rooms);
      expect(await db.collection("messages").find().toArray()).toEqual(
        messages,
      );
      expect(await db.collection("room_members").find().toArray()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: "1",
            unreadCount: 0,
            lastReadSeq: 1,
            revision: 1,
            publishedRevision: 0,
            dirty: true,
          }),
        ]),
      );
      expect(
        await db.listCollections({ name: "event_outbox" }).toArray(),
      ).toEqual([]);
      expect(
        (await db.collection("users").findOne({ name: "User 1" }))
          ?.lastEventSeq,
      ).toBeUndefined();
    } finally {
      await client.close();
    }
  });
  test("rerun preserves existing new read state and publication markers", async () => {
    const { client, config, db } = await legacy();
    try {
      await migrateRoomSync(client, config.datasetId, { dropLegacy: true });
      await db.collection("room_members").updateOne(
        { userId: "1" },
        {
          $set: {
            unreadCount: 4,
            lastReadSeq: 3,
            revision: 5,
            publishedRevision: 5,
            publishedEpoch: randomUUID(),
            dirty: false,
          },
        },
      );
      const before = await snapshot(db);
      expect(
        await migrateRoomSync(client, config.datasetId, { dropLegacy: true }),
      ).toEqual({
        schemaVersion: 2,
        insertedMemberships: 0,
        droppedLegacyOutbox: false,
      });
      expect(await snapshot(db)).toEqual(before);
    } finally {
      await client.close();
    }
  });
  test("wrong dataset is refused without any mutation", async () => {
    const { client, db } = await legacy();
    try {
      const before = await snapshot(db);
      await expect(
        migrateRoomSync(client, randomUUID(), { dropLegacy: true }),
      ).rejects.toThrow("identity/schema");
      expect(await snapshot(db)).toEqual(before);
    } finally {
      await client.close();
    }
  });
  test("routine startup refuses schema1 before creating or deleting collections", async () => {
    const { client, config, db } = await legacy();
    try {
      const before = await snapshot(db);
      await expect(
        createApp(config, { logger: false, relay: false }),
      ).rejects.toThrow("explicit room-sync migration");
      expect(await snapshot(db)).toEqual(before);
    } finally {
      await client.close();
    }
  });
});
