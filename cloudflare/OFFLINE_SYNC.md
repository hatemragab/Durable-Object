# Offline room synchronization and recovery

## Projection, not event sourcing

MongoDB owns permanent messages, room membership and each user's room-list state. It stores no event journal. After a transaction commits, NestJS publishes the latest per-user room projection to Cloudflare. A durable source revision/publication marker on that current state allows retries after process failure; an in-memory retry alone cannot close the Mongo-to-Cloudflare crash window.

Cloudflare stores one latest room summary per user/room for 48 hours, with a DO-assigned cursor. Repeated messages update that row's last-message preview and unread count. Individual message-created/typing/presence events are not replayed. All room members, including the sender, receive the latest room state independently of presence.

SQLite supports ordinary transactional SQL updates. Cloudflare does not supply this compaction/resume/TTL protocol automatically; the application implements it. Updating stored state cannot retract a frame already delivered to a phone. [Cloudflare storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Delta cursor

The account's local SQLite database stores `(epoch,lastAppliedSeq,syncedAt)` with its room state. Device ACKs are independent. A batch explicitly covers a cursor range; its items may be sparse because earlier room updates were overwritten. Validate identity/epoch and ensure the batch does not start beyond local cursor+1. Apply current room summaries using their per-user `revision` and commit the coverage cursor atomically before ACK.

Never use timestamps or room UUIDs to order the synchronization stream. Timestamps are only retention/freshness and room-list sorting inputs. REST merges do not arbitrarily advance a socket cursor.

## Full snapshot

First use, an epoch change, a cursor below the retention floor, a baseline at least 48 hours old, a cursor ahead of the DO, or a delta distance above 1,000 changes requires a snapshot. The server sends `sync.required` and closes 4010. A client can recover from that close even if the frame was lost.

NestJS obtains a DO fence `(epoch,headSeq)` before reading the newest 20 room items from MongoDB. Its response contains both items and that baseline. The client atomically replaces the room-list baseline and then resumes after the fence. Changes occurring between the fence and Mongo query appear in the snapshot or a later delta, with source revisions suppressing stale duplicates. Capturing the fence after the query would risk skipping updates.

Only the newest 20 rooms are included initially. Older room-list pages are fetched separately over HTTP; do not treat omission from a partial page as removal of an arbitrary cached room. A full baseline reset must distinguish room-list reset from message-cache and pending-send deletion.

## Open-room messages

Show cached messages immediately, then HTTP-fetch the newest 30 on opening a room or reconnecting. A room summary change invalidates the open room's message window and triggers HTTP reconciliation. Older history loads through HTTP keyset pagination. Retained message rows are not copied into the Cloudflare delta stream.

A recent window needs explicit authoritative coverage before deleting local messages missing from it. A message outside the fetched page is not proof of deletion. Current scope implements sync and unread counts; pin/mute/delete/edit features remain future design examples.

## Failure behavior

- **Mongo commit before process crash:** the current room state's publication revision remains dirty. Restart/periodic relay publishes its latest state; it does not recreate every intermediate message event.
- **Cloudflare accept before lost integration response:** retry the same source room revision. The Worker returns duplicate success without a new cursor or retention extension.
- **New room update before ACK:** update the projection, but preserve the prior in-flight frame verbatim. After its ACK, the next batch carries the newer summary.
- **Client commit before lost ACK:** retransmit/ACK the same batch, or reconnect using its already committed cursor.
- **Device cache restored backward:** the lower client cursor wins if retained; otherwise request a snapshot.
- **Cloudflare epoch reset or old restore:** full synchronization rebuilds the room list from MongoDB. Backend repair must republish current state, not assume clean publication markers imply a present projection.

The design guarantees recovery of current room state, not preservation or exact replay of all intermediate transitions. Published source revision metadata is not a distributed Mongo/Cloudflare transaction; temporary stale projection state is repaired when the backend and relay recover.
