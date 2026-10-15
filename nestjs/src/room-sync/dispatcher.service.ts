import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import type { Connection, Model } from "mongoose";
import {
  DEFAULTS,
  USER_IDS,
  parseRoomUpdate,
  type UserId,
} from "@chat-poc/contracts";
import {
  ROOM,
  ROOM_MEMBER,
  type RoomRecord,
  type RoomMemberRecord,
  roomDto,
} from "../database/schemas.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ApiError } from "../common/errors.js";
import { safeErrorCode } from "../common/logging.js";
import { RealtimeClient } from "../realtime/realtime.client.js";
import { transactionOptions } from "../rooms/rooms.service.js";
export const RELAY_ENABLED = Symbol("RELAY_ENABLED");
interface RelayState {
  epoch: string | null;
  head: number | null;
  checkedAt: number;
  available: boolean;
  blockedCode: string | null;
  lastAppendAt: string | null;
  nextAttemptAt: number;
  failures: number;
  lastErrorCode: string | null;
}
@Injectable()
export class PublicationProbe {
  check(_stage: string): void {}
}
/** Recoverable relay of CURRENT membership state. No Mongo event log is created. */
@Injectable()
export class RoomProjectionDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly logger = new Logger("RoomSync");
  private readonly work = new Map<UserId, Promise<void>>();
  private readonly states = new Map<UserId, RelayState>(
    USER_IDS.map((id) => [
      id,
      {
        epoch: null,
        head: null,
        checkedAt: 0,
        available: false,
        blockedCode: null,
        lastAppendAt: null,
        nextAttemptAt: 0,
        failures: 0,
        lastErrorCode: null,
      },
    ]),
  );
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ROOM) private readonly rooms: Model<RoomRecord>,
    @InjectModel(ROOM_MEMBER) private readonly members: Model<RoomMemberRecord>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RealtimeClient) private readonly client: RealtimeClient,
    @Inject(RELAY_ENABLED) private readonly enabled: boolean,
    @Inject(PublicationProbe) private readonly probe: PublicationProbe,
  ) {}
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      for (const id of USER_IDS) void this.tick(id).catch(() => {});
    }, DEFAULTS.projectionPollMs);
    this.timer.unref();
    for (const id of USER_IDS) void this.tick(id, true).catch(() => {});
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.work.values());
  }
  tick(userId: UserId, forceReconcile = false): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const current = this.work.get(userId);
    if (current) return current;
    const promise = this.run(userId, forceReconcile).finally(() =>
      this.work.delete(userId),
    );
    this.work.set(userId, promise);
    return promise;
  }
  private async run(userId: UserId, force: boolean): Promise<void> {
    const state = this.states.get(userId)!;
    if (state.blockedCode || (!force && Date.now() < state.nextAttemptAt))
      return;
    const wasAvailable = state.available;
    const previousFailures = state.failures;
    let published = 0;
    try {
      if (
        force ||
        !state.epoch ||
        Date.now() - state.checkedAt >= DEFAULTS.reconcileIntervalMs
      ) {
        const head = await this.client.head(userId);
        // Epoch change OR restored head regression requires fresh current projections.
        const rolledBack = await this.members.exists({
          datasetId: this.config.datasetId,
          userId,
          publishedEpoch: head.epoch,
          publishedSeq: { $gt: head.headSeq },
        });
        if (
          rolledBack ||
          (state.epoch && state.epoch !== head.epoch) ||
          (state.head !== null && state.head > head.headSeq)
        )
          await this.members.updateMany(
            { datasetId: this.config.datasetId, userId },
            { $set: { dirty: true } },
          );
        // Persisted epoch catches process restart followed by a replaced Durable Object.
        await this.members.updateMany(
          {
            datasetId: this.config.datasetId,
            userId,
            publishedEpoch: { $ne: head.epoch },
          },
          { $set: { dirty: true } },
        );
        state.epoch = head.epoch;
        state.head = head.headSeq;
        state.checkedAt = Date.now();
      }
      const candidates = await this.members
        .find({ datasetId: this.config.datasetId, userId, dirty: true })
        .sort({ roomId: 1 })
        .limit(DEFAULTS.maxBatchEvents)
        .select({ _id: 1 })
        .lean();
      for (const candidate of candidates) {
        if (this.stopping) break;
        // Read room and personalized state from one committed snapshot.
        const current = await this.connection.transaction(async (session) => {
          const member = await this.members
            .findOne({ _id: candidate._id, dirty: true })
            .session(session)
            .lean();
          if (!member) return null;
          const room = await this.rooms
            .findOne({ _id: member.roomId, datasetId: this.config.datasetId })
            .session(session)
            .lean();
          if (!room || !room.memberIds.includes(userId))
            throw new ApiError(
              409,
              "STATE_CONFLICT",
              "Room membership is inconsistent.",
            );
          return {
            member,
            update: parseRoomUpdate({
              v: 2,
              datasetId: this.config.datasetId,
              userId,
              type: "room.upserted",
              data: { room: roomDto(room, member) },
            }),
          };
        }, transactionOptions);
        if (!current) continue;
        const result = await this.client.append(
          userId,
          JSON.stringify(current.update),
        );
        if (state.epoch !== result.epoch) {
          await this.members.updateMany(
            { datasetId: this.config.datasetId, userId },
            { $set: { dirty: true } },
          );
          state.epoch = result.epoch;
        }
        published++;
        state.head = result.headSeq;
        state.lastAppendAt = new Date().toISOString();
        this.probe.check("accepted");
        // A concurrent mutation keeps dirty=true and is picked up on the next turn.
        await this.members.updateOne(
          { _id: current.member._id, revision: current.member.revision },
          {
            $set: {
              publishedRevision: current.member.revision,
              publishedSeq: result.acceptedSeq,
              publishedEpoch: result.epoch,
              dirty: false,
            },
          },
        );
      }
      if (published > 0)
        this.logger.log(
          `Published room states user=${userId} count=${published} head=${state.head}`,
        );
      if (!wasAvailable)
        this.logger.log(
          `Realtime ${previousFailures ? "recovered" : "connected"} user=${userId} head=${state.head}`,
        );
      state.available = true;
      state.lastErrorCode = null;
      state.failures = 0;
      state.nextAttemptAt = 0;
    } catch (error) {
      const code = safeErrorCode(
        error instanceof ApiError ? error.code : "DEPENDENCY_UNAVAILABLE",
      );
      state.available = false;
      state.failures++;
      state.nextAttemptAt =
        Date.now() +
        Math.floor(
          Math.random() *
            Math.min(30_000, 1000 * 2 ** Math.min(state.failures - 1, 5)),
        );
      if (
        ["EVENT_CONFLICT", "DATASET_MISMATCH", "STATE_CONFLICT"].includes(code)
      )
        state.blockedCode = code;
      if (state.failures === 1 || state.lastErrorCode !== code)
        this.logger.warn(
          `Realtime unavailable user=${userId} code=${code} retryMs=${Math.max(0, state.nextAttemptAt - Date.now())} blocked=${state.blockedCode !== null}`,
        );
      state.lastErrorCode = code;
    }
  }
  async diagnostics(userId: UserId): Promise<Record<string, unknown>> {
    const state = this.states.get(userId)!;
    return {
      workerHead: state.head,
      workerEpoch: state.epoch,
      workerHeadCheckedAt: state.checkedAt
        ? new Date(state.checkedAt).toISOString()
        : null,
      pendingRoomCount: await this.members.countDocuments({
        datasetId: this.config.datasetId,
        userId,
        dirty: true,
      }),
      blockedCode: state.blockedCode,
      lastSuccessfulAppendAt: state.lastAppendAt,
      dependencyStatus: {
        mongo: "available",
        realtime: state.available ? "available" : "unavailable",
      },
    };
  }
}
