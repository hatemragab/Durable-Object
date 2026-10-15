import { Inject, Injectable } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import type { Connection, Model } from "mongoose";
import { randomUUID } from "node:crypto";
import {
  validateText,
  type UserId,
  type MessageDto,
  type RoomDto,
} from "@chat-poc/contracts";
import {
  MESSAGE,
  ROOM,
  ROOM_MEMBER,
  messageDto,
  roomDto,
  type MessageRecord,
  type RoomRecord,
  type RoomMemberRecord,
} from "../database/schemas.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ApiError, invalid } from "../common/errors.js";
import {
  RoomsService,
  fingerprint,
  isDuplicateKey,
  transactionOptions,
} from "../rooms/rooms.service.js";
export interface Identity {
  userId: UserId;
  deviceId: string;
  sessionExp: number;
}
export interface SendResult {
  message: MessageDto;
  room: RoomDto;
  duplicate: boolean;
}
@Injectable()
export class MutationProbe {
  check(_stage: string): void {}
}
@Injectable()
export class MessagesService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MESSAGE) readonly messages: Model<MessageRecord>,
    @InjectModel(ROOM) private readonly rooms: Model<RoomRecord>,
    @InjectModel(ROOM_MEMBER) private readonly members: Model<RoomMemberRecord>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RoomsService) private readonly roomService: RoomsService,
    @Inject(MutationProbe) private readonly probe: MutationProbe,
  ) {}
  async send(
    identity: Identity,
    roomId: string,
    clientMessageId: string,
    textInput: unknown,
  ): Promise<SendResult> {
    const text = validateText(textInput),
      requestFingerprint = fingerprint([roomId, text]);
    const filter = {
      datasetId: this.config.datasetId,
      senderId: identity.userId,
      clientMessageId,
    };
    const messageId = randomUUID();
    const duplicate = (
      record: MessageRecord,
      room: RoomRecord,
      member: RoomMemberRecord,
    ): SendResult => {
      if (record.requestFingerprint !== requestFingerprint)
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This client message ID has different content.",
        );
      return {
        message: messageDto(record),
        room: roomDto(room, member),
        duplicate: true,
      };
    };
    try {
      return await this.connection.transaction(async (session) => {
        const authorized = await this.roomService.requireMember(
          identity.userId,
          roomId,
          session,
        );
        const existing = await this.messages
          .findOne(filter)
          .session(session)
          .lean();
        if (existing)
          return duplicate(
            existing,
            authorized,
            await this.roomService.requireMemberState(
              identity.userId,
              roomId,
              session,
            ),
          );
        const now = new Date(
          Math.max(Date.now(), Date.parse(authorized.updatedAt)),
        ).toISOString();
        const updated = await this.rooms
          .findOneAndUpdate(
            { _id: roomId, datasetId: this.config.datasetId },
            {
              $inc: { lastMessageSeq: 1, version: 1 },
              $set: { updatedAt: now },
            },
            { session, returnDocument: "after" },
          )
          .lean();
        if (!updated)
          throw new ApiError(
            404,
            "ROOM_NOT_FOUND",
            "No such room in this dataset.",
          );
        this.probe.check("room");
        const record: MessageRecord = {
          _id: messageId,
          datasetId: this.config.datasetId,
          roomId,
          senderId: identity.userId,
          originDeviceId: identity.deviceId,
          clientMessageId,
          roomSeq: updated.lastMessageSeq,
          type: "text",
          text,
          createdAt: now,
          requestFingerprint,
        };
        await this.messages.create([record], { session });
        this.probe.check("message");
        updated.lastMessage = {
          messageId,
          senderId: identity.userId,
          text,
          roomSeq: record.roomSeq,
          createdAt: now,
        };
        await this.rooms.updateOne(
          { _id: roomId, datasetId: this.config.datasetId },
          { $set: { lastMessage: updated.lastMessage } },
          { session },
        );
        this.probe.check("summary");
        for (const userId of [...updated.memberIds].sort()) {
          const result = await this.members.updateOne(
            { datasetId: this.config.datasetId, userId, roomId },
            {
              $inc: {
                revision: 1,
                unreadCount: userId === identity.userId ? 0 : 1,
              },
              $set: { updatedAt: now, dirty: true },
            },
            { session },
          );
          if (result.modifiedCount !== 1)
            throw new ApiError(
              409,
              "STATE_CONFLICT",
              "A room membership is missing.",
            );
        }
        this.probe.check("members");
        return {
          message: messageDto(record),
          room: roomDto(
            updated,
            await this.roomService.requireMemberState(
              identity.userId,
              roomId,
              session,
            ),
          ),
          duplicate: false,
        };
      }, transactionOptions);
    } catch (error) {
      if (isDuplicateKey(error)) {
        return this.connection.transaction(async (session) => {
          const room = await this.roomService.requireMember(
              identity.userId,
              roomId,
              session,
            ),
            existing = await this.messages
              .findOne(filter)
              .session(session)
              .lean();
          if (!existing) throw error;
          return duplicate(
            existing,
            room,
            await this.roomService.requireMemberState(
              identity.userId,
              roomId,
              session,
            ),
          );
        }, transactionOptions);
      }
      throw error;
    }
  }
  async read(
    userId: UserId,
    roomId: string,
    throughRoomSeq: number,
  ): Promise<RoomDto> {
    if (!Number.isSafeInteger(throughRoomSeq) || throughRoomSeq < 0)
      throw invalid("throughRoomSeq must be a nonnegative safe integer.");
    return this.connection.transaction(async (session) => {
      const room = await this.roomService.requireMember(
          userId,
          roomId,
          session,
        ),
        member = await this.roomService.requireMemberState(
          userId,
          roomId,
          session,
        );
      if (throughRoomSeq > room.lastMessageSeq)
        throw invalid("throughRoomSeq exceeds the room message head.");
      if (throughRoomSeq <= member.lastReadSeq) return roomDto(room, member);
      const unreadCount = await this.messages
        .countDocuments({
          datasetId: this.config.datasetId,
          roomId,
          roomSeq: { $gt: throughRoomSeq },
          senderId: { $ne: userId },
        })
        .session(session);
      const updated = await this.members
        .findOneAndUpdate(
          { _id: member._id },
          {
            $set: { lastReadSeq: throughRoomSeq, unreadCount, dirty: true },
            $inc: { revision: 1 },
          },
          { session, returnDocument: "after" },
        )
        .lean();
      if (!updated)
        throw new ApiError(
          409,
          "STATE_CONFLICT",
          "The room membership disappeared.",
        );
      this.probe.check("read");
      return roomDto(room, updated);
    }, transactionOptions);
  }
  async history(
    userId: UserId,
    roomId: string,
    limit: number,
    before?: number,
  ): Promise<{
    messages: MessageDto[];
    hasMore: boolean;
    nextBeforeRoomSeq: number | null;
    window: { fromRoomSeq: number; throughRoomSeq: number };
  }> {
    return this.connection.transaction(async (session) => {
      const room = await this.roomService.requireMember(
        userId,
        roomId,
        session,
      );
      const throughRoomSeq =
        before === undefined
          ? room.lastMessageSeq
          : Math.min(room.lastMessageSeq, before - 1);
      const records = await this.messages
        .find({
          datasetId: this.config.datasetId,
          roomId,
          roomSeq: { $lte: throughRoomSeq },
        })
        .session(session)
        .sort({ roomSeq: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = records.length > limit,
        messages = records.slice(0, limit).reverse().map(messageDto);
      return {
        messages,
        hasMore,
        nextBeforeRoomSeq: hasMore ? messages[0]!.roomSeq : null,
        window: {
          fromRoomSeq: hasMore ? messages[0]!.roomSeq : 1,
          throughRoomSeq,
        },
      };
    }, transactionOptions);
  }
}
