# Implementation plan and dependency gates

> Protocol v2 supersedes the original immutable-event/outbox/no-retention requirements below. Current approved sync/unread scope and guarantees are in [Room sync v2](contracts/ROOM_SYNC_V2.md). Original milestone/native results are historical, not evidence for v2.

Follow this order; do not build a polished UI before the delivery contract works. All tasks begin unchecked. Component task files provide the detailed outputs and tests.

| Milestone | Tasks | Depends on | Exit evidence |
|---|---|---|---|
| M0: Workspace/toolchain | X01-X03 | Nothing | Version report, directory scaffold, shared contract fixtures |
| M1: Backend core | N01-N04 | M0 | Seeded replica set, dev session, room APIs, atomic message/outbox transaction tests |
| M2: Durable log service | C01-C03 | M0, N01 | Authenticated Worker routes, SQLite migrations, append/dedup/gap tests |
| M3: Backend relay | N05-N06 | M1, M2 | Restart-safe ordered delivery and missing-stream repair |
| M4: Socket protocol | C04-C05 | M2 | Resume, batch ACK, duplicate handling, hibernation-safe metadata tests |
| M5: Presence | C06, N07 | M4 | Aggregate multi-device status and snapshot/transition tests |
| M6: Flutter data path | F01-F05 | M0, M1, M4 | Account-isolated SQLite, reducers, persistent send queue, reconnect unit tests |
| M7: Minimal screens | F06-F07 | M5, M6 | Required widgets, account picker, room creation, chat list and messages |
| M8: Local integration | N08, C07, F08, T01-T02 | M1-M7 | Automated local end-to-end failures and cross-language fixtures |
| M9: Real development trial | X04, T03-T04 | M8 + credentials/devices | Authenticated dev Worker; actual multi-device smoke results; honest test report |

## Workspace tasks

### X01: Preflight and safe workspace

Read the agent instructions. Record Flutter/Dart, Node/npm, MongoDB, Docker, Xcode/Android tooling, and Wrangler availability. Flutter 3.47+ is the user's requested baseline; record reality rather than guessing the release channel. Inspect existing files before scaffolding; preserve these documents and any user configuration. Establish secret ignores immediately.

### X02: Dependency and configuration foundation

Choose compatible releases using [PACKAGE_SELECTION.md](PACKAGE_SELECTION.md). Resolve and pin dependencies. Create placeholder-only example configuration files during implementation, never in this documentation pack. Implement validation against [operations/ENVIRONMENT.md](operations/ENVIRONMENT.md). Create local Mongo replica-set setup and health checks.

### X03: Canonical contracts and fixtures

Implement shared TypeScript DTO/schema definitions for both server components, with manual Dart models. Create JSON fixtures from [contracts/DOMAIN_AND_EVENTS.md](contracts/DOMAIN_AND_EVENTS.md) and [testing/CONTRACT_FIXTURES.md](testing/CONTRACT_FIXTURES.md). Establish tests for integer validation, frame byte limits, duplicate sends, and exact event parsing before independent component work diverges.

### X04: Development-only setup automation

Implement the setup helper defined in [operations/LOCAL_DEVELOPMENT.md](operations/LOCAL_DEVELOPMENT.md): parse `nestjs/.env`, provision only the test Worker configuration, transfer only required runtime secrets, and report the actual Worker URL. Do not add a production target. Never silently upgrade the plan or overwrite unrelated resources.

## Integration ownership

The NestJS agent owns authoritative DTO fields, transaction behavior, and the retained journal. The Cloudflare agent owns socket frame semantics, SQL persistence, replay, and presence. The Flutter agent owns client persistence and state-machine behavior. A single integration owner resolves contract changes across all three and updates tests before merging.

Component work can proceed in parallel against fixtures after X03. Do not introduce incompatible names such as `offset`, `seq`, and `cursor` for the same wire field: use the canonical `streamSeq` for events and `afterSeq` for resume.

## Task reporting format

For each task record status (`not started`, `in progress`, `blocked`, `verified`), files created/changed, commands executed, test evidence, and next dependency. A blocked real-cloud deployment is not a reason to abandon local work, and local success is not evidence of a real Cloudflare run.
