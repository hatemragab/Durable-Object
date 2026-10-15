# Shared defaults and errors

These are project defaults, not Cloudflare platform limits. Keep them consistent across all three implementations and test fixtures. Constants are not a reason to add a configuration option for every screen.

## Defaults

| Setting | Default |
|---|---|
| Protocol version | 2 |
| Backend address | Port 3000; bind loopback unless physical-phone/LAN testing is enabled |
| Event batch | At most 50 events **and** at most 65,536 serialized UTF-8 bytes for the entire frame |
| Single durable event | At most 32,768 serialized UTF-8 bytes |
| Incoming client control frame | At most 4,096 UTF-8 bytes; binary frames rejected |
| NestJS JSON request body | At most 32,768 serialized UTF-8 bytes for the complete body; independently enforce decoded message text at 2,000 Unicode scalar values and 8,192 UTF-8 bytes |
| Room history page | 30 messages; client limit allowed 1-100 |
| Demo users | Exactly 3 |
| Group size | 2-3 members including creator |
| Rooms per user | 100 per dataset |
| Retained room payloads | At most one per room; 48-hour TTL |
| Room snapshot page | 20 rooms, cursor pagination |
| Large delta | More than 1,000 cursor changes requires full sync |
| Pending outgoing messages | 1,000 per account/device; reject a new local send visibly when full |
| WebSocket handshake/resume timeout | 10 seconds |
| Application heartbeat | Exact text `ping`, every 20 seconds while foregrounded |
| Expected heartbeat reply | Exact text `pong`; timeout 10 seconds after each ping |
| Server liveness lease | 70 seconds from latest auto-pong timestamp, or valid resume time before the first ping |
| Presence snapshot refresh | Every 30 seconds on a connected foreground client, also immediately after watch registration |
| Presence UI freshness | Unknown when own connection is unavailable or no snapshot/update is fresh within 60 seconds |
| Presence sweep | Approximately every 30 seconds while any socket exists; central alarm also handles earlier ACK deadlines |
| Event ACK timeout | 15 seconds; at most 3 retransmissions before closing for resume/retry |
| Reconnect | Full-jitter exponential delay; base 1 second, cap 30 seconds |
| Backoff reset | After a valid resume and 30 seconds of stable connected operation |
| Current projection relay | 1 second, non-overlapping; no event journal |
| Projection retry | Exponential full jitter, base 1 second, cap 30 seconds |
| Current state recovery | Startup and periodic dirty membership scan |
| Worker append HTTP timeout | 10 seconds |
| Flutter REST timeout | 10 seconds connect, 15 seconds receive |
| Dev session validity | 24 hours |
| WebSocket upgrade ticket validity | 60 seconds; ticket is NOT advertised as single-use |
| Clock skew for ticket verification | At most 5 seconds |
| Retention | Permanent MongoDB messages; Cloudflare latest room payloads for 48 hours |

Only the selected foreground account drains its local outgoing queue, with one request in flight overall. One slow room therefore does not create uncontrolled parallel sends; see Flutter retry rules for permanent failures.

## REST error envelope

```json
{
  "error": {
    "code": "ROOM_FORBIDDEN",
    "message": "The selected account is not a member of this room.",
    "retryable": false
  },
  "requestId": "10000000-0000-4000-8000-000000000001"
}
```

| HTTP/code | Meaning and response |
|---|---|
| 400 `VALIDATION_ERROR` | Invalid body, text, IDs, or frame values; do not retry unchanged input |
| 413 `VALIDATION_ERROR` | NestJS JSON body exceeds 32,768 serialized UTF-8 bytes; reject before mutation. Escaped Unicode is allowed within that transport cap; decoded text still has its separate scalar/byte limits |
| 401 `SESSION_EXPIRED` / `UNAUTHORIZED` | Invalid/expired dev session; reselect/renew the same dev account when API is reachable |
| 403 `ROOM_FORBIDDEN` | Membership failure; fail that local send visibly, preserve it for inspection |
| 404 `ROOM_NOT_FOUND` | No such room in this dataset |
| 409 `IDEMPOTENCY_CONFLICT` | A reused client key has different content; never silently invent a new key |
| WebSocket `sync.required` | Expired/large/mismatched coverage requires HTTP room snapshot |
| 409 `EVENT_CONFLICT` | Same room revision with different content; report integrity failure |
| 409 `STATE_CONFLICT` | Authoritative room/member state is inconsistent; block publication and repair current state |
| 409 `DATASET_MISMATCH` | Components point to different datasets; do not wipe cache automatically |
| 429 `DEMO_LIMIT_REACHED` | Dataset safety cap; do not auto-upgrade, erase data, or retry forever |
| 429 `RATE_LIMITED` | Honor Retry-After when present, otherwise use bounded backoff |
| 503 `DEPENDENCY_UNAVAILABLE` | Mongo/Worker unavailable; retain queues and retry as appropriate |
| 503 `STREAM_NOT_READY` | Realtime dependency unavailable; retain local state and retry |

See [Room sync v2](ROOM_SYNC_V2.md) for normative coverage and retention.

## WebSocket closes

| Code | Meaning | Client action |
|---|---|---|
| 1000 | Intentional close/account switch/background | Reconnect only if the active foreground lifecycle still requests it |
| 1008 | Authentication/authorization or invalid identity | Obtain valid session/ticket; surface repeated failure |
| 1009 | Frame too large | Do not retry the same malformed frame |
| 1013 | Temporary service issue, slow/unacked stream, or repair pending | Backoff then resume with local committed cursor |
| 4010 | Full room snapshot required | Refresh HTTP snapshot and reconnect using its fence |
| 4001 | Application session expired | Renew dev session and reconnect with a new ticket |
| 4002 | Protocol violation/cursor or unsupported-version error | Show diagnostic; no hot reconnect loop |
| 4009 | Another socket replaced this same device ID | Stop automatic reconnect for this connection generation; require explicit retry |

Every asynchronous result belongs to the dataset/account/session generation captured when work began. A late result from a disposed generation must not mutate the next selected account.

Worker `SEQ_GAP` errors additionally include `error.details.expectedSeq`, a positive safe integer identifying the next required contiguous sequence. Other errors may omit `details`.
