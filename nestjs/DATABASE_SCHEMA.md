# MongoDB data model and indexes

Schema version 2 stores permanent domain data and **current state only**. Every record is dataset-scoped. Routine startup validates ownership and schema before collection/index changes; it never resets counters or drops data.

## users

Exactly string IDs `1`, `2`, `3`, with datasetId, name, roomCount and createdAt. Room creation increments each member's count in its transaction and enforces the existing demo cap. There is no event sequence allocation in MongoDB.

## rooms

UUID `_id`, datasetId, type, title, sorted memberIds, createdBy, createdAt, updatedAt, version, lastMessageSeq and lastMessage. Direct rooms have a unique partial `(datasetId,directKey)` index; groups have unique `(datasetId,createdBy,clientRequestId)` and a creation fingerprint. Global version/message sequence change on sends. User read changes do not change global activity ordering.

## room_members

One current record per `(datasetId,userId,roomId)`, with a unique compound index. All user room-list queries start here; only the selected page joins the global room records inside the same Mongo snapshot transaction.

| Field | Meaning |
|---|---|
| revision | Monotonic per-user, per-room state revision; changes for messages and this account's read changes |
| unreadCount | Messages from other senders after lastReadSeq |
| lastReadSeq | Monotonic account-wide read position in roomSeq order |
| updatedAt | Room activity ordering; read actions do not move the room |
| dirty | Current state needs publishing; survives process crashes |
| publishedRevision | Last confirmed published current revision |
| publishedEpoch | Durable Object generation that accepted it |
| publishedSeq | Delivery cursor of the last confirmed publication |

Publication markers are bounded metadata on current membership state. They contain no event payloads, per-message entries or historical revisions. Indexes `(datasetId,userId,updatedAt DESC,roomId ASC)` and `(datasetId,userId,dirty,roomId)` support list paging and relay scans.

## messages

Immutable UUID identity, datasetId, roomId, senderId, originDeviceId, clientMessageId, roomSeq, type=text, text, createdAt and requestFingerprint. Unique `(datasetId,senderId,clientMessageId)` guarantees send idempotency; unique `(datasetId,roomId,roomSeq)` guarantees room ordering. Cloudflare does not own message history. Message editing/deletion and per-user deletion remain future features.

## Transactions

A new room commits the room, membership state and per-user room counts together. A send validates membership/idempotency, increments room sequence/version, inserts its message, updates the preview and each member's revision/dirty state; unread increases only for other senders. A duplicate send returns the original message without another increment.

A read transaction checks membership and room head, advances lastReadSeq monotonically, counts later other-sender messages, and increments only that user's membership revision. Concurrent reads/sends contend on the same membership document so transaction retries preserve exact unread state. All operations use the same session, snapshot read concern and majority write concern; no network requests or Promise.all occur inside a transaction.

## Explicit schema-1 migration

Stop the old backend, build, then run `npm run db:migrate:room-sync -- --drop-event-outbox`. It verifies dataset ownership, backfills missing memberships and starts old message history as read at cutover. It preserves room/message bodies, removes obsolete user event counters, advances metadata to schema 2 and explicitly drops `event_outbox`. It is idempotent and never resets an existing membership's unread/publication state. New application startup refuses schema 1, so routine seeding cannot silently perform the destructive step.
