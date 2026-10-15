# Room state sync v2

Approved scope: 15 October 2026. This revision supersedes the immutable-event/outbox/no-retention design in the original POC plans. MongoDB stores permanent messages, rooms and **current** per-user `room_members` state, never an event journal. No Redis, D1 or Socket.IO is involved.

## What is synchronized

Each membership holds its personalized `revision`, `unreadCount`, `lastReadSeq`, activity timestamp and publication bookkeeping. The current API/relay starts with memberships and joins the global room in the same MongoDB snapshot to assemble the room item; it does not duplicate the full preview/title into MongoDB memberships. Future per-user deletion will require a personal preview/visibility projection. New messages update the message, global room and every member's projection in one majority-committed MongoDB transaction. Read-cursor changes update only that user's projection. Activity ordering does not change when reading a room.

A single current room projection is not an event log: publishing ten successive messages while Cloudflare is unavailable leaves one dirty row, containing the latest preview/count. There is no list of ten pending events. A serialized relay scans dirty rows after startup and while running, publishes the latest state and acknowledges only the revision actually accepted. A newer concurrent revision remains dirty. A crash between commit and publication, or a lost Cloudflare response, is recoverable without reproducing the historical updates.

Cloudflare assigns its own increasing `streamSeq` to accepted higher room revisions. It keeps one latest room payload per `(datasetId,userId,roomId)`, overwriting the previous payload; only the most recent preview is present, not each message body. Same-revision identical retries are idempotent, older source revisions cannot roll state backward, and conflicting content for the same revision is rejected. Minimal version/hash metadata may remain after payload expiry to prevent a delayed retry resurrecting stale state.

MongoDB's message `roomSeq`, the member's `revision`, and Cloudflare's delivery `streamSeq` are separate counters. Timestamps do not establish correctness.

## Delta coverage and recovery

Every v2 batch carries an epoch, a batch ID, inclusive coverage `fromSeq..toSeq`, and zero or more latest room snapshots. Room item sequences are ordered but can be sparse. For example, five updates to one room can become one item at sequence 5 covering 1..5. This is expected compaction, not a missing message.

The sync timestamp comes from the server snapshot or sync.ready frame. The client must not replace it with phone wall time during batch commits; a skewed phone clock must not poison future resumes.

The client accepts new coverage only when `fromSeq <= committedCursor + 1`. It applies newer per-user room revisions and advances the cursor in the same SQLite transaction, then ACKs. An already committed batch can be ACKed again; an unbridged range must recover without advancing past unknown coverage. The server freezes the exact serialized in-flight batch independently of mutable room projections, including across hibernation, until ACK/close/timeout. A later room change cannot rewrite bytes already emitted to a phone.

Each higher revision's payload expires **48 hours after acceptance**. Retrying an identical revision does not extend its lifetime. Pruning advances a replay floor atomically, and is enforced during access as well as through a scheduled alarm. Expired payloads are not returned while waiting for an alarm. ACKs never remove another device's replay data. A bounded in-flight frame can outlive its underlying row briefly while waiting for ACK; it is transport state, not another retained history.

A first-use client, unknown/changed epoch, cursor below the replay floor, cursor ahead of the server, a sync age of 48 hours or more, or a delta distance above the configured 1,000-change threshold requires a fresh snapshot. The server emits `sync.required` and closes with 4010; the client obtains a new HTTP room snapshot and reconnects. An epoch separates a replacement/reinitialized log from an old cursor.

A valid delta does not query MongoDB on the reconnecting client's behalf. NestJS's current-state publication relay still reads MongoDB and catches up after backend outages. If NestJS is stopped, Cloudflare can replay only updates already published there; it cannot discover new MongoDB changes by itself.

## Room snapshot and pagination

`GET /api/v1/rooms?limit=20&cursor=...` starts from the authenticated user's memberships, ordered by `updatedAt DESC, id ASC`. It returns `datasetId`, `rooms`, `nextCursor`, and `sync: {epoch,throughSeq,syncedAt}`. The default first page has the 20 most recently active rooms; it is not the entire inbox when more rooms exist.

For a new snapshot the API obtains the Cloudflare epoch/head **before** reading MongoDB in a snapshot transaction. The client atomically replaces its loaded room-list generation and adopts that earlier fence. Changes occurring during the HTTP request are either present in the snapshot or published beyond the fence and replayed afterward. Per-member revisions prevent duplicate/stale snapshots rolling state backward. Capturing the fence after MongoDB would risk skipping a racing change.

Older room pages use an opaque keyset cursor bound to dataset/account, with ID tie-breaking. The client merges them by revision and does not replace its live sync cursor with a later page's fence. Rooms moving during paging are caught through the delta path. An initial top-20 snapshot requires a reachable API and Cloudflare fence; it cannot be completed while those dependencies are unavailable. Cached data can still be displayed.

## Messages and unread state

`GET /api/v1/rooms/:roomId/messages` defaults to the latest 30 messages, chronologically ordered. Older pages use the existing exclusive `beforeRoomSeq` cursor. Each result supplies `window: {fromRoomSeq,throughRoomSeq}` from the same MongoDB snapshot as the rows. Reconciliation removes absent canonical local messages **only inside that interval**, then upserts returned rows. Pending sends, older cached history and rows newer than the captured upper boundary survive. A latest-30 fetch says nothing about deletions outside its interval; revisiting older pages needs HTTP reconciliation too.

Flutter refreshes the active room on open, foreground/reconnect and a room-state change. Requests are serialized with a follow-up refresh when state changes during an in-flight fetch. Closed rooms do not fetch message bodies. Outgoing intents remain durable on the device; POST/history responses confirm canonical messages. A room preview cannot confirm every pending message.

`POST /api/v1/rooms/:roomId/read` takes `{throughRoomSeq}`. It advances the account's read cursor monotonically, validates membership and the room head, and recomputes unread messages from other senders after that cursor. A delayed read request must not clear newer unseen messages. The UI marks only displayed canonical messages after local application; transport ACK is unrelated to unread/read state. This is account-wide unread synchronization, not a peer read receipt.

## Migration and future features

Existing messages and rooms remain intact. Since v1 had no read history, migrated memberships start with existing history read (`lastReadSeq = lastMessageSeq`, unread zero). The explicit operator migration drops only the designated demo database's old `event_outbox` after membership backfill. Normal startup never drops it or other data. Worker v2 migrates its own obsolete event payload table and forces old sockets/clients to obtain a v2 snapshot. Local SQLite clears old immutable-event diagnostics/cursors while preserving message cache and pending intents.

Pin/mute, per-user message/chat deletion, edits, typing and peer read receipts are **not implemented in this change**. Future per-user changes belong in `room_members` and increment its revision; removal needs a room tombstone within the replay window and snapshot fallback afterward. Future message deletion/editing must reconcile all viewed history ranges, not assume absence from the latest 30 proves an old message was deleted. Typing, if added, is ephemeral and must not be persisted in this room replay cache.

## Sources and design choices

Telegram's official [Working with Updates](https://core.telegram.org/api/updates) describes `pts`, `pts_count`, gap detection and difference fetching; [updates.getDifference](https://core.telegram.org/method/updates.getDifference) describes bounded differences and `differenceTooLong`. We adopt counter-based recovery and snapshot fallback, not MTProto, Telegram's full message-event model or its retention limits. Coalesced room-state coverage is this project's contract.

Cloudflare's [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) supports SQL updates, synchronous transactions, disk synchronization and alarms. [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) requires durable connection state across constructor re-entry. A WebSocket frame already emitted is immutable from the receiver's perspective; updating SQL affects future deliveries only.

API preflight read from the current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/) on 15 October 2026: API first/OpenAPI (100/101), secure endpoints (104), standard methods/statuses and documented responses (148/243/151), pagination/cursors (159/160), and compatibility (106). Existing camelCase wire names, the development account selector, error envelope and base path remain explicit project conventions; this revision is coordinated protocol v2, not a claim of complete Zalando compliance. REST-specific method/status rules do not apply to WebSocket frames.
