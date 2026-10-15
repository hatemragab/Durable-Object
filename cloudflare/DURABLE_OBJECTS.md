# UserRealtime object behavior

## Identity and ownership

Each object is named deterministically from `DATASET_ID` and a validated seeded user ID. Its SQLite metadata stores the expected dataset/user identity; reject any mismatched request context. A user has one object regardless of the number of rooms or devices.

A Worker binding is used to reach the object. Native object methods or stub fetch can be used internally, but the externally reachable Worker routes remain those in [CONFIGURATION.md](CONFIGURATION.md). SQL access is confined to the object. ([CF-START](../SOURCES.md#cf-start))

## Initialization

Initialize/check the small versioned SQLite schema before handling requests. Rehydrate per-socket state from connection attachments, not by resetting all existing connections. Register the static application auto-response pair once in construction. Do not perform a network request or an expensive history scan in the constructor.

The Hibernation API retains attached connections while in-memory state can be discarded. Accept server sockets through the Durable Object state API, and handle socket messages/close/error through class handlers rather than the ordinary listener pattern. ([CF-WS](../SOURCES.md#cf-ws))

## Socket attachment contract

Persist a compact attachment with `attachmentVersion`, userId, deviceId, connectionId, datasetId, epoch, sessionExpiresAt, acceptedAt, resumedAt, mode, ackSeq, replayTargetSeq, in-flight batch metadata, presence watch IDs, and retired flag. Keep it comfortably below 2 KB and assert its serialized size. The batch metadata holds identifiers, sequence boundaries, sent time, and retry count, **not payloads or an unbounded event array**.

After constructor re-entry, the attachment plus saved SQL in-flight frame must be sufficient to reconstruct any retransmission. Serialize attachment changes before sending the corresponding frame. Never keep the only copy of mode or ACK state in a JavaScript Map.

## One connection per device

A validated new socket for an existing device replaces that device's prior socket only. Mark the old attachment retired before closing it with 4009, then make the new connection current. Persist the device's latest connection ID for diagnostics. A delayed close/error from the old connection must not clear the new connection's state.

Multiple distinct device IDs for the same user remain active together. All sender devices also receive their own user's latest room state. Device IDs are installation-scoped and are not accepted as authorization by themselves.

## Append and pump

Validate update identity, protocol version, source room revision and byte size. Upsert only a higher source revision, allocate its DO cursor, and update the source watermark atomically. Same-revision conflicts fail; stale/duplicate updates do not extend retention. Wait for durable storage before acceptance. A socket send failure does not undo an accepted room update. ([CF-STORAGE](../SOURCES.md#cf-storage))

Pump each socket independently with at most one unacknowledged batch. Freeze its exact JSON in SQL before transmission; room compaction must not change retries. Sparse room item sequences use explicit covered batch ranges. Capture the current head at every page so a room updated during replay is delivered before ready. Expired or excessive gaps request an HTTP snapshot with close 4010. See [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md).

## Presence-related internal methods

Implement a local authoritative presence evaluation and a binding-only incoming notification handler. A presence query must not recursively request other users' presence. Only the own-user snapshot aggregator calls the other objects, and each target simply evaluates its own sockets. A forwarded change never triggers another forwarded change. This avoids object-to-object request cycles.

## Single alarm scheduler

One object has one current alarm, so manage all deadlines centrally: incomplete resume, session expiry, ACK retries, room payload expiry, and presence sweeps/notification work. Select the earliest required deadline. Do not let scheduling a later sweep overwrite an earlier ACK deadline. Recompute from current attachments and persisted metadata whenever the alarm fires.

Alarm execution can retry, so handlers are idempotent. Avoid setInterval and permanent unresolved promises in object handlers. Cancel scheduling only when no connection, retained room expiry, deadline or presence work remains. Retention alarms continue without connected phones; read-side checks also prune due rows. Periodic active-session sweeps still wake the object; this design is not a zero-cost idle claim. ([CF-ALARM](../SOURCES.md#cf-alarm))
