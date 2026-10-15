# Acceptance criteria and release gate

> Protocol v2 supersedes the original immutable-event/outbox/no-retention requirements below. Current approved sync/unread scope and guarantees are in [Room sync v2](../contracts/ROOM_SYNC_V2.md). Original milestone/native results are historical, not evidence for v2.

This is a development proof-of-concept gate, not a production release checklist. Every checkbox is initially unverified.

## Required product behavior

- [ ] Exactly three seeded accounts; no login/registration screen; cold-launch account picker works.
- [ ] Users create unique-pair direct rooms and idempotent group rooms with fixed memberships.
- [ ] Only members can read/send; only text messages are accepted.
- [ ] Both requested Flutter packages are actually used on the message screen.
- [ ] Cached list/messages render with no network; pending outgoing messages survive restart.
- [ ] Sender, recipient, and same-user second device receive consistent canonical messages without duplicate bubbles.
- [ ] Each device resumes from its own committed cursor and ACKs only after SQLite commit.
- [ ] Live arrival during replay, lost responses/ACKs, and slow-device cases converge correctly.
- [ ] Peer online/offline reflects at least one live device; observer uncertainty displays unknown.
- [ ] Group presence counts distinct other users, not sockets and not the viewer.
- [ ] Heartbeat, jittered reconnect, session expiry, background pause, and account switching clean up correctly.

## Data integrity and configuration

- [ ] Mongo runs as a local replica set; message/room/counters/outbox writes are atomic.
- [ ] Room and user event sequences are contiguous under concurrent/retried sends.
- [ ] Published journal rows and DO events are retained; ACKs never prune another device's backlog.
- [ ] Worker log accepts only contiguous, identity-validated, idempotent events.
- [ ] Trailing log repair uses original Mongo journal bytes without resetting Flutter cursors.
- [ ] REST entity merges never advance the stream cursor or roll back room versions.
- [ ] User-provided nestjs/.env is preserved; only allowed runtime secrets reach the Worker.
- [ ] Management credentials never reach Flutter, Worker runtime, or logs.
- [ ] Only the approved development Worker/new local database were touched; no production deploy or plan change.

## Verification evidence

- [ ] Unit, contract, backend transaction, Worker runtime, and Dart reducer tests have actual command/results evidence.
- [ ] Android development build and smoke run recorded, or a precise environment blocker is reported.
- [ ] iOS development build and smoke run recorded, or a precise environment blocker is reported.
- [ ] Real Cloudflare SQLite append/replay and multi-device smoke run recorded, or credential/account blocker is reported.
- [ ] Hibernation attachment restoration tested; real idle re-entry observation clearly distinguished from local tests.
- [ ] Failure tests and security negatives in TEST_SCENARIOS.md mapped to pass/fail/blocked evidence.
- [ ] Actual run/setup commands, public endpoint configuration, troubleshooting, and limitations documented.

## Completion language

Do not say fully verified when real-cloud or one mobile platform remains untested. A valid handoff can say local implementation completed with named blocked checks, but those checks remain unchecked. No app, cloud deployment, or test execution was performed when producing the present Markdown archive.

## Requirements traceability

| Requirement | Principal implementation tasks | Key scenarios |
|---|---|---|
| R01 account selection | N01-N02, F02/F04/F07 | S01-S02, S36 |
| R02 direct rooms | N03, F07 | S03-S04, S10 |
| R03 group rooms | N03, F07 | S05-S06 |
| R04 list and presence | C06, N07, F06 | S14, S38-S42, S50 |
| R05 text/messages page | N04, F03/F07 | S07, S11-S13, S33 |
| R06 offline outgoing | N04-N05, F02/F04 | S18-S20, S27-S29 |
| R07 multiple devices | C04-C06, F05 | S08-S09, S15-S17, S38 |
| R08 replay | N06, C03-C05, F03/F05 | S16-S17, S21-S26, S30-S35 |
| R09 reconnect/heartbeat | C04-C05, F05 | S37, S43-S46 |
| R10 presence query | C06, N07, F06 | S38-S42, S50 |
| R11 diagnostics | N07, F06/F07 | S31-S32, S46-S49 |
