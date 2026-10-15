import { isUuid, parseUserId, type UserId } from "@chat-poc/contracts";
import { AppError, LIMITS, utf8Size } from "./env";

export type Control =
  | { v: 2; type: "resume"; epoch: string; afterSeq: number; syncedAt: string }
  | { v: 2; type: "ack"; batchId: string; throughSeq: number }
  | { v: 2; type: "presence.watch"; userIds: UserId[] }
  | { v: 2; type: "presence.refresh" };

export type InFlight = {
  batchId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: number;
  retries: number;
};
export interface Attachment {
  attachmentVersion: 2;
  userId: UserId;
  deviceId: string;
  connectionId: string;
  datasetId: string;
  epoch: string;
  sessionExpiresAt: number;
  acceptedAt: number;
  resumedAt: number | null;
  mode: "awaiting_resume" | "replaying" | "live" | "retired";
  ackSeq: number;
  replayTargetSeq: number;
  inFlight: InFlight | null;
  watchIds: UserId[];
  retired: boolean;
}

export function saveAttachment(
  socket: WebSocket,
  attachment: Attachment,
): void {
  if (utf8Size(JSON.stringify(attachment)) >= 2_048)
    throw new Error("Socket attachment exceeds bounded size");
  socket.serializeAttachment(attachment);
}

export function parseControl(message: string | ArrayBuffer): Control {
  if (typeof message !== "string")
    throw new AppError(
      "VALIDATION_ERROR",
      "Binary control frames are unsupported.",
    );
  if (utf8Size(message) > LIMITS.controlBytes)
    throw new AppError(
      "FRAME_TOO_LARGE",
      "Control frame exceeds byte limit.",
      413,
    );
  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.v !== 2
    )
      throw new Error();
    let keys: string[];
    switch (value.type) {
      case "resume":
        keys = ["v", "type", "epoch", "afterSeq", "syncedAt"];
        if (
          !isUuid(value.epoch) ||
          typeof value.syncedAt !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(
            value.syncedAt,
          ) ||
          !Number.isFinite(Date.parse(value.syncedAt)) ||
          Date.parse(value.syncedAt) > Date.now() + 5_000 ||
          !Number.isSafeInteger(value.afterSeq) ||
          (value.afterSeq as number) < 0
        )
          throw new Error();
        break;
      case "ack":
        keys = ["v", "type", "batchId", "throughSeq"];
        if (
          !isUuid(value.batchId) ||
          !Number.isSafeInteger(value.throughSeq) ||
          (value.throughSeq as number) < 1
        )
          throw new Error();
        break;
      case "presence.watch":
        keys = ["v", "type", "userIds"];
        if (
          !Array.isArray(value.userIds) ||
          value.userIds.length > 3 ||
          new Set(value.userIds).size !== value.userIds.length
        )
          throw new Error();
        value.userIds = value.userIds.map(parseUserId);
        break;
      case "presence.refresh":
        keys = ["v", "type"];
        break;
      default:
        throw new Error();
    }
    if (Object.keys(value).some((key) => !keys.includes(key)))
      throw new Error();
    return value as Control;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid control frame.");
  }
}
