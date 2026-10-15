# Local SQL read optimization report

Local measurements captured15October2026 before deployment. The optimized Worker was subsequently deployed and verified: see [CLOUD_OPTIMIZATION_REPORT.md](CLOUD_OPTIMIZATION_REPORT.md). The phone build was not installed by this optimization task. The externally visible HTTP/WebSocket protocol remains v2.

## Method

The same `SQL read budgets` scenarios ran before and after the changes in native local workerd/SQLite, using the actual `UserRealtime` entry points. Instrumentation wraps `storage.sql.exec` and sums the consumed cursors' `rowsRead`; it is test-only. Fixtures contain 1, 30 or 100 unexpired retained rooms. Each scenario warms schema/identity first. Fixture creation and the one-time schema upgrade are excluded. A caught-up live socket is established before measuring the idle presence alarm; an offline update changes one existing room; a fresh socket resumes from zero for replay. Returned batches are subsequently ACKed through sync.ready to verify full replay completion.

The counters measure explicit SQL reads in the target object. They are not account-wide billed-request totals, do not include implicit alarm-storage operations, and do not attribute historical cloud usage to particular queries. Other-user presence RPCs and test setup are outside the measured operation. Cloudflare documents these counters in its [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), read again for this change on 15 October 2026.

Before measurements were captured against the original source before editing. Original source copies, their SHA-256 hashes, raw baseline snapshots and combined JSON receipt remain in ignored `.local/sql-optimization-before/` and `.local/sql-optimization-read-costs.json`. Current exact measurements are checked in `test/__snapshots__/worker.test.ts.snap`; explicit read budgets additionally fail if inspection, idle alarms, existing-room updates or first-page replay exceed their limits.

## Results: SQL rows read per operation

| Operation | 1 room: before → after | 30 rooms: before → after | Reduction at 30 | 100 rooms: before → after | Reduction at 100 |
|---|---:|---:|---:|---:|---:|
| Stream inspection, including scheduling | 7 → 5 | 65 → 5 | 92.3% | 205 → 5 | 97.6% |
| Connected, caught-up idle presence alarm | 12 → 7 | 99 → 7 | 92.9% | 309 → 7 | 97.7% |
| Higher revision for an existing room, no sockets | 12 → 11 | 41 → 11 | 73.2% | 111 → 11 | 90.1% |
| Offline local-presence query, including scheduling | 5 → 4 | 5 → 4 | 20.0% | 5 → 4 | 20.0% |
| Resume handler through first replay page | 16 → 15 | 132 → 44 | 66.7% | 363 → 65 | 82.1% |

At 100 rooms the first replay page contains at most 50 room items; this row does **not** claim a complete 100-room replay costs only 65 reads. All pages and ACKs still complete in the scenario.

Idle remote reconciliation also changes from 30 seconds to 300 seconds. With three users each retaining 30 rooms and one continuously running backend, that component falls from approximately `3 × 2,880 × 65 = 561,600` SQL reads/day to `3 × 288 × 5 = 4,320`: **99.2% lower**. This is a steady-state projection for stream checks alone, excluding startup, failures, app activity, presence alarms and migration; it is not a measured reduction in the whole Cloudflare account.

## Changes and correctness

- Expiry first reads indexed `MIN(expires_at_ms)`. If nothing is due, it stops. Due cleanup explicitly uses the expiry index rather than allowing MAX(stream_seq) to scan unexpired room rows through the sequence index.
- Schema4 maintains `retained_count` with payload insertion and expiry in the same SQL transactions. Compaction, duplicate/stale retries and device ACKs do not decrement or inflate it. Schema3 performs one additive, atomic backfill; epoch, payloads, deadlines, revision watermarks, devices and in-flight bytes survive.
- Caught-up socket pumps stop after current epoch/floor/head checks. Idle presence alarms skip room pumping; append, resume and ACK handlers pump immediately, and an alarm that expires payloads still rechecks socket coverage. Metadata already read in the synchronous scheduling turn is reused.
- Dirty Mongo state still publishes on the existing one-second poll. Only idle remote head/epoch reconciliation slows to five minutes. Startup and explicit reconciliation bypass the interval. A silent remote rollback/replacement affecting only clean rows may take up to five minutes plus request/poll time to detect.
- Flutter sends one initial presence.watch, whose response already contains the snapshot, instead of immediately requesting the same snapshot again. Thirty-second presence refreshes and heartbeat/lease timing remain intact.
- No Redis, new event journal, retention extension or public API change.

## Validation

Commands actually run from the repository root unless noted:

- `npm --prefix cloudflare test -- -t 'SQL read budgets' -u`: baseline recorded before source changes, 3 scenarios passed.
- `npm --prefix cloudflare test`: 38 tests passed after optimization, including 3 performance scenarios and 3 new retention/migration/rollback cases.
- `npm --prefix cloudflare run typecheck`, `format:check`, `build`: passed; build is Wrangler `--dry-run`, with no upload.
- `npm --prefix nestjs test`: 71 tests passed against isolated replica-set databases; includes immediate dirty publication during the slower reconciliation interval, exact due check, changed-epoch repair and forced reconciliation. Existing startup/crash, source-revision retry, snapshot fencing and unread tests remain passing.
- `npm --prefix nestjs run typecheck`, `format:check`: passed.
- `npm --prefix shared test`: 13 tests passed.
- In `flutter/`: `flutter analyze --no-pub` clean; `flutter test --no-pub --reporter compact` 71 tests passed; format check 25 files unchanged; `flutter build apk --debug --dart-define-from-file=config.local.json --no-pub` passed. No device installation/UI test was performed for this change.
- `npm run test:safety`: 18 tests and configured-secret scan passed. `git diff --check` passed; targeted before/after source diffs were reviewed because application files are currently untracked.
- `node .local/sql-optimization-e2e/run.mjs`: 13 HTTP/WebSocket/Mongo/SQLite checks passed with the updated built Worker in local Miniflare/workerd, a fresh dataset/database and a temporary API bound to an ephemeral loopback port. Four independent SQLite clients covered offline compaction after 35 messages, unread/read races, latest30 HTTP history, top20 room paging, source-revision retry and a >48-hour baseline causing sync.required/4010 followed by successful HTTP snapshot/reconnect. The helper adapts the existing smoke harness to isolated inputs; earlier attempts exposed harness assumptions about preseeded/drained room fixtures and fixed port8787, which were corrected only in the ignored helper. Both temporary services closed in finally; the user's API, cloud deployment and demo data were not used or reset. Receipt: `.local/sql-optimization-e2e/receipt.json`.

The 48-hour test controls runtime time; it does not wait 48 wall-clock hours. It verifies just-before/exact deadlines, compaction's new acceptance deadline, recent identical retries not extending TTL, advancing floors, stale-baseline full-sync decisions, persistent source watermarks and a later higher revision becoming replayable. Separate existing runtime tests exercise socket 4010 snapshot fallback, sparse/empty coverage, independent device ACKs, fixed in-flight retransmission, lost ACKs, local hibernation and alarms without connected sockets. New migration coverage hibernates a socket with an unacknowledged batch, migrates schema3, checks unchanged frozen bytes/epoch, and ACKs successfully. Injected cleanup failure rolls back the floor, payload and retained counter together.

These results remain local benchmarks, not a measure of total account savings or production capacity. The user's later deployment authorization and separate real-cloud evidence are recorded in [CLOUD_OPTIMIZATION_REPORT.md](CLOUD_OPTIMIZATION_REPORT.md); actual provider idle-constructor re-entry remains unobserved.

Schema4 applies lazily on object initialization. Once upgraded, an old schema3-only Worker binary cannot be rolled back unchanged; a rollback build must understand schema4. The five-minute silent-repair detection tradeoff is deliberate and separately tested. Existing native-plugin Kotlin migration warnings and local workerd alarm/failure-injection diagnostics remain nonfatal tool output; no new dependencies were added.
