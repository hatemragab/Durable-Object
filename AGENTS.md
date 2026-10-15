# Agent instructions: repository root

## Mission and authority

Implement the approved proof of concept described in this documentation. The repository contains the original specifications and their evolving implementation. Use `IMPLEMENTATION_STATUS.md` for actual verification evidence and remaining gates; documents or source alone do not demonstrate a working deployment.

Use [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) as the execution order. Component instructions supplement, not replace, this file. User requirements take precedence over conveniences of a package or framework. Canonical contracts under `contracts/` and `cloudflare/WEBSOCKET_PROTOCOL.md` take precedence over abbreviated examples elsewhere. If an implementation change genuinely requires a protocol change, update the canonical document, all affected consumers, and contract tests together.

## Non-negotiable invariants

- MongoDB owns permanent messages and room membership. Cloudflare does not authorize room writes or invent message history.
- A message transaction commits its message, room summary and per-user room_members projections/unread state together. Network publishing happens only afterward; dirty current state recovers handoff failures without an event journal.
- One Durable Object per `(datasetId, userId)`, not per device or room. One active WebSocket per `(userId, deviceId)`.
- Every member, including the sender, receives the latest room state. Never use presence to decide whether authoritative state should be updated.
- Cloudflare assigns a monotonic delivery cursor per user; compacted room-state items are sparse with explicit coverage ranges. Message order is roomSeq per room. Use contracts/ROOM_SYNC_V2.md for recovery.
- A client ACK means an event batch was committed into that device's SQLite database. It does not mean human-read, notification-delivered, or delivered to every device.
- No device ACK removes replay data. Cloudflare room payloads expire after 48 hours; stale/large gaps require an HTTP snapshot. MongoDB must not store event history or recreate event_outbox.
- Cache, cursor, outgoing queue, and async work must be isolated by dataset and account.
- No Socket.IO, Redis, Centrifugo, D1, Firebase, push notifications, or full V Chat backend SDK is needed.
- Keep the UI minimal. Do not add attachments, audio, typing, calls, reactions, message editing, read receipts, membership management, or production authentication.

## Work discipline

Inspect actual toolchain versions first. Pin compatible resolved dependencies and retain application lockfiles when implementing. Do not invent package APIs from memory. Use the linked official sources and small compilation tests, especially for the two requested UI packages and Wrangler class declarations. An unavailable Flutter 3.47+ SDK is a toolchain blocker to report, not permission to claim it was tested on that SDK.

Create tests alongside each milestone. Maintain an implementation progress document with task IDs, changed files, commands actually run, results, and remaining blockers. Do not mark unchecked tasks complete based only on code review. Work through unblocked tasks autonomously; missing credentials may block the real-cloud smoke test but not local implementation or unit tests.

## Safety and scope

Only the designated test Worker and new local demo database are authorized targets. Never modify unrelated repositories, existing Workers, domains, production databases, or account billing. Refuse to boot the demo account-selection API in production mode. Never expose Cloudflare management credentials to Flutter or deploy them into the Worker runtime.

Read `nestjs/.env` programmatically without printing values. Preserve user-entered values, ignore secret files in Git, and redact tickets and authorization headers. Do not run arbitrary shell text sourced from `.env`. A deployment helper must use a parsed allowlist of values, not export every variable indiscriminately.

A reset that deletes data requires an explicit operator reset action. Routine setup, seeding, tests, and redeploys must be non-destructive. Test fixtures should use isolated dataset IDs instead of erasing another dataset.

## Completion

Deliver runnable projects, documented commands, tests, actual development Worker details when deployed, and an honest verification report. Distinguish local unit/integration results, real Cloudflare results, and real mobile-device results. Keep implementation and verification claims current as work progresses.
