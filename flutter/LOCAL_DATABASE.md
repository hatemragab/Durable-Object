# Flutter SQLite schema and transactions

## Database scopes

Use a tiny app-metadata SQLite database for schemaVersion, stable installation deviceId, and optional last selected account. Generate the device UUID once and preserve it across app restarts. No session/JWT signing secrets are stored here.

Use a separate account database file for each `(datasetId, userId)`, with sanitized identifiers in its name. The account database stores rooms/messages/cursor/outgoing work. This prevents a shared cursor or cache table from leaking account A's data into B. Foreign datasets must never share the same outgoing dispatcher.

sqflite provides SQLite transactions and Android/iOS database support. It does not automatically turn queries into reactive Riverpod streams; build small post-commit invalidation signals in the repository. ([PKG-SQLITE](../SOURCES.md#pkg-sqlite))

## Account database tables

| Table | Fields and constraints |
|---|---|
| `account_meta` | singleton schema_version, dataset_id, user_id, last_applied_seq default 0 |
| `users` | id TEXT PRIMARY KEY, name TEXT; the three known summaries |
| `rooms` | id TEXT PRIMARY KEY; type, title nullable, member_ids_json, created_by, created_at, updated_at, version, last_message_seq, last_message_json nullable |
| `messages` | local_key TEXT PRIMARY KEY; server_id TEXT nullable UNIQUE; room_id; sender_id; origin_device_id nullable until known; client_message_id; room_seq nullable; text; server_created_at nullable; local_created_at; local_order INTEGER; send_state |
| `outgoing_messages` | client_message_id TEXT PRIMARY KEY; room_id; text; local_order INTEGER UNIQUE; state, attempts, next_attempt_at nullable, last_error_code nullable |
| `applied_events` | stream_seq INTEGER PRIMARY KEY; event_id TEXT UNIQUE; compact event fingerprint for conflict diagnostics |

Add unique `(sender_id, client_message_id)` to messages, and a unique partial `(room_id, room_seq)` index for non-null confirmed sequences. Index `(room_id, room_seq)` for message queries. Outgoing states are queued, sending, failed; confirmed rows are removed from outgoing_messages after a canonical server message is merged.

For a locally composed message, local_key is `client:<clientMessageId>`. For an incoming message without an optimistic row, use `server:<serverId>`. Resolve existing rows by sender/client ID and server ID before insert. Reconciliation must not leave both key forms for the same server message.

## Room/message display state

Confirmed messages order by room_seq ascending. Unconfirmed local messages appear after confirmed content in local_order order with a pending/failed indication. Do not mix the two time domains into a timestamp sort. Once accepted, a message takes its canonical room_seq position.

Keep the authoritative room preview/version unchanged for a local pending send. The chat-list view model may overlay the latest pending preview separately. A failed or pending local bubble must not fabricate a server lastMessageSeq.

## Transaction A: compose

Validate the text/queue cap, generate a stable clientMessageId, allocate a monotonically increasing local_order, insert optimistic message and outgoing row together, then commit. Only after success clear the composer and publish repository invalidations. If storage fails, preserve the input and show the error.

## Transaction B: event batch

Validate the complete envelope/range before writes. For every not-yet-applied sequence in order, merge room snapshots by version and messages by canonical identity; remove matching outgoing rows when the server message is known; record applied_events. Advance account_meta.last_applied_seq to the highest contiguous applied sequence in the **same** transaction. Publish invalidations only after commit, then allow the connection manager to ACK.

A reducer error rolls back everything including cursor and outgoing reconciliation. A duplicate batch requires no visible changes. A gap or conflicting duplicate is an error, not a reason to set cursor to the largest received sequence.

## Transaction C: REST merge

Apply the same entity merge rules for room lists, history pages, and send responses. Reconcile optimistic/outgoing rows where appropriate. Do **not** change last_applied_seq or insert fake applied_events based on REST data.

## Restart and account switch

On opening an account database, migrate non-destructively and turn leftover sending rows back to queued. On account switch stop/cancel old dispatch and socket generations, allow any already-running DB transaction to finish safely, then close/release the old repository. Late network responses must be discarded or routed only to their captured original account, never to the newly selected account.

Keep inactive accounts' pending queues intact but paused. Clearing only a cursor while retaining arbitrarily inconsistent message data is not the normal reset path. A deliberate cache reset clears the selected account's cache/cursor together and must warn if pending messages would be lost; do not silently erase pending data.
