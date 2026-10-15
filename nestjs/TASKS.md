# NestJS implementation tasks

The current implementation replaces the original immutable-outbox plan with the user's approved compact room-list sync design. Actual command evidence is maintained in the root IMPLEMENTATION_STATUS.md.

| Task | Current responsibility |
|---|---|
| N01 | Local owned schema-2 Mongo replica-set database and idempotent three-user seed |
| N02 | Development sessions, strict validation, authorization and production refusal |
| N03 | Direct/group identity, membership state, latest20 cursor-paged room snapshots |
| N04 | Atomic messages/room/member updates; exact unread counts and monotonic read cursor |
| N05 | Postcommit compact current-state relay with conditional publication marks |
| N06 | Restart, lost-response and Durable Object epoch recovery without Mongo events |
| N07 | Short-lived tickets, presence uncertainty and own-user diagnostics |
| N08 | Latest30 authoritative history windows and explicit non-resetting migration |

Backend integration tests exercise real transactions and a fake Worker transport. Cloudflare deployment and native device tests are separate gates; previous protocol-1 runtime results do not verify this protocol-2 redesign.

Pin/mute, message editing/deletion, delete-for-me, hidden rooms and peer read receipts remain future design items. Their eventual implementation must extend authoritative per-user room state and HTTP message-window reconciliation, without introducing a Mongo event history or Redis.
