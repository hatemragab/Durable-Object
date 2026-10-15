# Flutter implementation tasks

## F01: Project, packages, and widget spike

Depends on X01-X03. Create Android/iOS project with verified requested SDK, Riverpod, SQLite, transport, and required UI packages. Compile a text bubble/composer with non-text actions disabled. Record actual dependency versions/platform requirements; do not add unnecessary media permissions.

## F02: Persistent account storage

Depends on F01. Implement metadata DB, stable device ID, dataset/account DB isolation, migrations, DAOs, unique constraints, and repository invalidation streams. Tests: restart persistence, account separation, same device across account DBs, sending-to-queued recovery, non-destructive migration.

## F03: Canonical models and reducers

Depends on F02 and X03. Parse shared fixtures; implement room-version guard, message/optimistic merge, applied-event deduplication, and atomic cursor transaction. Tests: REST-before-event, event-before-REST, duplicate/overlapping batch, gap, invalid event, forced SQLite rollback, Unicode validation.

## F04: REST session and persistent send queue

Depends on F02-F03, N02-N04. Implement account selection, memory session tokens, room APIs/history, enqueue-before-clear, ordered retry, idempotent timeout resolution, and permanent failure display. Tests: app killed with pending/sending rows, backend down, timeout after commit, sender's other-device echo, account switch during request.

## F05: Connection manager

Depends on F03-F04, C04-C05. Implement one socket generation, ticket refresh, hello/resume validation, serial reducer, post-commit ACK, heartbeat, jittered reconnect, background pause, and replacement handling. Tests: lost ACK, no pong, no hot loops, no parallel reduction, cursor ahead of remote head, stale callbacks after account change.

## F06: Presence and chat list

Depends on F05, C06, N07. Implement watch/snapshot/change parsing, freshness-to-unknown behavior, direct dots, group distinct-other-user count, cached list updates, and diagnostics. Tests: one of two peer devices disconnecting, observer disconnect, stale state, unknown partial snapshot, sender/device count versus user count.

## F07: Minimal screens

Depends on F04-F06. Implement picker, direct/group creation, chat list, chronological paginated message page, and required package adapters. Tests: keyboard/safe area, scroll preservation, no duplicate bubbles, sender names in groups, clear input only after persistence, no unsupported action buttons.

## F08: Mobile and integration verification

Depends on F01-F07. Run analyzer/unit/widget tests and Android/iOS build/smoke checks where tooling exists. Execute offline, restart, multi-device, and account-switch scenarios against the local backend and real test Worker. Clearly label unavailable platform/device checks instead of claiming both platforms were exercised.

### Completion checklist

- [ ] F01 verified
- [ ] F02 verified
- [ ] F03 verified
- [ ] F04 verified
- [ ] F05 verified
- [ ] F06 verified
- [ ] F07 verified
- [ ] F08 Android verified, or explicitly blocked
- [ ] F08 iOS verified, or explicitly blocked
