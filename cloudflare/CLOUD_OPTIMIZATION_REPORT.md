# Optimized Worker: real-cloud verification

15 October 2026. The optimized development Worker is deployed at [chat-poc-realtime-development](https://chat-poc-realtime-development.hatemragapdev.workers.dev).

## Deployment readback

- Active deployment: `fe625597-90a8-4ae2-b6f2-ea095c535625`, created `2026-10-15T12:18:18.008508Z`.
- Version `27902084-68a3-46e1-ab0c-49a7e109d5b0` receives 100% traffic.
- Existing SQLite namespace `3bae1cb713c2412dbba41ace518eaaee` and dataset were preserved. All three user epochs stayed unchanged and heads did not regress. Schema4 was observed directly in live SQLite; the inspected retained counter13 matched13 actual payload rows.
- Health returned protocol2; authenticated stream inspection, missing-key401 and ticket-authorized WebSocket hello passed. Runtime secret bindings remain only WS_TICKET_SECRET and REALTIME_INTERNAL_SECRET; management credentials were not deployed. Workers Free plan evidence and account subscription checks passed; no plan/domain/billing changes.

Executed `npm --prefix nestjs run dev:setup`, then independently read management settings, active deployment/version, namespace and live runtime identity. The helper's replica-set/seed verification was non-destructive. User-owned API3000 remained running; no phone app was installed.

## Real-cloud functional checks

`node testing/room-sync-smoke.mjs --cloud`: **13 checks passed** with four independent Node SQLite clients and actual HTTPS/WSS Cloudflare transport. Checks covered source-room fan-out to sender/recipients, personalized unread/read races, offline35-message compaction to one latest room row, SQLite commit before ACK, HTTP latest30/history boundaries, same-message idempotency, bounded retained growth, old-baseline rejection with sync.required/4010, HTTP snapshot and successful reconnect.

The test accounts currently have fewer than20 Mongo rooms, while old Cloudflare summaries remain from earlier test data. The harness previously assumed20 rooms and identical Mongo/cloud populations. It now validates a smaller complete snapshot, explicitly reports older-page coverage as skipped when there is no continuation, and compares retained growth against a captured pre-run baseline and the100-room cap. No old records were deleted or fabricated to satisfy the test. Earlier attempts stopped at those harness assumptions after successful replay/unread checks. The final run passed; older-page behavior separately passed the13-check isolated local smoke with21 preseeded/drained rooms through the same updated harness.

`node testing/room-sync-outage-smoke.mjs`: **4 checks passed**. Its own API3001 stopped and became unreachable; a previously issued ticket replayed already-published state directly from Cloudflare, committed room/cursor into SQLite before ACK, and contained room summaries rather than message-history events. The user's separate API3000 was not stopped, so this does not claim every backend was unavailable.

## Retention evidence and limits

- A genuinely >48-hour-old client baseline was rejected by the deployed Worker, followed by successful fresh HTTP snapshot recovery.
- Read-only Data Studio SQL inspected the final smoke room in the user3 object: schema4, unchanged epoch, head35, retained_count13 and actual_count13.
- Stored expiry was `2026-10-17T12:20:57.001Z`, approximately48hours plus955ms after the source update, consistent with the publish/acceptance delay and configured172,800,000ms retention.
- Reposted the same current source room revision through the authenticated integration endpoint. Cloudflare returned duplicate:true, acceptedSeq35 and headSeq35. A second live SQL query returned the exact same expiry1792239657001; the retry did not extend retention or advance the stream.
- No expiry timestamp or live payload was edited. Actual automatic deletion after48 elapsed wall-clock hours was **not observed** in this short run. Exact cutoff, expiry-floor/counter rollback, alarm/access pruning, no stale resurrection and pending-batch migration were verified with controlled time in the38-test local workerd suite before deployment. Live baseline fallback and stored deadlines are separate evidence, not a48-hour elapsed test.

## SQL reads observed after deployment

Read Cloudflare's GraphQL `durableObjectsPeriodicGroups.sum.rowsRead/rowsWritten`, filtered to the exact namespace/object and UTC windows. Dataset/field names were discovered using API introspection. Daily totals aggregate only by object (no1000-minute-group truncation). The account namespace listing contains this one namespace. See [Cloudflare's metrics documentation](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).

A controlled batch sent100 successful stream inspections to user3, retaining13 rooms, from12:23:42.140Z to12:23:44.154Z. Cloudflare reports **510 SQL reads in that window, approximately5.1/request**. The window can include small concurrent/rounded-time background activity; it is not an instrumented claim that every individual request cost exactly5.1. The full12:23 minute for that object reported524 reads, including the duplicate retry and background presence. This agrees with the local five-read inspection budget; the100-room local benchmark was205→5 reads, not a claim that this cloud13-room object previously cost205.

A quiet post-deployment minute12:25 reported64 reads across all three user objects. The seven-minute pre-deployment comparison12:10–12:16 reported1,977 reads, averaging282.4/min. These are short observed activity samples, not identical load tests or guaranteed capacity. The controlled100-request batch, smoke runs and Data Studio queries are excluded from the quiet comparison window.

At12:28:06Z, the namespace had3,697,243 SQL reads today (73.94% of5million), leaving1,302,757. These totals include the old implementation and all previous tests; deployment does not reset the allowance. Analytics are asynchronously reported; the latest receipt may contain a newer total/window.

## Receipts and additional validation

Ignored receipts are under `.local/sql-cloud/`: deployment-readback.json, before.json, preservation.json, retention-readback.json, duplicate.json, controlled-requests.json, measurement-first.json, pre-optimization-window.json, final-metrics.json and service/test logs. Standard cloud smoke and outage receipts are `.local/room-sync-cloud-latest.json` and `.local/room-sync-cloud-outage.json`.

Updated only the test harness and verification documents after deployment; Worker source was the previously validated optimized build. `node --check testing/room-sync-smoke.mjs`, targeted Prettier, updated isolated13-check smoke, `npm run test:safety` (18 tests plus secret scan), and whitespace checks passed. Temporary API3001 and the local smoke's ephemeral API/workerd closed; user API3000 stayed running. No physical mobile test, production-capacity guarantee, source commit/push or unrelated Worker update is claimed.
