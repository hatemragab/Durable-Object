# Riverpod state management

Use manually declared Riverpod providers and Notifier/AsyncNotifier controllers. Code generation is optional in Riverpod and not needed for this project. Verify the APIs against the pinned version. ([PKG-RIVERPOD](../SOURCES.md#pkg-riverpod))

## State ownership

| Provider/controller | Scope | Owns |
|---|---|---|
| AppConfigProvider | App | API base URL, expected dataset, protocol version; public values only |
| InstallationProvider | App | Persisted device ID |
| AccountController | App | Selected user, in-memory session, monotonically changing generation |
| AccountDatabaseProvider | Dataset/account | SQLite connection and migration lifecycle |
| ChatRepositoryProvider | Dataset/account | Entity queries/reduction and post-commit notifications |
| RealtimeController | Active account | Connection state, reconnect attempt, last known head and error |
| OutgoingController | Active account | Queue dispatcher lifecycle, pending count, API reachability |
| RoomsProvider | Account | Stream/query of cached rooms and pending-preview overlay |
| MessagesProvider(roomId) | Account/room | Cached chronological message page/window |
| RoomCreationController | Account | Request-in-progress and retained idempotency ID for group creation |
| PresenceController | Active connection/account | Ephemeral user presence and freshness deadlines |
| DiagnosticsProvider | Active account | Read-only combined debugging view |

SQLite is the source of truth for rooms/messages and pending sends. Riverpod caches observable views of it, not an independently mutable message array. Notify affected room/message queries once after a successful transaction rather than one UI update per event field.

## Connection states

Use explicit states: idle, obtainingSession, obtainingTicket, connecting, awaitingHello, resuming, replaying, live, retryWaiting, backgroundPaused, blocked. Retain a structured reason for blocked/retry states. A healthy REST API and an unhealthy WebSocket are different facts; don't compress them into a single global online boolean.

The list can render cached messages during replay. Mark it synchronizing until sync.ready for that connection generation. A later live batch does not require a full-screen loading state. Connection failure changes a banner/status, not whether cached rows exist.

## Serialized event processing

Process incoming durable batches in a single asynchronous queue. A naive async callback attached to stream.listen can allow multiple reductions to overlap; explicitly serialize the work. Route pong and ephemeral presence frames without advancing the durable cursor. Never ACK a batch merely because it was enqueued for processing.

Every handler captures the active account generation and connectionId. Before applying a network result or scheduling a retry, verify that scope is still active. The serial reducer must use the captured account repository, not whichever provider happens to be current later.

## Sending and optimistic state

The compose action delegates to the repository's transaction. The outgoing dispatcher is activated by queue changes, a successful API probe/session, foreground resume, or retry time. A WebSocket failure alone must not stop REST sends. A confirmed REST response or a message.created echo can reconcile the same pending entry; both paths are idempotent.

UI rendering state uses queued/sending/sent/failed. Sent means accepted into the backend's permanent message database. It is not delivered-to-peer or read. A transport ACK is not shown as a human receipt.

## Presence and groups

Direct room presence is derived from the other member's user ID. Group status counts distinct other members whose fresh state is online. Display uncertainty if any required member is unknown; do not replace unknown with zero. Rebuild the watch set when cached room membership changes, although the three-user allowlist permits simply watching the other two accounts in this demo.

## Cleanup

Providers/controllers close stream subscriptions, reconnect and ping timers, pending dio requests, and queue loops exactly once on disposal. Auto-disposing a message page must not dispose the app-level account socket. Navigating between chat list and a room keeps the same connection.
