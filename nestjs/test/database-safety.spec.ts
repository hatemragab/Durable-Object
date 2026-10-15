import "reflect-metadata";
import { describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import type { INestApplication } from "@nestjs/common";
import { createApp, AppModule } from "../src/app.js";
import { readConfig } from "../src/config/config.js";
import { RoomsService } from "../src/rooms/rooms.service.js";
import { MessagesService } from "../src/messages/messages.service.js";

function config() {
  const uri = new URL(
    process.env.TEST_MONGO_URI ??
      "mongodb://127.0.0.1:27028/chat_poc_tests?replicaSet=rs0&directConnection=true",
  );
  uri.pathname = `/chat_poc_test_ownership_${randomUUID().replaceAll("-", "")}`;
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

async function snapshot(database: mongoose.mongo.Db) {
  const collections = (
    await database.listCollections({}, { nameOnly: false }).toArray()
  ).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    collections.map(async (info) => ({
      info,
      indexes: (
        await database.collection(info.name).listIndexes().toArray()
      ).sort((a, b) => String(a.name).localeCompare(String(b.name))),
      documents: await database
        .collection(info.name)
        .find()
        .sort({ _id: 1 })
        .toArray(),
    })),
  );
}

describe("database ownership before initialization writes", () => {
  test("the app factory rejects a non-demo namespace before creating a connection", () => {
    const settings = config();
    const uri = new URL(settings.mongoUri);
    uri.pathname = "/unrelated_existing_database";
    expect(() =>
      AppModule.register(
        { ...settings, mongoUri: uri.toString() },
        { logger: false, relay: false },
      ),
    ).toThrow("chat_poc_");
  });

  test("foreign documents, collections, and indexes stay exactly unchanged when metadata is absent", async () => {
    const settings = config(),
      client = new mongoose.mongo.MongoClient(settings.mongoUri);
    try {
      await client.connect();
      const database = client.db();
      await database.createCollection("external_records", {
        validator: { externalKey: { $type: "string" } },
      });
      await database.collection("external_records").insertOne({
        externalKey: "synthetic-foreign-record",
        payload: "untouched fixture data",
      });
      await database
        .collection("external_records")
        .createIndex(
          { externalKey: 1 },
          { unique: true, name: "foreign_unique_key" },
        );
      await database
        .collection("users")
        .insertOne({ externalKey: "synthetic-foreign-user" });
      await database
        .collection("users")
        .createIndex({ externalKey: 1 }, { name: "foreign_user_index" });
      const before = await snapshot(database);
      await expect(
        createApp(settings, { logger: false, relay: false }),
      ).rejects.toThrow("unowned nonempty database");
      expect(await snapshot(database)).toEqual(before);
      expect(
        await database
          .collection<{
            _id: string;
            datasetId: string;
            schemaVersion: number;
          }>("dataset_metadata")
          .findOne({ _id: "dataset" }),
      ).toBeNull();
    } finally {
      await client.close();
    }
  });

  test("an empty foreign collection is refused without changing its schema or adding application collections", async () => {
    const settings = config(),
      client = new mongoose.mongo.MongoClient(settings.mongoUri);
    try {
      await client.connect();
      const database = client.db();
      await database.createCollection("external_empty_collection");
      await database
        .collection("external_empty_collection")
        .createIndex(
          { externalKey: 1 },
          { sparse: true, name: "foreign_empty_index" },
        );
      const before = await snapshot(database);
      await expect(
        createApp(settings, { logger: false, relay: false }),
      ).rejects.toThrow("unowned nonempty database");
      expect(await snapshot(database)).toEqual(before);
    } finally {
      await client.close();
    }
  });

  test("a genuinely empty dedicated database initializes and retains complete owned data on restart", async () => {
    const settings = config(),
      client = new mongoose.mongo.MongoClient(settings.mongoUri);
    let app: INestApplication | undefined;
    try {
      await client.connect();
      const database = client.db();
      expect(await database.listCollections().toArray()).toEqual([]);
      app = await createApp(settings, { logger: false, relay: false });
      const room = (await app.get(RoomsService).direct("1", "2")).room;
      await app.get(MessagesService).send(
        {
          userId: "1",
          deviceId: randomUUID(),
          sessionExp: Math.floor(Date.now() / 1000) + 3600,
        },
        room.id,
        randomUUID(),
        "Synthetic ownership persistence proof",
      );
      const before = await snapshot(database);
      expect(
        before.find((collection) => collection.info.name === "dataset_metadata")
          ?.documents[0]?.datasetId,
      ).toBe(settings.datasetId);
      await app.close();
      app = undefined;
      app = await createApp(settings, { logger: false, relay: false });
      expect(await snapshot(database)).toEqual(before);
    } finally {
      await app?.close();
      await client.close();
    }
  });
});
