# WebSocket protocol v2: compacted room synchronization

This is the normative socket contract. All application frames except heartbeat are JSON text objects with integer `v: 2` and a `type`. Binary controls, Socket.IO, message writes and message history replay are unsupported. Protocol v1 clients must obtain an updated client and a new HTTP room snapshot.

## Identity and first connection

NestJS issues a short-lived upgrade ticket. `GET /v1/ws?ticket=...` verifies its signature, audience, dataset, user, device, session expiry and ticket expiry before routing to the user's object. Never log the query ticket. One current socket is allowed per `(datasetId,userId,deviceId)`.

The server sends:

```json
{
  "v": 2,
  "type": "hello",
  "datasetId": "90000000-0000-4000-8000-000000000001",
  "userId": "1",
  "deviceId": "10000000-0000-4000-8000-000000000001",
  "connectionId": "20000000-0000-4000-8000-000000000001",
  "epoch": "30000000-0000-4000-8000-000000000001",
  "headSeq": 120,
  "replayFloor": 40,
  "retainedFromSeq": 41,
  "eventCount": 12,
  "retentionMs": 172800000,
  "heartbeatIntervalMs": 20000,
  "heartbeatTimeoutMs": 10000,
  "sessionExpiresAt": "2026-10-16T00:00:00.000Z"
}
```

`eventCount` counts current retained room summaries, not messages. `retainedFromSeq` is the conservative replay boundary (`replayFloor+1`); it does not promise an event at every sequence. The epoch identifies this incarnation of the compacted projection. Never adopt a new epoch by silently replacing the local cursor.

## Resume and full synchronization

Within 10 seconds, a device with a valid local baseline sends:

```json
{"v":2,"type":"resume","epoch":"30000000-0000-4000-8000-000000000001","afterSeq":95,"syncedAt":"2026-10-15T00:00:00.000Z"}
```

`afterSeq` is the cursor committed in that account's SQLite database. `syncedAt` is the timestamp of its last successful baseline/delta synchronization; malformed or future timestamps beyond clock skew are rejected. A historical server device ACK never overrides a restored client's lower cursor.

The server returns `sync.required` and closes with **4010** when:

| Reason | Condition |
|---|---|
| `EPOCH_CHANGED` | Epoch differs from current storage |
| `CURSOR_EXPIRED` | Baseline is at least 48 hours old or cursor is below `replayFloor` |
| `CURSOR_AHEAD` | Cursor exceeds current DO head |
| `DELTA_TOO_LARGE` | Head minus cursor exceeds 1,000 changes |

```json
{"v":2,"type":"sync.required","reason":"CURSOR_EXPIRED","epoch":"30000000-0000-4000-8000-000000000001","headSeq":120,"replayFloor":40}
```

The frame includes the stream inspection fields too. Close code 4010 itself also means the client needs a room snapshot if the preceding frame was lost. On first use, expiry or reset, call authenticated NestJS `GET /api/v1/rooms` for the newest 20 room items and its sync baseline. The server obtains the DO epoch/head **before** reading MongoDB. Replace the local room-list baseline atomically, preserve message/pending-send storage, and reconnect using that returned baseline. Older rooms load through HTTP pagination.

A valid resume produces:

```json
{"v":2,"type":"sync.started","afterSeq":95,"targetSeq":120}
```

The target is an initial diagnostic boundary. Compaction can move an unseen room to a newer sequence during replay, so subsequent pages capture the current head and `sync.ready` waits until the device catches that head.

## Room batches and coverage

```json
{
  "v": 2,
  "type": "events.batch",
  "epoch": "30000000-0000-4000-8000-000000000001",
  "batchId": "40000000-0000-4000-8000-000000000001",
  "fromSeq": 96,
  "toSeq": 120,
  "events": []
}
```

Each nonempty item is an `EventEnvelope`: `{v:2,datasetId,userId,type:"room.upserted",streamSeq,data:{room}}`. The room is the recipient's complete current room-list item, including `revision`, `unreadCount`, `lastReadSeq`, and latest message preview. No `message.created`, message history body, typing event, presence event, event ID, or timestamp ordering is retained in this stream.

Only one latest room row is stored per user/room. For example, updates at sequences 96, 97 and 120 for the same room compact to one item at 120. **Sparse item sequences are expected and are not missing updates.** Every batch declares complete coverage `[fromSeq,toSeq]`, even when some earlier updates were superseded. Empty positive coverage is valid. Items are strictly ascending within that coverage, unique by room, and share the authenticated dataset/user. Maximum 50 items, 65,536 bytes per complete frame, and 32,768 bytes per envelope.

The client validates identity, epoch, bounds, order and size. If its cursor is below `fromSeq-1`, a previous batch is missing; do not apply or ACK. Otherwise upsert room items using per-user room `revision`, ignore older summaries, and advance the cursor to `max(localCursor,toSeq)` in the **same SQLite transaction**. A duplicate/overlapping batch is safe. ACK only after that transaction succeeds:

```json
{"v":2,"type":"ack","batchId":"40000000-0000-4000-8000-000000000001","throughSeq":120}
```

An ACK is valid only for the current batch's exact ID and `toSeq`; older duplicate ACKs are ignored. It means this device committed room state, not that a person read messages, any other device received it, or a message fetch completed. ACKs never delete retained room rows.

## Retransmission and ready

One batch per socket may be unacknowledged. Persist its exact serialized bytes in SQLite before sending. Updating a room or expiring its replay row cannot alter an in-flight frame. After 15 seconds, resend the exact frame; after three retransmissions without ACK, close 1013. Connection attachments store only batch references/bounds, not payloads. Re-entry after hibernation restores references and retransmits the saved frame. ACK/retire deletes that connection's in-flight copy.

Once caught up:

```json
{"v":2,"type":"sync.ready","epoch":"30000000-0000-4000-8000-000000000001","throughSeq":120,"syncedAt":"2026-10-15T00:00:00.000Z"}
```

The same pump delivers subsequent live room updates. When the currently open room's summary changes, fetch/reconcile its latest 30 messages over HTTP. Room-list synchronization never claims to replace message-history recovery.

## Presence and heartbeat

Presence remains ephemeral. Controls are `{v:2,type:"presence.watch",userIds:["1","3"]}` and `{v:2,type:"presence.refresh"}`. Replies are `presence.snapshot` with `items` or `presence.changed` with `item`. These never enter `room_changes` or advance the room cursor. See [PRESENCE_AND_HEARTBEAT.md](PRESENCE_AND_HEARTBEAT.md).

Send literal text `ping` every 20 seconds; the runtime responds with literal `pong`. This static auto-response can preserve hibernation. Backgrounding closes sockets best effort; no push/background keepalive is promised.

## Errors and close codes

Application errors use `{v:2,type:"error",code,message,retryable}`. Unknown fields, unsupported versions, binary controls and forbidden write commands fail validation. Maximum control size is 4,096 bytes.

| Code | Meaning |
|---|---|
| 1000 | Clean close |
| 1009 | Oversized control frame |
| 1013 | Transient failure or ACK retry exhaustion |
| 4001 | Session authorization expired |
| 4002 | Invalid control, missing resume, or incompatible attachment |
| 4009 | Same device replaced by another connection |
| 4010 | Full room snapshot required |
