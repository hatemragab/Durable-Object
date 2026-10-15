import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { readEnvironment } from "./environment.mjs";

/** Explicit, owned-dataset migration; routine startup never drops a collection. */
export async function migrateRoomSync(client, datasetId, { dropLegacy = false } = {}) {
  const db = client.db();
  const metadata = await db.collection("dataset_metadata").findOne({ _id: "dataset" });
  if (!metadata || metadata.datasetId !== datasetId || ![1, 2].includes(metadata.schemaVersion)) throw new Error("Refusing migration: dataset identity/schema does not match.");
  const hello = await db.admin().command({ hello: 1 });
  if (hello.setName !== "rs0") throw new Error("The dedicated rs0 replica set is required.");
  // Existing schema-1 membership state cannot describe read history. Preserve old
  // messages while choosing a documented read-at-cutover baseline.
  const session = client.startSession();
  let inserted = 0;
  try {
    await session.withTransaction(async () => {
      inserted = 0;
      const current = await db.collection("dataset_metadata").findOne({ _id: "dataset" }, { session });
      if (current?.datasetId !== datasetId || ![1, 2].includes(current.schemaVersion)) throw new Error("Dataset changed during migration.");
      const users = await db.collection("users").find({}, { session }).toArray();
      if (users.length !== 3 || users.some(user => user.datasetId !== datasetId || !["1", "2", "3"].includes(user._id))) throw new Error("Migration requires exactly the three owned demo users.");
      const rooms = await db.collection("rooms").find({}, { session }).toArray();
      for (const room of rooms) {
        if (room.datasetId !== datasetId || !Array.isArray(room.memberIds) || room.memberIds.some(id => !["1", "2", "3"].includes(id))) throw new Error("A room has invalid dataset membership.");
        for (const userId of room.memberIds) {
          const result = await db.collection("room_members").updateOne({ datasetId, userId, roomId: room._id }, { $setOnInsert: { _id: `${datasetId}:${userId}:${room._id}`, datasetId, userId, roomId: room._id, revision: 1, unreadCount: 0, lastReadSeq: room.lastMessageSeq, updatedAt: room.updatedAt, publishedRevision: 0, publishedSeq: 0, publishedEpoch: null, dirty: true } }, { upsert: true, session });
          inserted += result.upsertedCount;
        }
      }
      await db.collection("users").updateMany({ datasetId }, { $unset: { lastEventSeq: "" } }, { session });
      await db.collection("dataset_metadata").updateOne({ _id: "dataset", datasetId }, { $set: { schemaVersion: 2 } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
  } finally { await session.endSession(); }
  let dropped = false;
  if (dropLegacy && (await db.listCollections({ name: "event_outbox" }, { nameOnly: true }).toArray()).length) {
    await db.collection("event_outbox").drop();
    dropped = true;
  }
  return { schemaVersion: 2, insertedMemberships: inserted, droppedLegacyOutbox: dropped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--drop-event-outbox")) throw new Error("Explicit --drop-event-outbox is required. Stop the old backend before migrating.");
  const env = await readEnvironment();
  const { readConfig } = await import("../dist/src/config/config.js");
  const config = readConfig(env);
  const client = new mongoose.mongo.MongoClient(config.mongoUri);
  try { await client.connect(); console.log(JSON.stringify(await migrateRoomSync(client, config.datasetId, { dropLegacy: true }))); }
  finally { await client.close(); }
}
