# Agent instructions: Cloudflare component

Read root [AGENTS.md](../AGENTS.md), the canonical contracts, and every protocol/storage document here before implementing. This folder becomes the Worker project, not a second backend.

Use a single exported class `UserRealtime` and binding `USER_REALTIME`. Route by `(DATASET_ID, verified userId)`. Use private SQLite storage and the WebSocket Hibernation APIs. The class must survive constructor re-entry without forgetting device IDs, replay mode, in-flight batch boundaries, authorization expiry, or subscriptions.

Persist only the latest per-user room summary for 48 hours, with per-room source revision watermarks and explicit sparse batch coverage. Never persist message-created history or use a Mongo event journal. Do not send a live room update through a separate broadcast path: upsert it, then invoke the same per-socket batch pump used for replay. Freeze in-flight frame bytes separately until ACK/timeout so compaction cannot change retransmissions. Do not accept socket message-write commands: message creation belongs to NestJS REST. Do not add D1, Redis, room objects, or a singleton global presence object.

Authentication happens before a public request obtains access to a user object. SQL values are parameterized. Acknowledging an append is not acknowledging that any device received it. The Worker never sees Cloudflare management credentials.

Schema/configuration changes must preserve existing test data. Use current official class `exports` configuration for a fresh Worker when supported by the installed Wrangler. Do not mix declarative exports and legacy migrations for the same Worker. Platform and application SQL migrations are separate concepts. See [CONFIGURATION.md](CONFIGURATION.md).
