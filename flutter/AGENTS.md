# Agent instructions: Flutter

Read root [AGENTS.md](../AGENTS.md), canonical contracts, and the Cloudflare WebSocket protocol before implementing. Target Android and iOS with the requested Flutter 3.47+ baseline; record the SDK actually used.

Use Riverpod for lifecycle/presentation and SQLite as the canonical local room/message store. Widgets must not directly mutate the socket, write SQL, or maintain another authoritative message list. Create adapters for v_chat_bubbles and v_chat_input_ui; use only text features.

Persist outgoing message intent before clearing input. Persist compacted room-state batch application and its covered cursor interval atomically before ACK. Room rows can have sparse stream sequences; explicit batch coverage, epoch and room revisions determine correctness. Use HTTP latest-30 authoritative windows for message bodies, and keep cache gaps separate from verified history. Persist room paging continuation alongside the baseline. Serialize incoming batch processing even though Dart callbacks are asynchronous. A process restart must not lose pending sends or advance a cursor past missing data.

Keep account/device/session generations explicit. There is one active account and one socket in an app instance, but many devices can independently select the same user. Account switching is a cleanup operation, not a global sign-out of all that user's devices.

No background socket keepalive, push notifications, web target, media permissions, read receipts, typing, or full V Chat SDK integration. Do not turn transient peer-state uncertainty into an offline claim.
