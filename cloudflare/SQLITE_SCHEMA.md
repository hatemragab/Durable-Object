# SQLite room projection schema

The object stores compacted per-user room state for 48 hours, not an append-only message journal. All SQL values are parameterized. `transactionSync` protects sequence allocation, source revision checks, projection updates, floors, and in-flight frame creation. Durable acceptance waits for storage confirmation. [Cloudflare SQLite documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Application schema version 4

`sync_meta` has one row:

| Column | Meaning |
|---|---|
| schema_version | 4 |
| dataset_id, user_id | Immutable routed identity once initialized |
| epoch | Random UUID created with this projection |
| head_seq | Monotonic DO-assigned latest accepted change cursor |
| replay_floor | Highest sequence of an expired/deleted replay row |
| retained_count | Number of current room_changes rows, maintained in the same transactions as payload insertion/expiry |
| presence_state, presence_revision, presence_count | Aggregated ephemeral presence diagnostics |
| last_presence_attempt_revision | Last attempted peer notification |
| presence_sweep_at_ms | Persisted non-postponable lease sweep deadline |

The v1 protocol used application schema versions 1/2 and an `events` journal. First v2 initialization creates a fresh epoch and removes the legacy `events` and `schema_meta` tables. It resets obsolete device ACK diagnostics. This migration is the explicit new retention/history behavior; an ordinary restart never recreates the epoch or resets current state. Existing message history remains authoritative in MongoDB. Old socket attachments close safely and old client cursors require full synchronization.

Schema3 upgrades atomically by adding `retained_count` and counting existing payloads once. The upgrade preserves the epoch, identity, cursors, source watermarks, payload deadlines, device ACKs and in-flight bytes. Routine stream inspection reads the counter instead of scanning payload rows. Compaction leaves it unchanged; inserting a new or expired room payload increments it; expiry decrements it by the number of removed payloads. Failed transactions roll back both the counter and payload/floor changes.

## room_changes

| Column | Constraint/meaning |
|---|---|
| room_id | Primary key; at most one current payload per room |
| stream_seq | Unique positive DO-assigned cursor |
| envelope_json | Current `room.upserted` envelope, including preview/unread state |
| expires_at_ms | Acceptance time plus 172,800,000 ms |

A higher Mongo per-user room `revision` replaces this row and allocates the next cursor. The payload holds a room-list item, not an individual historical message event. A `stream_seq` index supports ordered delta pages; an expiry index supports cleanup.

## room_versions

| Column | Meaning |
|---|---|
| room_id | Primary key |
| revision | Highest source room revision accepted |
| envelope_hash | SHA-256 of validated update JSON |
| accepted_seq | Cursor allocated for that revision |

These small watermarks survive payload expiration. They prevent a delayed retry from resurrecting a stale room after its 48-hour replay row expired. Same revision and hash is duplicate success; an older revision is superseded success; same revision with conflicting content is rejected. Duplicate/stale retries allocate no cursor and do not extend retention. The demo caps source room identities at 100 per user. No historical payloads are retained here.

## inflight_batches and devices

`inflight_batches(connection_id PRIMARY KEY,batch_json)` freezes exactly one frame per active socket before transmission. It is bounded by the per-user connection cap and complete batch byte limit. ACK/retire removes it; initialization removes orphaned frames. Compaction cannot change retransmitted bytes. This short-lived transmission copy can outlive a replay row until ACK/timeout; it is not an offline event archive.

`devices` retains current connection ID and historical max ACK/time diagnostics. It never controls another installation's resume cursor, message-read state, or replay retention. ACK mutation and in-flight deletion share a transaction.

## Expiry and floors

Before append, inspect, resume and batch selection, delete `room_changes` whose deadline is at or before now. In the same transaction raise `replay_floor` to the maximum deleted sequence. Resume below that floor requires a full snapshot. A conservative floor may require rebuilding more rooms than strictly necessary; it never silently skips an unavailable update.

Each access first checks `MIN(expires_at_ms)` through the expiry index. When nothing is due, no room scan/deletion occurs. Due cleanup explicitly uses `room_changes_expiry` to compute the expired count and maximum sequence; SQLite must not choose the sequence index and scan every unexpired room. A presence-only alarm does not pump caught-up room streams. Append, resume and ACK still pump immediately, and expiry alarms recheck socket coverage after pruning.

The central alarm includes the earliest payload expiry even with no sockets. Alarms may run late, so read-side expiry checks enforce the logical 48-hour boundary. Preserve room source-version watermarks, user identity, epoch and head across cleanup.
