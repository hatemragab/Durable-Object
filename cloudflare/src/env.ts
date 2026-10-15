import type { UserRealtime } from "./user-realtime";
import { DEFAULTS, utf8Bytes } from "@chat-poc/contracts";

export interface Env {
  APP_ENV: string;
  DATASET_ID: string;
  WS_TICKET_SECRET: string;
  REALTIME_INTERNAL_SECRET: string;
  USER_REALTIME: DurableObjectNamespace<UserRealtime>;
}

export const LIMITS = Object.freeze({
  eventsPerBatch: DEFAULTS.maxBatchEvents,
  batchBytes: DEFAULTS.maxBatchBytes,
  eventBytes: DEFAULTS.maxEventBytes,
  controlBytes: DEFAULTS.maxControlBytes,
  roomsPerUser: DEFAULTS.maxRoomsPerUser,
  retentionMs: DEFAULTS.eventRetentionMs,
  maxDeltaGap: DEFAULTS.maxDeltaGap,
  resumeMs: DEFAULTS.resumeTimeoutMs,
  ackMs: DEFAULTS.ackTimeoutMs,
  retransmissions: DEFAULTS.maxBatchRetransmissions,
  heartbeatMs: DEFAULTS.heartbeatIntervalMs,
  heartbeatTimeoutMs: DEFAULTS.heartbeatTimeoutMs,
  leaseMs: DEFAULTS.livenessLeaseMs,
  sweepMs: DEFAULTS.presenceSweepMs,
  connectionsPerUser: 10,
});

export function objectName(datasetId: string, userId: string): string {
  return `${datasetId}:${userId}`;
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const utf8Size = utf8Bytes;

export function errorResponse(error: unknown): Response {
  const known = error instanceof AppError;
  const status = known ? error.status : 503;
  const body = known
    ? {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      }
    : {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Realtime service unavailable.",
        retryable: true,
      };
  return Response.json(
    { error: body, requestId: crypto.randomUUID() },
    { status },
  );
}
