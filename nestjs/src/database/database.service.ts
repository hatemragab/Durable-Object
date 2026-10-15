import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import type { Connection, Model } from "mongoose";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import {
  DATASET,
  USER,
  ROOM,
  ROOM_MEMBER,
  MESSAGE,
  type DatasetRecord,
  type UserRecord,
  type RoomRecord,
  type RoomMemberRecord,
  type MessageRecord,
} from "./schemas.js";

@Injectable()
export class DatabaseService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(DATASET) private readonly datasets: Model<DatasetRecord>,
    @InjectModel(USER) private readonly users: Model<UserRecord>,
    @InjectModel(ROOM) private readonly rooms: Model<RoomRecord>,
    @InjectModel(ROOM_MEMBER) private readonly members: Model<RoomMemberRecord>,
    @InjectModel(MESSAGE) private readonly messages: Model<MessageRecord>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async onModuleInit(): Promise<void> {
    const hello = await this.connection.db!.admin().command({ hello: 1 });
    if (hello.setName !== "rs0")
      throw new Error(
        "The dedicated local rs0 MongoDB replica set is required.",
      );
    const stored = await this.datasets.findById("dataset").lean();
    if (
      !stored &&
      (
        await this.connection
          .db!.listCollections({}, { nameOnly: true })
          .toArray()
      ).length > 0
    )
      throw new Error(
        "Refusing to initialize an unowned nonempty database without dataset metadata.",
      );
    if (
      stored &&
      (stored.datasetId !== this.config.datasetId || stored.schemaVersion !== 2)
    )
      throw new Error(
        "Stored dataset identity/schema does not match configuration. Run the explicit room-sync migration for a schema-1 dataset.",
      );
    await this.datasets.updateOne(
      { _id: "dataset" },
      { $setOnInsert: { datasetId: this.config.datasetId, schemaVersion: 2 } },
      { upsert: true },
    );
    const verified = await this.datasets.findById("dataset").lean();
    if (verified?.datasetId !== this.config.datasetId)
      throw new Error("Dataset changed during initialization.");
    for (const model of [this.users, this.rooms, this.members, this.messages])
      await model.createIndexes();
    for (const id of ["1", "2", "3"] as const) {
      await this.users.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            datasetId: this.config.datasetId,
            name: `User ${id}`,
            roomCount: 0,
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true },
      );
    }
    const users = await this.users.find().lean();
    if (
      users.length !== 3 ||
      users.some(
        (u) =>
          u.datasetId !== this.config.datasetId ||
          !["1", "2", "3"].includes(u._id),
      )
    )
      throw new Error(
        "The dedicated dataset must contain exactly the three demo users.",
      );
  }
}
