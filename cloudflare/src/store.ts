import {
  parseRoomUpdate,
  type EventBatch,
  type EventEnvelope,
  type RoomUpdate,
  type UserId,
} from "@chat-poc/contracts";
import { AppError, LIMITS, utf8Size } from "./env";

type Meta = {
  schema_version: number;
  dataset_id: string | null;
  user_id: string | null;
  epoch: string;
  head_seq: number;
  replay_floor: number;
  retained_count: number;
  presence_state: string;
  presence_revision: number;
  presence_count: number;
  last_presence_attempt_revision: number;
  presence_sweep_at_ms: number | null;
};
type RoomRow = {
  room_id: string;
  stream_seq: number;
  envelope_json: string;
  expires_at_ms: number;
};
type VersionRow = {
  revision: number;
  envelope_hash: string;
  accepted_seq: number;
  retained_room_id: string | null;
};

/** A compacted room projection, never an immutable message/event journal. */
export class EventStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS sync_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL,
        dataset_id TEXT, user_id TEXT, epoch TEXT NOT NULL,
        head_seq INTEGER NOT NULL DEFAULT 0, replay_floor INTEGER NOT NULL DEFAULT 0,
        retained_count INTEGER NOT NULL DEFAULT 0 CHECK(retained_count>=0),
        presence_state TEXT NOT NULL DEFAULT 'offline', presence_revision INTEGER NOT NULL DEFAULT 0,
        presence_count INTEGER NOT NULL DEFAULT 0, last_presence_attempt_revision INTEGER NOT NULL DEFAULT 0,
        presence_sweep_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS room_changes (
        room_id TEXT PRIMARY KEY, stream_seq INTEGER NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS room_changes_expiry ON room_changes(expires_at_ms);
      CREATE TABLE IF NOT EXISTS room_versions (
        room_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
        envelope_hash TEXT NOT NULL, accepted_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inflight_batches (
        connection_id TEXT PRIMARY KEY, batch_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY, latest_connection_id TEXT,
        max_ack_seq INTEGER NOT NULL DEFAULT 0, last_connected_at_ms INTEGER, last_ack_at_ms INTEGER
      );`);
      const fresh =
        storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM sync_meta")
          .one().n === 0;
      if (fresh) {
        storage.sql.exec(
          "INSERT INTO sync_meta(id,schema_version,epoch) VALUES(1,4,?)",
          crypto.randomUUID(),
        );
        // Protocol v2 explicitly replaces the old retained event history. The new
        // epoch forces existing caches through an authoritative HTTP snapshot.
        storage.sql.exec(
          "DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS schema_meta; UPDATE devices SET max_ack_seq=0",
        );
      }
      const version = this.meta().schema_version;
      if (version === 3) {
        // Additive, atomic migration: preserve the epoch, payloads and device ACKs.
        // Count once on migration, never on routine stream inspections.
        storage.sql.exec(
          "ALTER TABLE sync_meta ADD COLUMN retained_count INTEGER NOT NULL DEFAULT 0 CHECK(retained_count>=0)",
        );
        storage.sql.exec(
          "UPDATE sync_meta SET schema_version=4,retained_count=(SELECT COUNT(*) FROM room_changes) WHERE id=1",
        );
      } else if (version !== 4)
        throw new AppError(
          "EVENT_CONFLICT",
          "Unsupported storage schema.",
          409,
        );
    });
  }

  meta(): Meta {
    return this.storage.sql
      .exec<Meta>("SELECT * FROM sync_meta WHERE id=1")
      .one();
  }

  identify(datasetId: string, userId: UserId): void {
    this.storage.transactionSync(() => {
      const row = this.meta();
      if (row.dataset_id === null && row.user_id === null) {
        this.storage.sql.exec(
          "UPDATE sync_meta SET dataset_id=?,user_id=? WHERE id=1",
          datasetId,
          userId,
        );
      } else if (row.dataset_id !== datasetId || row.user_id !== userId) {
        throw new AppError(
          "DATASET_MISMATCH",
          "Object storage identity mismatch.",
          409,
        );
      }
    });
  }

  head(): number {
    return this.meta().head_seq;
  }

  prune(now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      // MIN uses the expiry index. Do not scan room rows on every idle access.
      const deadline = this.expiryDeadline();
      if (deadline === null || deadline > now) return false;
      const expired = this.storage.sql
        .exec<{
          floor: number | null;
          count: number;
        }>(
          "SELECT MAX(stream_seq) AS floor,COUNT(*) AS count FROM room_changes INDEXED BY room_changes_expiry WHERE expires_at_ms<=?",
          now,
        )
        .one();
      if (expired.floor !== null) {
        this.storage.sql.exec(
          "UPDATE sync_meta SET replay_floor=MAX(replay_floor,?),retained_count=retained_count-? WHERE id=1",
          expired.floor,
          expired.count,
        );
        this.storage.sql.exec(
          "DELETE FROM room_changes WHERE expires_at_ms<=?",
          now,
        );
        return true;
      }
      return false;
    });
  }

  expiryDeadline(): number | null {
    return this.storage.sql
      .exec<{
        deadline: number | null;
      }>("SELECT MIN(expires_at_ms) AS deadline FROM room_changes")
      .one().deadline;
  }

  inspect() {
    this.prune();
    const meta = this.meta();
    return {
      datasetId: meta.dataset_id,
      userId: meta.user_id,
      epoch: meta.epoch,
      headSeq: meta.head_seq,
      replayFloor: meta.replay_floor,
      retainedFromSeq: meta.replay_floor + 1,
      eventCount: meta.retained_count,
      retentionMs: LIMITS.retentionMs,
    };
  }

  async append(raw: string, datasetId: string, userId: UserId) {
    if (utf8Size(raw) > LIMITS.eventBytes)
      throw new AppError("VALIDATION_ERROR", "Room update exceeds byte limit.");
    let update: RoomUpdate;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (
        !value ||
        Object.keys(value).some(
          (key) => !["v", "datasetId", "userId", "type", "data"].includes(key),
        )
      )
        throw new Error("Unknown field");
      update = parseRoomUpdate(value);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Invalid room update.");
    }
    if (update.datasetId !== datasetId || update.userId !== userId)
      throw new AppError("DATASET_MISMATCH", "Room recipient mismatch.", 409);
    // Hash validated, normalized JSON so harmless transport whitespace is not a conflict.
    const normalized = JSON.stringify(update);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalized),
    );
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const result = this.storage.transactionSync(() => {
      this.prune();
      const room = update.data.room;
      const existing = this.storage.sql
        .exec<VersionRow>(
          "SELECT v.*,c.room_id AS retained_room_id FROM room_versions v LEFT JOIN room_changes c ON c.room_id=v.room_id WHERE v.room_id=?",
          room.id,
        )
        .toArray()[0];
      if (existing && room.revision <= existing.revision) {
        if (
          room.revision === existing.revision &&
          existing.envelope_hash !== hash
        )
          throw new AppError(
            "EVENT_CONFLICT",
            "Room revision has conflicting content.",
            409,
          );
        return { acceptedSeq: existing.accepted_seq, duplicate: true };
      }
      if (!existing) {
        const count = this.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM room_versions")
          .one().n;
        if (count >= LIMITS.roomsPerUser)
          throw new AppError(
            "DEMO_LIMIT_REACHED",
            "Dataset room limit reached.",
            429,
          );
      }
      const seq = this.head() + 1;
      if (!Number.isSafeInteger(seq))
        throw new AppError("EVENT_CONFLICT", "Cursor exhausted.", 409);
      const event: EventEnvelope = { ...update, streamSeq: seq };
      if (utf8Size(JSON.stringify(event)) > LIMITS.eventBytes)
        throw new AppError(
          "VALIDATION_ERROR",
          "Room envelope exceeds byte limit.",
        );
      this.storage.sql.exec(
        `INSERT INTO room_changes(room_id,stream_seq,envelope_json,expires_at_ms) VALUES(?,?,?,?)
         ON CONFLICT(room_id) DO UPDATE SET stream_seq=excluded.stream_seq,envelope_json=excluded.envelope_json,expires_at_ms=excluded.expires_at_ms`,
        room.id,
        seq,
        JSON.stringify(event),
        Date.now() + LIMITS.retentionMs,
      );
      this.storage.sql.exec(
        `INSERT INTO room_versions(room_id,revision,envelope_hash,accepted_seq) VALUES(?,?,?,?)
         ON CONFLICT(room_id) DO UPDATE SET revision=excluded.revision,envelope_hash=excluded.envelope_hash,accepted_seq=excluded.accepted_seq`,
        room.id,
        room.revision,
        hash,
        seq,
      );
      this.storage.sql.exec(
        "UPDATE sync_meta SET head_seq=?,retained_count=retained_count+? WHERE id=1",
        seq,
        existing?.retained_room_id ? 0 : 1,
      );
      return { acceptedSeq: seq, duplicate: false };
    });
    await this.storage.sync();
    const meta = this.meta();
    return {
      datasetId,
      userId,
      epoch: meta.epoch,
      ...result,
      headSeq: meta.head_seq,
    };
  }

  fullSyncReason(
    epoch: string,
    afterSeq: number,
    syncedAt: string,
  ): string | null {
    this.prune();
    const meta = this.meta();
    if (epoch !== meta.epoch) return "EPOCH_CHANGED";
    if (Date.now() - Date.parse(syncedAt) >= LIMITS.retentionMs)
      return "CURSOR_EXPIRED";
    if (afterSeq < meta.replay_floor) return "CURSOR_EXPIRED";
    if (afterSeq > meta.head_seq) return "CURSOR_AHEAD";
    if (meta.head_seq - afterSeq > LIMITS.maxDeltaGap) return "DELTA_TOO_LARGE";
    return null;
  }

  /** Freeze exact bytes before emitting: subsequent compaction must not alter retries. */
  createBatch(connectionId: string, afterSeq: number): EventBatch | null {
    return this.storage.transactionSync(() => {
      this.prune();
      const meta = this.meta();
      if (afterSeq < meta.replay_floor)
        throw new AppError("FULL_SYNC_REQUIRED", "Room delta expired.", 409);
      const target = meta.head_seq;
      if (afterSeq >= target) return null;
      const rows = this.storage.sql
        .exec<RoomRow>(
          "SELECT * FROM room_changes WHERE stream_seq>? AND stream_seq<=? ORDER BY stream_seq LIMIT ?",
          afterSeq,
          target,
          LIMITS.eventsPerBatch + 1,
        )
        .toArray();
      const hasMore = rows.length > LIMITS.eventsPerBatch;
      if (hasMore) rows.pop();
      const events = rows.map(
        (row) => JSON.parse(row.envelope_json) as EventEnvelope,
      );
      const batch: EventBatch = {
        v: 2,
        type: "events.batch",
        epoch: meta.epoch,
        batchId: crypto.randomUUID(),
        fromSeq: afterSeq + 1,
        toSeq: hasMore ? events.at(-1)!.streamSeq : target,
        events,
      };
      while (
        events.length &&
        utf8Size(JSON.stringify(batch)) > LIMITS.batchBytes
      ) {
        events.pop();
        batch.toSeq = events.at(-1)?.streamSeq ?? afterSeq;
      }
      if (batch.toSeq <= afterSeq)
        throw new AppError(
          "EVENT_CONFLICT",
          "Room update cannot fit in a batch.",
          409,
        );
      this.storage.sql.exec(
        "INSERT INTO inflight_batches(connection_id,batch_json) VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET batch_json=excluded.batch_json",
        connectionId,
        JSON.stringify(batch),
      );
      return batch;
    });
  }

  readBatch(connectionId: string): string {
    const row = this.storage.sql
      .exec<{
        batch_json: string;
      }>(
        "SELECT batch_json FROM inflight_batches WHERE connection_id=?",
        connectionId,
      )
      .toArray()[0];
    if (!row)
      throw new AppError(
        "FULL_SYNC_REQUIRED",
        "In-flight room batch is unavailable.",
        409,
      );
    return row.batch_json;
  }

  discardBatch(connectionId: string): void {
    this.storage.sql.exec(
      "DELETE FROM inflight_batches WHERE connection_id=?",
      connectionId,
    );
  }

  discardOrphanBatches(activeConnectionIds: string[]): void {
    const rows = this.storage.sql
      .exec<{
        connection_id: string;
      }>("SELECT connection_id FROM inflight_batches")
      .toArray();
    for (const row of rows)
      if (!activeConnectionIds.includes(row.connection_id))
        this.discardBatch(row.connection_id);
  }

  connect(deviceId: string, connectionId: string): void {
    this.storage.sql.exec(
      `INSERT INTO devices(device_id,latest_connection_id,last_connected_at_ms) VALUES(?,?,?)
       ON CONFLICT(device_id) DO UPDATE SET latest_connection_id=excluded.latest_connection_id,last_connected_at_ms=excluded.last_connected_at_ms`,
      deviceId,
      connectionId,
      Date.now(),
    );
  }

  ack(deviceId: string, sequence: number, connectionId: string): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE devices SET max_ack_seq=MAX(max_ack_seq,?),last_ack_at_ms=? WHERE device_id=?",
        sequence,
        Date.now(),
        deviceId,
      );
      this.discardBatch(connectionId);
    });
  }

  presenceSweepDeadline(
    now: number,
    hasConnections: boolean,
    meta = this.meta(),
  ): number | null {
    return this.storage.transactionSync(() => {
      const current = meta.presence_sweep_at_ms;
      if (!hasConnections) {
        if (current !== null)
          this.storage.sql.exec(
            "UPDATE sync_meta SET presence_sweep_at_ms=NULL WHERE id=1",
          );
        return null;
      }
      if (current !== null) return current;
      const deadline = now + LIMITS.sweepMs;
      this.storage.sql.exec(
        "UPDATE sync_meta SET presence_sweep_at_ms=? WHERE id=1",
        deadline,
      );
      return deadline;
    });
  }

  advancePresenceSweep(now: number): void {
    this.storage.sql.exec(
      "UPDATE sync_meta SET presence_sweep_at_ms=? WHERE id=1 AND presence_sweep_at_ms<=?",
      now + LIMITS.sweepMs,
      now,
    );
  }

  presence(count: number): { revision: number; changed: boolean } {
    return this.storage.transactionSync(() => {
      const meta = this.meta();
      const changed = count !== meta.presence_count;
      if (changed)
        this.storage.sql.exec(
          "UPDATE sync_meta SET presence_state=?,presence_count=?,presence_revision=presence_revision+1 WHERE id=1",
          count > 0 ? "online" : "offline",
          count,
        );
      return { revision: meta.presence_revision + (changed ? 1 : 0), changed };
    });
  }

  markPresenceAttempt(revision: number): void {
    this.storage.sql.exec(
      "UPDATE sync_meta SET last_presence_attempt_revision=MAX(last_presence_attempt_revision,?) WHERE id=1",
      revision,
    );
  }
}
