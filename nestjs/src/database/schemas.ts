import { Schema } from "mongoose";
import type { RoomDto, MessageDto, UserId } from "@chat-poc/contracts";

export const USER = "User";
export const ROOM = "Room";
export const ROOM_MEMBER = "RoomMember";
export const MESSAGE = "Message";
export const DATASET = "Dataset";
export interface UserRecord {
  _id: UserId;
  datasetId: string;
  name: string;
  roomCount: number;
  createdAt: string;
}
export type RoomRecord = Omit<
  RoomDto,
  "id" | "revision" | "unreadCount" | "lastReadSeq"
> & {
  _id: string;
  datasetId: string;
  directKey?: string;
  clientRequestId?: string;
  creationFingerprint?: string;
};
/** Current authoritative per-user state, never an event or historical payload. */
export interface RoomMemberRecord {
  _id: string;
  datasetId: string;
  userId: UserId;
  roomId: string;
  revision: number;
  unreadCount: number;
  lastReadSeq: number;
  updatedAt: string;
  publishedRevision: number;
  publishedSeq: number;
  publishedEpoch: string | null;
  dirty: boolean;
}
export type MessageRecord = Omit<MessageDto, "id"> & {
  _id: string;
  datasetId: string;
  requestFingerprint: string;
};
export interface DatasetRecord {
  _id: string;
  datasetId: string;
  schemaVersion: number;
}
const options = (collection: string) => ({
  collection,
  versionKey: false as const,
  strict: "throw" as const,
});
export const UserSchema = new Schema<UserRecord>(
  {
    _id: String,
    datasetId: { type: String, required: true },
    name: String,
    roomCount: Number,
    createdAt: String,
  },
  options("users"),
);
export const RoomSchema = new Schema<RoomRecord>(
  {
    _id: String,
    datasetId: String,
    type: String,
    title: { type: String, default: null },
    memberIds: [String],
    createdBy: String,
    createdAt: String,
    updatedAt: String,
    version: Number,
    lastMessageSeq: Number,
    lastMessage: { type: Schema.Types.Mixed, default: null },
    directKey: String,
    clientRequestId: String,
    creationFingerprint: String,
  },
  options("rooms"),
);
RoomSchema.index(
  { datasetId: 1, directKey: 1 },
  { unique: true, partialFilterExpression: { type: "direct" } },
);
RoomSchema.index(
  { datasetId: 1, createdBy: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { type: "group" } },
);
export const RoomMemberSchema = new Schema<RoomMemberRecord>(
  {
    _id: String,
    datasetId: String,
    userId: String,
    roomId: String,
    revision: Number,
    unreadCount: Number,
    lastReadSeq: Number,
    updatedAt: String,
    publishedRevision: Number,
    publishedSeq: Number,
    publishedEpoch: { type: String, default: null },
    dirty: Boolean,
  },
  options("room_members"),
);
RoomMemberSchema.index(
  { datasetId: 1, userId: 1, roomId: 1 },
  { unique: true },
);
RoomMemberSchema.index({ datasetId: 1, userId: 1, updatedAt: -1, roomId: 1 });
RoomMemberSchema.index({ datasetId: 1, userId: 1, dirty: 1, roomId: 1 });
export const MessageSchema = new Schema<MessageRecord>(
  {
    _id: String,
    datasetId: String,
    roomId: String,
    senderId: String,
    originDeviceId: String,
    clientMessageId: String,
    roomSeq: Number,
    type: String,
    text: String,
    createdAt: String,
    requestFingerprint: String,
  },
  options("messages"),
);
MessageSchema.index(
  { datasetId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true },
);
MessageSchema.index({ datasetId: 1, roomId: 1, roomSeq: 1 }, { unique: true });
export const DatasetSchema = new Schema<DatasetRecord>(
  { _id: String, datasetId: String, schemaVersion: Number },
  options("dataset_metadata"),
);
export function roomDto(
  room: RoomRecord,
  member: Pick<RoomMemberRecord, "revision" | "unreadCount" | "lastReadSeq">,
): RoomDto {
  return {
    id: room._id,
    type: room.type,
    title: room.title,
    memberIds: [...room.memberIds],
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    version: room.version,
    lastMessageSeq: room.lastMessageSeq,
    lastMessage: room.lastMessage,
    revision: member.revision,
    unreadCount: member.unreadCount,
    lastReadSeq: member.lastReadSeq,
  };
}
export function messageDto(message: MessageRecord): MessageDto {
  return {
    id: message._id,
    roomId: message.roomId,
    senderId: message.senderId,
    originDeviceId: message.originDeviceId,
    clientMessageId: message.clientMessageId,
    roomSeq: message.roomSeq,
    type: message.type,
    text: message.text,
    createdAt: message.createdAt,
  };
}
