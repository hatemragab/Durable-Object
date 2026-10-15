# Cross-component contract fixtures

> Protocol v2 supersedes the original immutable-event/outbox/no-retention requirements below. Current approved sync/unread scope and guarantees are in [Room sync v2](../contracts/ROOM_SYNC_V2.md). Original milestone/native results are historical, not evidence for v2.

The implemented JSON fixtures live in `shared/fixtures/` and are consumed by TypeScript and Dart contract tests. Generate them with `node shared/scripts/generate-fixtures.mjs` after building the shared package. The following catalog describes their expected assertions.

## Fixed identifiers

Use valid UUIDs and the string user IDs 1/2/3 from DOMAIN_AND_EVENTS.md. Assign fixed timestamps, never Date.now() in fixture assertions. Keep separate streamSeq and roomSeq values to catch accidental field conflation.

## Fixture catalog

| Fixture name | Content | Expected assertions |
|---|---|---|
| direct-room-created | User 2 streamSeq 1, room.upserted for a User 1/User 2 room | Same parsing in TypeScript and Dart; direct title null, two members |
| direct-message-created | Same user streamSeq 2, message roomSeq 1, room version 2 | Sender/client/message identity preserved; room preview points to message |
| group-room-created | User 2 streamSeq 3, another room with three members | roomSeq not assumed equal to streamSeq |
| group-message-created | User 2 streamSeq 4, group roomSeq 1 | Message reducer creates/updates the correct room independently |
| replay-batch-1-4 | Four real complete envelopes, contiguous boundaries | Atomic reduction yields cursor 4 and correct entities |
| duplicate-batch-1-4 | Same batch received after local cursor 4 | No extra rows, safe re-ACK |
| overlapping-batch-3-6 | Two duplicates followed by two new real envelopes | Only 5-6 apply, final cursor 6 |
| gap-batch | Local cursor 4, incoming first sequence 6 | Rollback/no ACK; not silently set cursor to 6 |
| wrong-recipient | Valid schema, different userId | Reject before local writes |
| conflicting-idempotency | Same event ID/sequence with changed message text | Integrity error, not duplicate success |
| stale-room-rest | Room version 2 after local version 4 | No preview rollback and no cursor advancement |
| optimistic-confirmation | Local pending client ID matches committed message | One message row; outgoing row removed after commit |
| unsupported-event | v1 unknown durable event type | Do not skip/ACK |
| unicode-text | Arabic + English + emoji + newline within limits | Exact content and matching scalar/UTF-8 size checks |
| presence-online-two-devices | One user's state online, activeDeviceCount=2 | Direct peer online; group counts one user |
| presence-unknown | Null counts/revision/observation | UI unknown, not offline |
| hello-and-resume | Valid selected dataset/user/device with local afterSeq | Identity checks; no server-max-ACK substitution |
| whitespace-validation | Explicit26-scalar whitespace class, blank negatives and exact text/title expectations | TypeScript/Dart reject U+0085/BOM-only text, preserve nonblank message bytes, and normalize padded titles identically |

## Golden state assertions

For every accepted batch compare message server IDs, sender/client IDs, roomSeq, room.version, lastMessage, local lastAppliedSeq, and pending-queue contents. Comparing only text strings can miss duplicates and wrong-order bugs. For rejected batches compare the entire relevant pre/post local state and assert no ACK was emitted.

Use one fixture envelope's exact UTF-8 bytes for append/retry hash tests. A semantically similar reserialized envelope with different bytes is not this protocol's byte-identical retry; the dispatcher must use the retained original body.

## Test ownership

NestJS tests validate emitted DTO/envelope fields. Cloudflare tests validate acceptance, identity/hash/sequence behavior, and frame batching. Dart tests validate parsing and entity/cursor reduction. A contract change updates all three fixture consumers before it is considered complete.
