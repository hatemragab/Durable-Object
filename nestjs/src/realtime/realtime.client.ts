import { Inject, Injectable } from "@nestjs/common";
import {
  DEFAULTS,
  parsePresence,
  safeInteger,
  unknownPresence,
  type PresenceDto,
  type UserId,
} from "@chat-poc/contracts";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ApiError, unavailable } from "../common/errors.js";

export interface StreamHead {
  datasetId: string;
  userId: UserId;
  headSeq: number;
  retainedFromSeq: number;
  eventCount: number;
  epoch: string;
  replayFloor: number;
  retentionMs: number;
}
export const WORKER_FETCH = Symbol("WORKER_FETCH");
export type WorkerFetch = typeof fetch;

@Injectable()
export class RealtimeClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WORKER_FETCH) private readonly transport: WorkerFetch,
  ) {}

  private async request(
    path: string,
    method = "GET",
    payload?: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.transport(
        new URL(path, this.config.realtimeBaseUrl),
        {
          method,
          headers: {
            Authorization: `Bearer ${this.config.internalSecret}`,
            "X-Dataset-Id": this.config.datasetId,
            "Content-Type": "application/json",
          },
          ...(payload === undefined ? {} : { body: payload }),
          signal: AbortSignal.timeout(DEFAULTS.workerTimeoutMs),
          redirect: "error",
        },
      );
    } catch {
      throw unavailable();
    }
    let data: Record<string, unknown>;
    try {
      const content = await response.text();
      if (Buffer.byteLength(content) > 65_536)
        throw new Error("Oversized Worker response");
      data = JSON.parse(content) as Record<string, unknown>;
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid Worker response");
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      const nested =
        data.error && typeof data.error === "object"
          ? (data.error as Record<string, unknown>)
          : data;
      const code =
        typeof nested.code === "string"
          ? nested.code
          : "DEPENDENCY_UNAVAILABLE";
      const known = [
        "SEQ_GAP",
        "EVENT_CONFLICT",
        "DATASET_MISMATCH",
        "DEMO_LIMIT_REACHED",
        "RATE_LIMITED",
        "STREAM_NOT_READY",
      ];
      const retryAfter = response.headers.get("Retry-After");
      const parsedRetry =
        retryAfter === null
          ? Number.NaN
          : /^\d+$/.test(retryAfter)
            ? Number(retryAfter)
            : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
      const retrySeconds =
        Number.isSafeInteger(parsedRetry) && parsedRetry >= 0
          ? parsedRetry
          : undefined;
      throw new ApiError(
        response.status >= 400 && response.status <= 599
          ? response.status
          : 503,
        known.includes(code) ? code : "DEPENDENCY_UNAVAILABLE",
        "The realtime integration request was rejected.",
        !["EVENT_CONFLICT", "DATASET_MISMATCH", "DEMO_LIMIT_REACHED"].includes(
          code,
        ),
        retrySeconds,
      );
    }
    if (data.datasetId !== this.config.datasetId)
      throw new ApiError(
        409,
        "DATASET_MISMATCH",
        "The Worker belongs to a different dataset.",
      );
    return data;
  }
  async head(userId: UserId): Promise<StreamHead> {
    const data = await this.request(`/internal/v1/users/${userId}/stream`);
    try {
      if (
        data.userId !== userId ||
        typeof data.epoch !== "string" ||
        !data.epoch ||
        data.epoch.length > 128
      )
        throw new Error("Invalid stream identity");
      const headSeq = safeInteger(data.headSeq),
        replayFloor = safeInteger(data.replayFloor),
        eventCount = safeInteger(data.eventCount),
        retainedFromSeq = safeInteger(data.retainedFromSeq, 1),
        retentionMs = safeInteger(data.retentionMs, 1);
      if (
        replayFloor > headSeq ||
        retainedFromSeq !== replayFloor + 1 ||
        eventCount > DEFAULTS.maxRoomsPerUser ||
        retentionMs !== DEFAULTS.eventRetentionMs
      )
        throw new Error("Invalid retained projection stream");
      return {
        datasetId: this.config.datasetId,
        userId,
        epoch: data.epoch,
        headSeq,
        replayFloor,
        retainedFromSeq,
        eventCount,
        retentionMs,
      };
    } catch {
      // A staged deployment can temporarily return protocol-1 metadata.
      // Malformed/incompatible responses prove no durable-state conflict.
      throw unavailable();
    }
  }
  async append(
    userId: UserId,
    json: string,
  ): Promise<{
    epoch: string;
    acceptedSeq: number;
    headSeq: number;
    duplicate: boolean;
  }> {
    const data = await this.request(
      `/internal/v1/users/${userId}/events`,
      "POST",
      json,
    );
    try {
      if (
        data.userId !== userId ||
        typeof data.epoch !== "string" ||
        !data.epoch ||
        typeof data.duplicate !== "boolean"
      )
        throw new Error();
      const acceptedSeq = safeInteger(data.acceptedSeq, 1),
        headSeq = safeInteger(data.headSeq, 1);
      if (acceptedSeq > headSeq) throw new Error();
      return {
        epoch: data.epoch,
        acceptedSeq,
        headSeq,
        duplicate: data.duplicate,
      };
    } catch {
      // Acceptance is uncertain; retain dirty state and retry idempotently.
      throw unavailable();
    }
  }
  async presence(userIds: UserId[]): Promise<PresenceDto[]> {
    try {
      const data = await this.request(
        "/internal/v1/presence/query",
        "POST",
        JSON.stringify({ userIds }),
      );
      if (!Array.isArray(data.items) || data.items.length !== userIds.length)
        return userIds.map(unknownPresence);
      const items = data.items.map(parsePresence);
      if (
        new Set(items.map((item) => item.userId)).size !== userIds.length ||
        items.some((item) => !userIds.includes(item.userId))
      )
        return userIds.map(unknownPresence);
      return userIds.map((id) => items.find((item) => item.userId === id)!);
    } catch {
      return userIds.map(unknownPresence);
    }
  }
}
