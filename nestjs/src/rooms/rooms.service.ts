import { Inject, Injectable } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import type { Connection, Model, ClientSession } from "mongoose";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULTS,
  isUuid,
  normalizeTitle,
  type UserId,
  type RoomDto,
} from "@chat-poc/contracts";
import {
  ROOM,
  ROOM_MEMBER,
  USER,
  type RoomRecord,
  type RoomMemberRecord,
  type UserRecord,
  roomDto,
} from "../database/schemas.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ApiError, invalid } from "../common/errors.js";
import { RealtimeClient } from "../realtime/realtime.client.js";

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isDuplicateKey = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === 11000;
export const transactionOptions = {
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
  readPreference: "primary" as const,
};
interface RoomCursor {
  updatedAt: string;
  roomId: string;
}
@Injectable()
export class RoomsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ROOM) readonly rooms: Model<RoomRecord>,
    @InjectModel(ROOM_MEMBER) readonly members: Model<RoomMemberRecord>,
    @InjectModel(USER) readonly users: Model<UserRecord>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RealtimeClient) private readonly realtime: RealtimeClient,
  ) {}
  async requireMemberState(
    userId: UserId,
    roomId: string,
    session?: ClientSession,
  ): Promise<RoomMemberRecord> {
    const query = this.members.findOne({
      datasetId: this.config.datasetId,
      userId,
      roomId,
    });
    if (session) query.session(session);
    const member = await query.lean();
    if (member) return member;
    const roomQuery = this.rooms.exists({
      _id: roomId,
      datasetId: this.config.datasetId,
    });
    if (session) roomQuery.session(session);
    if (!(await roomQuery))
      throw new ApiError(
        404,
        "ROOM_NOT_FOUND",
        "No such room in this dataset.",
      );
    throw new ApiError(
      403,
      "ROOM_FORBIDDEN",
      "The selected account is not a member of this room.",
    );
  }
  async requireMember(
    userId: UserId,
    roomId: string,
    session?: ClientSession,
  ): Promise<RoomRecord> {
    await this.requireMemberState(userId, roomId, session);
    const query = this.rooms.findOne({
      _id: roomId,
      datasetId: this.config.datasetId,
    });
    if (session) query.session(session);
    const room = await query.lean();
    if (!room || !room.memberIds.includes(userId))
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        "Room membership is inconsistent.",
      );
    return room;
  }
  private cursor(value?: string): RoomCursor | undefined {
    if (value === undefined) return undefined;
    try {
      if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
        throw new Error();
      const parsed: unknown = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      const item = parsed as Record<string, unknown>;
      if (
        Object.keys(item).sort().join(",") !== "roomId,updatedAt" ||
        !isUuid(item.roomId) ||
        typeof item.updatedAt !== "string" ||
        new Date(item.updatedAt).toISOString() !== item.updatedAt
      )
        throw new Error();
      return { roomId: item.roomId, updatedAt: item.updatedAt };
    } catch {
      throw invalid("cursor must be a valid room-list cursor.");
    }
  }
  async list(
    userId: UserId,
    limit = 20,
    cursor?: string,
  ): Promise<{
    rooms: RoomDto[];
    nextCursor: string | null;
    sync: { epoch: string; throughSeq: number; syncedAt: string };
  }> {
    const before = this.cursor(cursor);
    // Capture BEFORE Mongo's snapshot. A later cursor could skip a concurrent commit.
    const barrier = await this.realtime.head(userId);
    return this.connection.transaction(async (session) => {
      const records = await this.members
        .find({
          datasetId: this.config.datasetId,
          userId,
          ...(before
            ? {
                $or: [
                  { updatedAt: { $lt: before.updatedAt } },
                  {
                    updatedAt: before.updatedAt,
                    roomId: { $gt: before.roomId },
                  },
                ],
              }
            : {}),
        })
        .session(session)
        .sort({ updatedAt: -1, roomId: 1 })
        .limit(limit + 1)
        .lean();
      const page = records.slice(0, limit);
      const roomRecords = await this.rooms
        .find({
          datasetId: this.config.datasetId,
          _id: { $in: page.map((member) => member.roomId) },
        })
        .session(session)
        .lean();
      const byId = new Map(roomRecords.map((room) => [room._id, room]));
      const rooms = page.map((member) => {
        const room = byId.get(member.roomId);
        if (!room || !room.memberIds.includes(userId))
          throw new ApiError(
            409,
            "STATE_CONFLICT",
            "Room membership is inconsistent.",
          );
        return roomDto(room, member);
      });
      const last = page.at(-1);
      return {
        rooms,
        nextCursor:
          records.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  updatedAt: last.updatedAt,
                  roomId: last.roomId,
                }),
              ).toString("base64url")
            : null,
        sync: {
          epoch: barrier.epoch,
          throughSeq: barrier.headSeq,
          syncedAt: new Date().toISOString(),
        },
      };
    }, transactionOptions);
  }
  async get(userId: UserId, roomId: string): Promise<RoomDto> {
    return this.connection.transaction(
      async (session) =>
        roomDto(
          await this.requireMember(userId, roomId, session),
          await this.requireMemberState(userId, roomId, session),
        ),
      transactionOptions,
    );
  }
  async direct(
    userId: UserId,
    peer: UserId,
  ): Promise<{ room: RoomDto; created: boolean }> {
    if (peer === userId) throw invalid("Self direct rooms are forbidden.");
    const members = [userId, peer].sort() as UserId[];
    return this.create(userId, members, "direct", null, {
      directKey: members.join(":"),
    });
  }
  async group(
    userId: UserId,
    titleInput: unknown,
    peers: UserId[],
    clientRequestId: string,
  ): Promise<{ room: RoomDto; created: boolean }> {
    if (
      peers.includes(userId) ||
      peers.length > 2 ||
      new Set(peers).size !== peers.length
    )
      throw invalid("Submit one or two distinct other members.");
    const title = normalizeTitle(titleInput),
      members = [userId, ...peers].sort() as UserId[];
    return this.create(userId, members, "group", title, {
      clientRequestId,
      creationFingerprint: fingerprint([title, members]),
    });
  }
  private async create(
    userId: UserId,
    members: UserId[],
    type: "direct" | "group",
    title: string | null,
    identity: {
      directKey?: string;
      clientRequestId?: string;
      creationFingerprint?: string;
    },
  ): Promise<{ room: RoomDto; created: boolean }> {
    const filter = {
      datasetId: this.config.datasetId,
      type,
      ...(type === "direct"
        ? { directKey: identity.directKey! }
        : { createdBy: userId, clientRequestId: identity.clientRequestId! }),
    };
    const resolve = async (existing: RoomRecord, session?: ClientSession) => {
      if (
        type === "group" &&
        existing.creationFingerprint !== identity.creationFingerprint
      )
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This group request ID has different content.",
        );
      return {
        room: roomDto(
          existing,
          await this.requireMemberState(userId, existing._id, session),
        ),
        created: false,
      };
    };
    const roomId = randomUUID(),
      now = new Date().toISOString();
    try {
      return await this.connection.transaction(async (session) => {
        const existing = await this.rooms
          .findOne(filter)
          .session(session)
          .lean();
        if (existing) return resolve(existing, session);
        const room: RoomRecord = {
          _id: roomId,
          datasetId: this.config.datasetId,
          type,
          title,
          memberIds: members,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
          version: 1,
          lastMessageSeq: 0,
          lastMessage: null,
          ...identity,
        };
        await this.rooms.create([room], { session });
        for (const memberId of members) {
          const updated = await this.users.updateOne(
            {
              _id: memberId,
              datasetId: this.config.datasetId,
              roomCount: { $lt: DEFAULTS.maxRoomsPerUser },
            },
            { $inc: { roomCount: 1 } },
            { session },
          );
          if (updated.modifiedCount !== 1)
            throw new ApiError(
              429,
              "DEMO_LIMIT_REACHED",
              "A demo account has reached its room cap.",
            );
          await this.members.create(
            [
              {
                _id: randomUUID(),
                datasetId: this.config.datasetId,
                userId: memberId,
                roomId,
                revision: 1,
                unreadCount: 0,
                lastReadSeq: 0,
                updatedAt: now,
                publishedRevision: 0,
                publishedSeq: 0,
                publishedEpoch: null,
                dirty: true,
              },
            ],
            { session },
          );
        }
        return {
          room: roomDto(room, { revision: 1, unreadCount: 0, lastReadSeq: 0 }),
          created: true,
        };
      }, transactionOptions);
    } catch (error) {
      if (isDuplicateKey(error)) {
        const existing = await this.rooms.findOne(filter).lean();
        if (existing) return resolve(existing);
      }
      throw error;
    }
  }
}
