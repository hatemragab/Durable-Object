# NestJS REST API v2

Base prefix `/api/v1` is retained while payload protocolVersion becomes 2. All domain success responses contain datasetId. Health/dev-users/dev-session are public development endpoints; room/message/read/ticket/presence/diagnostics routes require the selected user's bearer session. Credentials are never part of room data.

| Method/path | Input | Result |
|---|---|---|
| GET `/health` | None | Minimal service/readiness/protocolVersion |
| GET `/dev/users` | None | Three demo users and datasetId |
| POST `/dev/session` | userId, deviceId | Selected account/session and Worker origin |
| POST `/realtime/ticket` | Empty body | Short-lived WebSocket ticket |
| GET `/rooms` | optional limit (1–100, default20), cursor | rooms, nextCursor, sync:{epoch,throughSeq,syncedAt} |
| POST `/rooms/direct` | peerUserId | personalized room and created; 201 new/200 existing |
| POST `/rooms/group` | title, memberUserIds, clientRequestId | personalized room and created; 201 new/200 same retry |
| GET `/rooms/:roomId` | UUID | Personalized room; membership required |
| GET `/rooms/:roomId/messages` | optional beforeRoomSeq and limit (1–100, default30) | messages, hasMore, nextBeforeRoomSeq, window |
| POST `/rooms/:roomId/messages` | clientMessageId, text | message, personalized room, duplicate; 201/200 |
| POST `/rooms/:roomId/read` | throughRoomSeq (nonnegative safe integer) | personalized room; 200 |
| GET `/presence?userIds=1,2` | Distinct allowlisted users | Explicit online/offline/unknown observations |
| GET `/dev/diagnostics` | None | Own-user Worker epoch/head, pendingRoomCount and health |

## Personalized room state

RoomDto retains room metadata, global version, lastMessageSeq and lastMessage preview, and adds `revision`, `unreadCount`, `lastReadSeq`. revision is monotonic for this user's room item; a read changes that account's revision without moving the room's activity order or exposing a peer read receipt. Neither timestamps nor global room version can replace this personalized merge revision.

The room list starts from caller-scoped room_members, orders updatedAt descending then room ID ascending, and joins only the selected page to rooms. nextCursor is an opaque keyset cursor; submit it unchanged. Each response captures its Cloudflare epoch/head barrier **before** its consistent Mongo read. The client adopts the first-page barrier atomically with snapshot replacement, then resumes deltas after that barrier and merges duplicate room items by revision. Pagination remains live; room moves during paging are reconciled by deltas. A list page is not a complete account room snapshot.

## Mutation semantics

Direct creation uniquely resolves the unordered pair and rejects self-chat. Group creation adds the caller, validates distinct peers/title and uses a stable clientRequestId/fingerprint. Retries with different content return 409. Room creation commits all membership state and counts together.

Send derives sender/device from the session, validates membership even on retry, and commits the original immutable message with room and membership current state. The same clientMessageId/content returns the same message; changed content returns 409. 201 means the Mongo transaction committed; it does not require Cloudflare to be available. Recovery comes from durable dirty current state, not a Mongo event history.

Read advances only the caller's room cursor monotonically, rejecting a position above the committed room head. unreadCount counts later messages from other senders. The client should mark only a message head it has fetched/applied and shown. Repeating an older/equal cursor does not create a new revision. Other installations of the same account receive the changed room item; peers do not receive read receipts.

## Authoritative message window

Read room head and message page in one Mongo snapshot transaction. Return selected messages in ascending roomSeq order, querying newest-first with limit+1. beforeRoomSeq is strict; nextBeforeRoomSeq is the oldest returned sequence when another page exists, else null.

`window:{fromRoomSeq,throughRoomSeq}` defines the authoritative range covered by this page. throughRoomSeq is the captured room head for the latest page, or min(head,beforeRoomSeq−1) for an older page. fromRoomSeq is the oldest returned sequence when more history exists, otherwise 1. An empty room has `{fromRoomSeq:1,throughRoomSeq:0}`. Within a nonempty covered range Flutter can replace cached canonical messages and remove absent rows; it must preserve unsent/optimistic rows and cached history outside that range. This range is needed for future deletion reconciliation. Editing/deletion endpoints are not implemented in this scope.

HTTP history never advances the room-list delta cursor. A room-list update tells an open message screen to fetch its current HTTP window; full message events are not persisted or replayed through Cloudflare.

## Errors and security

Reject unknown body/query fields and invalid limits/identifiers. Preserve the canonical error envelope and appropriate HTTP statuses. A failed Worker presence observation becomes explicit unknown; it cannot authorize writes or suppress recipients. A missing Worker prevents creating a new snapshot barrier, while committed Mongo changes stay dirty until publishing succeeds. Integrity conflicts block the affected user's relay and require investigation. No public reset endpoint exists.
