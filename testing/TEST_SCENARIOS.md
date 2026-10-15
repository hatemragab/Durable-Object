# Test scenarios and expected results

> Protocol v2 supersedes the original immutable-event/outbox/no-retention requirements below. Current approved sync/unread scope and guarantees are in [Room sync v2](../contracts/ROOM_SYNC_V2.md). Original milestone/native results are historical, not evidence for v2.

Every scenario below is a requirement for the implementing agent, **not a test already executed**. Use synthetic content and isolated test dataset IDs. Unit/contract tests run without cloud credentials; remote smoke tests use only the designated development Worker.

## Test identities

Device A selects User 1; B selects User 2; C also selects User 2. A fourth optional installation D selects User 3. Without D, use a separate group-test phase where C switches to User 3. Device identifiers must differ by installation, not by selected account.

## Functional and multi-device tests

| ID | Action | Required outcome |
|---|---|---|
| S01 | Run seed twice and restart NestJS | Exactly three users; existing rooms, counters, and messages unchanged |
| S02 | Open app, select each account | Correct isolated chat list; no login/registration UI |
| S03 | User 1 creates direct room with User 2; reverse the request | One room ID and one creation event per member |
| S04 | Submit the same direct pair concurrently | Unique index/transaction resolves one room; no duplicate journal entries |
| S05 | Create a group with title and Users 2/3 | All members see the new room; creator included exactly once |
| S06 | Retry group creation after lost response | Same request ID returns the original group; changed fingerprint returns conflict |
| S07 | Send text A to B | One canonical message; recipient gets event; sender echo merges into its optimistic bubble |
| S08 | Keep B and C on User 2, send from A | B and C each commit and ACK the event independently |
| S09 | Send from B while C has same account open | C receives own-account message, shows it as own sender, with no phantom outgoing queue |
| S10 | User 3 accesses the User 1/User 2 direct room | Backend denies history/read/send; no information returned as an authorized room |
| S11 | Send 120 messages then load older pages | Chronological roomSeq order; no duplicates or omitted boundary messages |
| S12 | Send Arabic, English, emoji and multiline content | Correct rendering, stable text across REST/events; byte and scalar limits match |
| S13 | Attempt blank, oversized, unknown-member or self-direct inputs | Explicit validation failure; no partial DB/counter changes |
| S14 | Navigate list to room and back repeatedly | One active account socket, no growing listener/timer count |

## Offline and crash-boundary tests

| ID | Action | Required outcome |
|---|---|---|
| S15 | Disconnect C at cursor N; keep B online; send 120 events | B advances; C remains at N; retained log keeps C's backlog |
| S16 | Reconnect C after S15 | Ordered batches from N+1; final same message IDs/content as B; no duplicate bubbles |
| S17 | ACK only from B while C is offline | No event deletion and no cursor advancement for C |
| S18 | Compose offline, kill/reopen app, select same account | Optimistic bubble and outgoing row survive; later send uses original client ID |
| S19 | Kill app while outgoing row is sending | Startup requeues it; at most one server message after retry |
| S20 | Commit Mongo message, drop REST response | Retry resolves to the original message and event journal entries |
| S21 | Accept Worker append, drop integration response | Repeated envelope is duplicate success; stream head advances only once |
| S22 | Commit local event transaction, drop ACK | Server retransmits; client does not reinsert message and ACKs again |
| S23 | Fail local SQL in the middle of a batch | All local changes/cursor roll back; no ACK; later retry applies it once |
| S24 | Append a new event during replay and at ready transition | All pre-boundary and post-boundary events eventually apply without a hole |
| S25 | Withhold C's ACK while B behaves normally | C retransmits/closes on its own deadlines; B keeps progressing |
| S26 | Clear one test account cache with no pending sends | That device resumes from zero even with a higher server diagnostic ACK |
| S27 | Stop NestJS after events reached Cloudflare | Existing valid socket can replay stored events; new writes remain locally queued |
| S28 | Keep NestJS up but reject Worker appends temporarily | REST writes commit and stay journaled; recovery publishes every sequence in order |
| S29 | Restart NestJS with unpublished/uncertain events | Fresh head queries and idempotent appends converge without dropping rows |
| S30 | Re-enter object constructor with retained sockets; also observe real idle recovery when possible | Attachment-restored user/device/cursor/in-flight state works; record real runtime evidence separately |
| S31 | Simulate missing/trailing DO log in isolated fixture | NestJS rehydrates from published Mongo journal rows; client cursor is not reset |
| S32 | Corrupt one event association or make Worker head greater than Mongo | Integrity error blocks that user; no destructive automatic reset/skip |
| S33 | Deliver REST response before socket echo, then reverse order | One local message in both cases; REST never advances stream cursor |
| S34 | Receive overlapping/duplicate event batch | Already applied prefix is ignored; contiguous suffix commits once |
| S35 | Deliver a gap, wrong recipient/dataset, or unknown durable type | Client does not advance cursor or ACK; diagnostic is visible |
| S36 | Switch User 1 to User 2 while a REST send/replay is pending | No User 1 content/cursor/queue mutation appears in User 2's state |
| S37 | Resume after more than 70 seconds of deliberately slow catch-up | Heartbeat runs during replay; healthy session is not expired simply because sync.ready is delayed |

## Presence, lifecycle, and security tests

| ID | Action | Required outcome |
|---|---|---|
| S38 | Close B while C remains online as User 2 | User 2 remains online with one active device |
| S39 | Close both B and C cleanly | Aggregate User 2 offline update reaches A; cached data remains |
| S40 | Abruptly remove B/C network without close frames | Offline after lease/sweep under normal test timing; record actual delay, not an instantaneous guarantee |
| S41 | Disconnect observing A while B stays online | A shows unknown peer presence, not a false offline claim |
| S42 | Drop a presence-change notification | Periodic authoritative snapshot repairs the icon/count |
| S43 | Background and foreground an app | Best-effort close/pause, fresh ticket on reconnect, replay and pending queue preserved |
| S44 | Reconnect twice using the same device ID | New connection replaces only that device; old 4009 generation does not fight with an auto-reconnect loop |
| S45 | Invalid/expired/tampered ticket, API token used as internal secret, forged user header | Worker rejects each path; no access to another user's log |
| S46 | No pong, future ACK, wrong batch ID, oversized/binary frame | Correct reconnect or protocol close; no cursor advancement/false success |
| S47 | Exceed demo event cap or inject quota failure | No partial transaction, no pruning/paid upgrade, useful error and retained queues |
| S48 | Change configured dataset while old pending sends exist | Mismatch surfaced; old pending sends are not sent into the new dataset |
| S49 | Scan logs and generated public client configuration | No management token, signing/internal secret, raw ticket or bearer-header leak |
| S50 | Open group on A while B and C both represent User 2 | User 2 counts once; viewer excluded; unknown User 3 is not assumed offline |

## Failure-injection implementation

Inject transport and storage failures through test-only providers/harnesses, not unauthenticated routes on the real Worker. Use fake clocks for deterministic ACK/lease/backoff tests. Use a real replica-set integration test for Mongo rollback/races. Test reconnect and SQLite reduction on a simulator/device as well as pure Dart where available.

Do not exhaust a real account's quota to prove S47. Simulate the documented error class at the transport boundary and perform only bounded real-cloud smoke traffic. Do not delete a live user object's data to run S31; use an isolated dataset/runtime fixture or an explicitly approved disposable test namespace.

## Real Cloudflare evidence

Record deployed Worker name/environment, protocol version, toolchain versions, device/OS identities, relevant sequence/head values, and redacted logs. For hibernation, distinguish attachment serialization tests from actual constructor re-entry with surviving sockets. If real eviction cannot be observed reliably, state that limitation instead of asserting it occurred.
