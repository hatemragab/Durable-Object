# Connection lifecycle and outgoing retry

## Account selection to live state

1. Open the selected account's SQLite database, migrate safely, and render cache.
2. When the API is reachable, obtain/renew its dev session using the stable installation device ID.
3. Request a fresh short-lived WebSocket ticket. Never reuse an expired ticket across reconnect attempts.
4. Open the standard WebSocket and await transport readiness. Start a bounded hello/resume timeout.
5. Verify hello identity/dataset, read the database cursor, and send resume. Start the heartbeat after the validated hello; it must continue during replay, not wait for sync.ready.
6. Process batches serially, commit locally, and ACK after each commit. On sync.ready mark the captured replay boundary complete.
7. Register the presence watch set after resume is accepted, request the immediate snapshot, and run its refresh timer independently of replay. On sync.ready, continue the same event reduction path for live batches; the heartbeat is already running.

The transport package exposes socket stream/sink and connection readiness; application reconnect/replay behavior is implemented here rather than assumed to be automatic. ([PKG-WS](../SOURCES.md#pkg-ws))

## Reconnect policy

For temporary close/errors, heartbeat timeout, and network changes, use one reconnect coordinator with full-jitter exponential backoff. Cancel the previous generation before creating another. Reset the backoff only after a successful resume and stable connection, not merely after TCP establishment.

A network connectivity plugin may trigger a probe/retry but cannot prove NestJS or Cloudflare is reachable. Keep separate API and socket dependency states. Avoid multiple overlapping probes from connectivity, resume, and timer callbacks. ([PKG-CONNECTIVITY](../SOURCES.md#pkg-connectivity))

On 4009 replacement, stop the old generation's automatic reconnect to prevent two copied device IDs fighting forever. On 4002 protocol/configuration error, show a diagnostic instead of a rapid retry loop. On session expiry, renew the same selected dev account through NestJS, obtain a fresh ticket, and reconnect. Pending data stays in SQLite.

## Heartbeat

Send the exact string ping every 20 seconds and wait up to ten seconds for the exact pong string. Keep at most one outstanding heartbeat. A local generation change cancels its timeout. A missed pong causes a reconnect from the committed cursor; it never deletes messages or resets a cursor.

The periodic presence refresh is independent of heartbeat. A pong confirms this transport responded; it does not establish any peer's online state or mean a replay batch was applied.

## Background/foreground

Observe Flutter lifecycle through a supported lifecycle listener/observer. Hidden/paused/detached states stop reconnect attempts, close the socket best-effort, and pause outgoing dispatch. Resumed restarts session/ticket checks, reconnect, replay, and queue drain. Avoid treating every transient inactive state as a permanent offline transition. Flutter documents that lifecycle notifications can be skipped on abrupt process termination, so server leases remain necessary. ([FLUTTER-LIFECYCLE](../SOURCES.md#flutter-lifecycle))

There is no guaranteed message reception while iOS/Android suspends or kills the app. Messages remain in the durable log and arrive on the next successful foreground connection. Push notifications are explicitly out of scope.

## Outgoing queue algorithm

Only the active foreground account drains its persisted queue, with one HTTP send in flight overall. Choose the oldest eligible queued item by local_order. Use its original clientMessageId and exact text. Set sending persistently before the attempt. On success merge the canonical server message and remove the outgoing row transactionally.

On timeout, network error, retryable 5xx, or rate limiting, put it back into queued with retry metadata and jittered delay; preserve the original ID. A request may have committed despite a timeout. On authentication failure renew once through the normal coordinator, then retry without changing the ID. Do not perform an unbounded authentication retry loop.

On a permanent validation/membership/idempotency/demo-cap error, mark that item failed and show an explicit retry/diagnostic. Do not keep a permanently failed item blocking unrelated rooms. Within the same room preserve the relative order of retryable queued items; do not send a later queued item while an earlier retryable one is still waiting. A manual retry of a failed item keeps its client ID and content.

A WebSocket echo can confirm the message before its REST response arrives. Canonical merge handles both orders. Canceling an in-flight request on account switch does not prove the server did not commit it; later resume/ID retry resolves that ambiguity.

## Local cache loss

A clean account cache starts at afterSeq=0 and replays the retained log. Never initialize a new device cursor from the server's recorded max ACK for another device, or from a REST room list. If the local cursor exceeds the object's trailing log head, keep the cursor, show recovery pending, and let the backend reconcile its journal.
