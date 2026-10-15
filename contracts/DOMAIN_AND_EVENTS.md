# Canonical domain and durable event contract

**Protocol version: 2.** This document is normative for NestJS, Cloudflare, and Flutter. JSON examples describe wire data, not implementation code.

## Identifiers and primitive values

| Field | Meaning |
|---|---|
| `datasetId` | UUID identifying one isolated demo dataset; fixed across NestJS and Worker |
| `userId` / user `id` | String enum: `1`, `2`, `3` |
| `deviceId` | UUID generated once per app installation; shared across that installation's account-specific databases |
| `connectionId` | UUID assigned by the server to one accepted socket; changes on reconnect |
| `clientMessageId` | UUID generated before an outgoing message is persisted; immutable across retries |
| `clientRequestId` | UUID for one group-creation intent; reused after an ambiguous timeout |
| `roomId`, message `id`, `epoch`, `batchId` | Server-generated UUIDs; never sorting keys |
| `roomSeq` | Positive, contiguous server message sequence within a room |
| `streamSeq` | Cloudflare-assigned delivery cursor; retained room items can be sparse |
| `afterSeq` | Nonnegative highest covered delivery cursor committed by that device |
| `version` | Positive room snapshot version; starts at 1 and increments for every committed room/message change |

Sequences are JSON integers, not strings or floating-point values. Validate safe integer range in TypeScript and nonnegativity in Dart. The demo cap is far below the JavaScript safe-integer limit. Use UTC ISO-8601 timestamps with `Z`; display in device local time. Never order messages by client wall time.

## DTO definitions

**UserSummary:** `id: userId`, `name: string`. Seed names exactly User 1, User 2, User 3.

**MessageDto:** `id`, `roomId`, `senderId`, `originDeviceId`, `clientMessageId`, `roomSeq`, `type: "text"`, `text`, `createdAt`.

**LastMessageDto:** `messageId`, `senderId`, `text`, `roomSeq`, `createdAt`. Text is the same committed text, truncated visually by the UI, not silently shortened in the API.

**RoomDto:** `id`, `type: "direct" | "group"`, `title: string | null`, sorted distinct `memberIds: userId[]`, `createdBy`, `createdAt`, `updatedAt`, `version`, `lastMessageSeq`, `lastMessage: LastMessageDto | null`, `revision`, `unreadCount`, `lastReadSeq`. `revision` is per-user room state and increments independently of the global room version. Unread counts exclude the current user's own messages. A direct room's title is null; clients derive its visible name from the other member. A group's title is required.

**PresenceDto:** `userId`, `state: "online" | "offline" | "unknown"`, `activeDeviceCount: integer | null`, `connectionCount: integer | null`, `revision: integer | null`, `observedAt: timestamp | null`. Unknown has null counts/revision/observedAt. Offline has zero counts. Online requires positive counts. Revision is per source user object, not a durable message sequence; compare it only within the current dataset and a live presence session.

## Current room update and delta envelope

The only retained v2 update is `room.upserted`. Internal publishing takes `{v:2,datasetId,userId,type:"room.upserted",data:{room:RoomDto}}`. Cloudflare adds `streamSeq` for delivery. There is no `eventId`, `occurredAt`, `data.message`, or `message.created` event. Last-message preview is current room state, not message history.

MongoDB never serializes or retains event payloads. Its atomic current membership revisions and publication markers let the relay reconstruct the latest projection after a crash. Cloudflare stores one latest payload per room for 48 hours; intermediate room states are intentionally discarded. See [Room sync v2](ROOM_SYNC_V2.md) for exact recovery, compaction, unread and snapshot rules, and [the socket protocol](../cloudflare/WEBSOCKET_PROTOCOL.md) for frame details.

## Canonical merge behavior

Room merges compare per-user `revision`, not only global `version`. Older revisions cannot roll back unread state or a preview; equal revisions must have equivalent bodies. Canonical messages still merge by server ID and `(senderId,clientMessageId)`. Only POST/history returns canonical message bodies and confirms outgoing intents.

Delta batches declare coverage `fromSeq..toSeq`. Sparse rows and empty advancing coverage are valid. A batch that begins beyond `committedCursor+1` is a real gap; duplicate/overlapping coverage can merge safely by room revision. Room application and cursor advancement commit in one SQLite transaction before ACK. REST room/message merges do not advance the replay cursor, except for the explicit fresh room snapshot baseline.

## Validation rules

Text must contain a non-whitespace character, be at most 2,000 Unicode scalar values, and encode to at most 8,192 decoded UTF-8 bytes. The explicit whitespace class is U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, and U+FEFF. All components use this same class rather than their language's built-in trim definition. Preserve submitted message content, including boundary whitespace, BOM, and newlines, after validation; do not normalize it. Empty/whitespace-only text, including U+0085-only text, is rejected before any durable event is created.

Group title is trimmed once by NestJS using the same explicit whitespace class, must then be nonblank, and is at most 80 Unicode scalar values after trimming. Internal whitespace is preserved. Room DTOs and durable room snapshots carry that normalized title; validators reject unnormalized snapshots instead of silently changing their immutable content. Reject unknown user IDs, duplicate submitted members, self direct rooms, non-member reads/writes, unknown event types, negative/unsafe sequences, and identity mismatches. Error definitions are in [DEFAULTS_AND_ERRORS.md](DEFAULTS_AND_ERRORS.md).

## Idempotency rules

A repeated `(senderId, clientMessageId)` with the same room and exact text returns the original committed message. Reuse with a different room/text is a conflict. Origin device does not change on retries. Group retries use `(createdBy, clientRequestId)` and the canonical title/sorted membership fingerprint. Direct rooms are unique by the unordered user pair and do not need a separate creation request ID.

Cloudflare upserts by room ID and per-user room revision. Equal-revision identical retry does not allocate a cursor or extend the 48-hour expiry. Lower revisions are ignored; conflicting equal-revision content is an integrity error. Cloudflare owns delivery cursors, so NestJS never allocates them or expects contiguous retained rows.
