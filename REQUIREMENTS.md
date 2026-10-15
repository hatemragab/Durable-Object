# Product requirements

> Protocol v2 supersedes the original immutable-event/outbox/no-retention requirements below. Current approved sync/unread scope and guarantees are in [Room sync v2](contracts/ROOM_SYNC_V2.md). Original milestone/native results are historical, not evidence for v2.

## Required flows

**R01 Account selection.** On each cold launch show exactly User 1, User 2, and User 3. Selecting an account opens that account's cached chat list immediately, then establishes a development session and connects when NestJS is reachable. A fresh install offline can display the three known test choices but must not claim to have authenticated or loaded remote data. Previously used accounts can open their cached rooms offline.

**R02 Direct room creation.** Choose one other user. The backend returns the existing direct room for that unordered pair or creates it exactly once. Self-chat and a third direct-room member are invalid.

**R03 Group creation.** Enter a nonblank title and select one or both other users. The creator is included automatically. Groups have two or three distinct members. Multiple groups with identical memberships are allowed. A retry of the same group-creation request must not create a second group.

**R04 Chat list.** Show room name, last text preview, timestamp, and connection/presence indication. A direct room displays the peer's status. A group displays known online **other members**, counting users rather than sockets; the viewer is excluded. Unknown status must not be displayed as offline.

**R05 Message screen.** A chronological, paginated message list; own messages on the right, others on the left; sender name in groups; timestamp and outgoing local status; text input using the required composer package. Render text with the required bubble package.

**R06 Offline outgoing messages.** In an already cached room, composing while offline adds a local pending bubble and durable outgoing queue record before clearing the composer. A restart must preserve both. Retry with the original client message ID.

**R07 Multi-device incoming messages.** Each device of the selected user receives events independently, including echoes of messages sent from that user's other devices. Disconnecting one device must not disconnect another.

**R08 Replay.** On reconnect or process restart, request events after the highest contiguous sequence committed on that device. Apply and acknowledge in order. A local cache reset replays from zero within the retained demo dataset.

**R09 Heartbeat and reconnect.** Detect stalled connections, reconnect with jittered backoff, request a fresh short-lived ticket, and resume. Dispose all timers/listeners on account change or deliberate shutdown. Preserve pending sends during API failures.

**R10 Presence.** A user is online when at least one authenticated, resumed device session satisfies the server's liveness lease. Smoothly recover presence after reconnect. The backend can query one or all three users through its Worker integration. Presence is approximate, not instantaneous proof that a human is viewing the screen.

**R11 Diagnostics.** A small development details sheet shows account/device, API reachability, socket state, local applied sequence, server head when known, and pending outgoing count. A developer can distinguish backend-offline from realtime-offline.

## Deliberate simplifications

Room membership and title do not change after creation. No deletion, leave, invitations, unread badges, search, delivery/read receipts, media, typing events, push notifications, or background-service keepalive. Creating rooms requires the local API to be reachable; offline room creation is excluded. Sending text to existing cached rooms works offline.

No event TTL or cursor-based garbage collection. The complete per-user event stream is retained for the bounded test dataset. There is no production-scale historical snapshot protocol. Limits and manual dataset reset are explicit instead of silently discarding events.

## Meaning of local development

The backend, its single-node MongoDB replica set, and Flutter development builds run locally. The approved real Cloudflare Worker is the only deployed component. The Worker makes no callback to the developer's machine; no public tunnel to NestJS is needed.

With NestJS stopped, an already authenticated WebSocket can still replay events stored in Cloudflare until session expiry. New rooms/messages cannot be committed, and a new ticket cannot be issued. Flutter remains usable from cache and queues sends.

## Success demonstration

Use device A as User 1, device B as User 2, and device C also as User 2. Create a direct room and a group including User 3. Exchange messages, disconnect C, send more, reconnect C, and compare message IDs and cursors. Then disconnect B while C stays connected and verify User 2 remains online. Finally disconnect both and verify bounded offline detection.
