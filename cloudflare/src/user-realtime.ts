import { DurableObject } from "cloudflare:workers";
import {
  isUuid,
  parseUserId,
  parsePresence,
  unknownPresence,
  USER_IDS,
  type PresenceDto,
  type UserId,
} from "@chat-poc/contracts";
import { AppError, errorResponse, LIMITS, objectName, type Env } from "./env";
import type { SocketIdentity } from "./auth";
import { EventStore } from "./store";
import {
  parseControl,
  saveAttachment,
  type Attachment,
  type InFlight,
} from "./protocol";

export class UserRealtime extends DurableObject<Env> {
  private readonly store: EventStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new EventStore(ctx.storage);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    for (const socket of ctx.getWebSockets()) {
      const attachment = this.attachment(socket);
      if (!attachment || attachment.datasetId !== env.DATASET_ID) {
        try {
          socket.close(4002, "Stored connection configuration changed");
        } catch {
          /* Already closed. */
        }
      } else if (attachment.epoch !== this.store.meta().epoch) {
        this.requireSync(socket, attachment, "EPOCH_CHANGED");
      }
    }
    this.store.discardOrphanBatches(
      this.sockets()
        .filter(([, a]) => !a.retired)
        .map(([, a]) => a.connectionId),
    );
  }

  private identify(user: unknown): UserId {
    const userId = parseUserId(user);
    const expected = this.env.USER_REALTIME.idFromName(
      objectName(this.env.DATASET_ID, userId),
    );
    if (!expected.equals(this.ctx.id))
      throw new AppError(
        "DATASET_MISMATCH",
        "Object routing identity mismatch.",
        409,
      );
    this.store.identify(this.env.DATASET_ID, userId);
    return userId;
  }

  async append(raw: string, user: UserId) {
    try {
      const userId = this.identify(user);
      const result = await this.store.append(raw, this.env.DATASET_ID, userId);
      // A send error cannot turn accepted durable storage into a failed append.
      this.pumpAll();
      await this.schedule();
      return { ok: true as const, value: result };
    } catch (error) {
      // RPC only preserves standard Error properties. Carry application errors as data.
      const known = error instanceof AppError;
      return {
        ok: false as const,
        status: known ? error.status : 503,
        error: {
          code: known ? error.code : "DEPENDENCY_UNAVAILABLE",
          message: known ? error.message : "Realtime storage unavailable.",
          retryable: known ? error.retryable : true,
          ...(known && error.details ? { details: error.details } : {}),
        },
      };
    }
  }

  inspect(user: UserId) {
    try {
      this.identify(user);
      const value = this.store.inspect();
      this.ctx.waitUntil(this.schedule());
      return { ok: true as const, value };
    } catch (error) {
      const known = error instanceof AppError;
      return {
        ok: false as const,
        status: known ? error.status : 503,
        error: {
          code: known ? error.code : "DEPENDENCY_UNAVAILABLE",
          message: known ? error.message : "Realtime storage unavailable.",
          retryable: known ? error.retryable : true,
        },
      };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      if (
        new URL(request.url).pathname !== "/ws" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      )
        return new Response(null, { status: 404 });
      const userId = this.identify(request.headers.get("x-poc-user"));
      this.store.prune();
      const deviceId = request.headers.get("x-poc-device");
      const sessionExpiresAt = Number(request.headers.get("x-poc-expiry"));
      if (
        request.headers.get("x-poc-dataset") !== this.env.DATASET_ID ||
        !isUuid(deviceId) ||
        !Number.isSafeInteger(sessionExpiresAt) ||
        sessionExpiresAt <= Date.now()
      )
        throw new AppError("UNAUTHORIZED", "Invalid routed identity.", 401);
      const identity: SocketIdentity = {
        userId,
        deviceId,
        datasetId: this.env.DATASET_ID,
        sessionExpiresAt,
      };
      const current = this.sockets().filter(([, a]) => !a.retired);
      if (
        !current.some(([, a]) => a.deviceId === deviceId) &&
        current.length >= LIMITS.connectionsPerUser
      )
        throw new AppError(
          "RATE_LIMITED",
          "Demo connection limit reached.",
          429,
          true,
        );
      for (const [old, attachment] of current) {
        if (attachment.deviceId === deviceId)
          this.retire(old, attachment, 4009, "Device connection replaced");
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const attachment: Attachment = {
        attachmentVersion: 2,
        ...identity,
        epoch: this.store.meta().epoch,
        connectionId: crypto.randomUUID(),
        acceptedAt: Date.now(),
        resumedAt: null,
        mode: "awaiting_resume",
        ackSeq: 0,
        replayTargetSeq: 0,
        inFlight: null,
        watchIds: [],
        retired: false,
      };
      this.ctx.acceptWebSocket(server);
      saveAttachment(server, attachment);
      this.store.connect(deviceId, attachment.connectionId);
      server.send(
        JSON.stringify({
          v: 2,
          type: "hello",
          deviceId,
          connectionId: attachment.connectionId,
          ...this.store.inspect(),
          heartbeatIntervalMs: LIMITS.heartbeatMs,
          heartbeatTimeoutMs: LIMITS.heartbeatTimeoutMs,
          sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
        }),
      );
      this.evaluatePresence(userId);
      await this.schedule();
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      return errorResponse(error);
    }
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment || attachment.retired) return;
    try {
      if (attachment.sessionExpiresAt <= Date.now()) {
        this.retire(socket, attachment, 4001, "Session expired");
        return;
      }
      const frame = parseControl(message);
      if (frame.type === "resume") {
        if (
          attachment.mode !== "awaiting_resume" ||
          Date.now() - attachment.acceptedAt > LIMITS.resumeMs
        )
          throw new AppError(
            "VALIDATION_ERROR",
            "Resume is no longer allowed.",
          );
        const reason = this.store.fullSyncReason(
          frame.epoch,
          frame.afterSeq,
          frame.syncedAt,
        );
        if (reason) {
          this.requireSync(socket, attachment, reason);
          return;
        }
        const headSeq = this.store.head();
        attachment.ackSeq = frame.afterSeq;
        attachment.replayTargetSeq = headSeq;
        attachment.resumedAt = Date.now();
        attachment.mode = "replaying";
        saveAttachment(socket, attachment);
        socket.send(
          JSON.stringify({
            v: 2,
            type: "sync.started",
            epoch: this.store.meta().epoch,
            afterSeq: frame.afterSeq,
            targetSeq: headSeq,
          }),
        );
        this.pump(socket, attachment);
        this.evaluatePresence(attachment.userId);
      } else {
        if (attachment.mode === "awaiting_resume")
          throw new AppError("VALIDATION_ERROR", "Resume required first.");
        if (frame.type === "ack") {
          if (frame.throughSeq <= attachment.ackSeq) return;
          const pending = attachment.inFlight;
          if (
            !pending ||
            pending.batchId !== frame.batchId ||
            pending.toSeq !== frame.throughSeq
          )
            throw new AppError(
              "VALIDATION_ERROR",
              "ACK does not match the active batch.",
            );
          this.ctx.storage.transactionSync(() =>
            this.store.ack(
              attachment.deviceId,
              frame.throughSeq,
              attachment.connectionId,
            ),
          );
          attachment.ackSeq = frame.throughSeq;
          attachment.inFlight = null;
          saveAttachment(socket, attachment);
          await this.ctx.storage.sync();
          // A concurrent close or replacement during disk flush cannot revive this socket.
          const latest = this.attachment(socket);
          if (latest && !latest.retired) this.pump(socket, latest);
        } else {
          if (frame.type === "presence.watch") {
            attachment.watchIds = frame.userIds;
            saveAttachment(socket, attachment);
          }
          const items = await this.snapshot(
            attachment.userId,
            attachment.watchIds,
          );
          if (
            !this.attachment(socket)?.retired &&
            socket.readyState === WebSocket.OPEN
          )
            socket.send(
              JSON.stringify({ v: 2, type: "presence.snapshot", items }),
            );
        }
      }
    } catch (error) {
      const known = error instanceof AppError;
      const code = known ? error.code : "DEPENDENCY_UNAVAILABLE";
      try {
        socket.send(
          JSON.stringify({
            v: 2,
            type: "error",
            code,
            message: known ? error.message : "Realtime storage unavailable.",
            retryable: known ? error.retryable : true,
          }),
        );
      } catch {
        /* Socket already closed. */
      }
      this.retire(
        socket,
        this.attachment(socket) ?? attachment,
        code === "STREAM_NOT_READY" || !known
          ? 1013
          : code === "FRAME_TOO_LARGE"
            ? 1009
            : 4002,
        code,
      );
    } finally {
      this.evaluatePresence(attachment.userId);
      await this.schedule();
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.socketClosed(socket);
  }
  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.socketClosed(socket);
  }

  private async socketClosed(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment) return;
    this.retire(socket, attachment, 1000, "Connection closed");
    this.evaluatePresence(attachment.userId);
    await this.schedule();
  }

  private attachment(socket: WebSocket): Attachment | null {
    const value = socket.deserializeAttachment() as Attachment | null;
    return value?.attachmentVersion === 2 ? value : null;
  }

  private sockets(): [WebSocket, Attachment][] {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = this.attachment(socket);
      return attachment
        ? [[socket, attachment] as [WebSocket, Attachment]]
        : [];
    });
  }

  private retire(
    socket: WebSocket,
    attachment: Attachment,
    code: number,
    reason: string,
  ): void {
    this.store.discardBatch(attachment.connectionId);
    attachment.retired = true;
    attachment.mode = "retired";
    attachment.inFlight = null;
    saveAttachment(socket, attachment);
    try {
      socket.close(code, reason);
    } catch {
      /* Already closed. */
    }
  }

  private requireSync(
    socket: WebSocket,
    attachment: Attachment,
    reason: string,
  ): void {
    socket.send(
      JSON.stringify({
        v: 2,
        type: "sync.required",
        reason,
        ...this.store.inspect(),
      }),
    );
    this.retire(socket, attachment, 4010, "Full room snapshot required");
  }

  private pump(socket: WebSocket, attachment: Attachment): void {
    if (
      attachment.retired ||
      attachment.mode === "awaiting_resume" ||
      attachment.inFlight ||
      socket.readyState !== WebSocket.OPEN
    )
      return;
    if (attachment.sessionExpiresAt <= Date.now()) {
      this.retire(socket, attachment, 4001, "Session expired");
      return;
    }
    this.store.prune();
    const meta = this.store.meta();
    if (attachment.epoch !== meta.epoch || attachment.ackSeq > meta.head_seq) {
      this.requireSync(
        socket,
        attachment,
        attachment.epoch !== meta.epoch ? "EPOCH_CHANGED" : "CURSOR_AHEAD",
      );
      return;
    }
    if (
      attachment.ackSeq < meta.replay_floor ||
      meta.head_seq - attachment.ackSeq > LIMITS.maxDeltaGap
    ) {
      this.requireSync(
        socket,
        attachment,
        attachment.ackSeq < meta.replay_floor
          ? "CURSOR_EXPIRED"
          : "DELTA_TOO_LARGE",
      );
      return;
    }
    // No delta work is due for an already caught-up socket. The expiry/floor
    // checks above still run, including when an access precedes the TTL alarm.
    if (attachment.ackSeq === meta.head_seq && attachment.mode === "live")
      return;
    // Capture the current head at each page. An update can compact an unseen room
    // past an earlier replay target; it must still be included before sync.ready.
    const batch = this.store.createBatch(
      attachment.connectionId,
      attachment.ackSeq,
    );
    if (!batch) {
      if (attachment.mode === "replaying") {
        attachment.mode = "live";
        attachment.replayTargetSeq = meta.head_seq;
        saveAttachment(socket, attachment);
        socket.send(
          JSON.stringify({
            v: 2,
            type: "sync.ready",
            epoch: meta.epoch,
            throughSeq: attachment.ackSeq,
            syncedAt: new Date().toISOString(),
          }),
        );
      }
      return;
    }
    const pending: InFlight = {
      batchId: batch.batchId,
      fromSeq: batch.fromSeq,
      toSeq: batch.toSeq,
      sentAt: Date.now(),
      retries: 0,
    };
    attachment.inFlight = pending;
    saveAttachment(socket, attachment);
    socket.send(this.store.readBatch(attachment.connectionId));
  }

  private pumpAll(): void {
    for (const [socket, attachment] of this.sockets()) {
      try {
        this.pump(socket, attachment);
      } catch {
        this.retire(socket, attachment, 1013, "Stream must resume");
        this.evaluatePresence(attachment.userId);
      }
    }
  }

  private evaluatePresence(userId: UserId): PresenceDto {
    const now = Date.now();
    const devices = new Set<string>();
    for (const [socket, attachment] of this.sockets()) {
      const heartbeatAt =
        this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ??
        attachment.resumedAt;
      if (
        !attachment.retired &&
        attachment.mode !== "awaiting_resume" &&
        socket.readyState === WebSocket.OPEN &&
        attachment.sessionExpiresAt > now &&
        heartbeatAt !== null &&
        now - heartbeatAt <= LIMITS.leaseMs
      )
        devices.add(attachment.deviceId);
    }
    const { revision } = this.store.presence(devices.size);
    return {
      userId,
      state: devices.size ? "online" : "offline",
      activeDeviceCount: devices.size,
      connectionCount: devices.size,
      revision,
      observedAt: new Date(now).toISOString(),
    };
  }

  localPresence(user: UserId): PresenceDto {
    const userId = this.identify(user);
    const result = this.evaluatePresence(userId);
    // Return local status without awaiting any cross-object work.
    this.ctx.waitUntil(this.schedule());
    return result;
  }

  receivePresence(user: UserId, datasetId: string, input: PresenceDto): void {
    this.identify(user);
    if (datasetId !== this.env.DATASET_ID)
      throw new AppError("DATASET_MISMATCH", "Presence dataset mismatch.", 409);
    const item = parsePresence(input);
    for (const [socket, attachment] of this.sockets()) {
      if (
        !attachment.retired &&
        attachment.mode !== "awaiting_resume" &&
        attachment.watchIds.includes(item.userId) &&
        attachment.sessionExpiresAt > Date.now() &&
        socket.readyState === WebSocket.OPEN
      ) {
        try {
          socket.send(JSON.stringify({ v: 2, type: "presence.changed", item }));
        } catch {
          this.retire(socket, attachment, 1013, "Connection unavailable");
          this.evaluatePresence(attachment.userId);
          this.ctx.waitUntil(this.schedule());
        }
      }
    }
  }

  private async snapshot(
    userId: UserId,
    watched: UserId[],
  ): Promise<PresenceDto[]> {
    return Promise.all(
      watched.map(async (target) => {
        try {
          if (target === userId) return this.evaluatePresence(userId);
          return await this.env.USER_REALTIME.getByName(
            objectName(this.env.DATASET_ID, target),
          ).localPresence(target);
        } catch {
          return unknownPresence(target);
        }
      }),
    );
  }

  private async schedule(): Promise<void> {
    const now = Date.now();
    const deadlines: number[] = [];
    let hasConnections = false;
    for (const [, attachment] of this.sockets()) {
      if (attachment.retired) continue;
      hasConnections = true;
      deadlines.push(attachment.sessionExpiresAt);
      if (attachment.mode === "awaiting_resume")
        deadlines.push(attachment.acceptedAt + LIMITS.resumeMs);
      if (attachment.inFlight)
        deadlines.push(attachment.inFlight.sentAt + LIMITS.ackMs);
    }
    const meta = this.store.meta();
    const sweepAt = this.store.presenceSweepDeadline(now, hasConnections, meta);
    if (sweepAt !== null) deadlines.push(sweepAt);
    const expiryAt = this.store.expiryDeadline();
    if (expiryAt !== null) deadlines.push(expiryAt);
    if (meta.presence_revision > meta.last_presence_attempt_revision)
      deadlines.push(now + 1);
    if (deadlines.length)
      await this.ctx.storage.setAlarm(
        Math.max(now + 1, Math.min(...deadlines)),
      );
    else await this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const expired = this.store.prune(now);
    // Only a due sweep advances its cadence. ACK/notification/control activity
    // must preserve the existing deadline, including across constructor re-entry.
    this.store.advancePresenceSweep(now);
    for (const [socket, attachment] of this.sockets()) {
      if (attachment.retired) continue;
      if (attachment.sessionExpiresAt <= now)
        this.retire(socket, attachment, 4001, "Session expired");
      else if (
        attachment.mode === "awaiting_resume" &&
        now >= attachment.acceptedAt + LIMITS.resumeMs
      )
        this.retire(socket, attachment, 4002, "Resume timeout");
      else if (
        attachment.inFlight &&
        now >= attachment.inFlight.sentAt + LIMITS.ackMs
      ) {
        const pending = attachment.inFlight;
        if (pending.retries >= LIMITS.retransmissions)
          this.retire(socket, attachment, 1013, "ACK timeout");
        else {
          try {
            const body = this.store.readBatch(attachment.connectionId);
            pending.retries++;
            pending.sentAt = now;
            saveAttachment(socket, attachment);
            socket.send(body);
          } catch {
            this.retire(socket, attachment, 1013, "Retained batch unavailable");
          }
        }
      }
    }
    const user = this.store.meta().user_id;
    if (user !== null) {
      const userId = parseUserId(user);
      const item = this.evaluatePresence(userId);
      const meta = this.store.meta();
      if (meta.presence_revision > meta.last_presence_attempt_revision) {
        this.store.markPresenceAttempt(meta.presence_revision);
        await Promise.allSettled(
          USER_IDS.filter((target) => target !== userId).map((target) =>
            this.env.USER_REALTIME.getByName(
              objectName(this.env.DATASET_ID, target),
            ).receivePresence(target, this.env.DATASET_ID, item),
          ),
        );
      }
    }
    // Append, resume and ACK handlers pump immediately. An idle presence alarm
    // need not re-query every live socket; expiry alone can invalidate coverage.
    if (expired) this.pumpAll();
    await this.schedule();
  }
}
