# Integration tasks and reporting template

> Current protocol: [Room sync v2](../contracts/ROOM_SYNC_V2.md). Outbox, immutable message-event replay and indefinite retention instructions below belong to the original v1 plan. Use the root README migration/run commands and v2 verification status; no Redis is used.

## T01: Cross-component contract suite

Depends on X03 and component model/reducer work. Implement all contract fixtures, then run TypeScript and Dart validation/reduction assertions against them. Reject drift in frame names, identity types, cursor fields, text limits, or room-version semantics.

## T02: Local failure integration

Depends on N01-N08, C01-C07, F01-F08 local portions. Use isolated replica-set/Worker runtime fixtures and transport failure injection to exercise S03-S37 and security errors. Test process restarts and ambiguous response delivery explicitly. Keep fault controls in test-only code, not open Internet routes.

## T03: Real-cloud, multi-device trial

Depends on X04, T01-T02, credentials, and usable clients. Deploy the dedicated development Worker, verify actual SQLite-backed storage, run account/direct/group messaging, multi-device independent replay, heartbeat/presence, and restart tests. Capture relevant IDs/cursors rather than secrets. Use a bounded message count; no real quota exhaustion or production deployment.

## T04: Final evidence review

Map each acceptance criterion and scenario to recorded evidence. Run analyzer/build/test commands, inspect diagnostics, and review secrets/config scope. Distinguish blocked tooling/credentials from failed code. Ensure the runbook contains the actual commands that worked, not a speculative command copied from a document.

## Required implementation progress report

The agent should create `IMPLEMENTATION_STATUS.md` during implementation with these sections:

**Environment:** actual SDK/tool versions, operating systems, dataset ID, Worker name/environment, public endpoints only.

**Task table:** task ID; not started/in progress/blocked/verified; relevant files; actual commands; evidence; remaining issue.

**Scenario table:** S01-S50; pass/fail/blocked/not run; local or remote; device/runtime; concise evidence; failure/blocker reason.

**Known limitations:** unavailable mobile build environment, missing credentials, unobserved real hibernation, demo caps/retention, no push/background guarantee, no production security/scale validation.

**Run instructions:** actual nonsecret setup/start/test commands and how the user fills the source .env. Never include credential values in the report.

## Final review traps

A screenshot of two messages is not proof of independent device ACKs. A mocked Mongo save is not proof of atomic transactions. A socket connection is not proof of sync.ready. A UI tick is not proof of peer delivery. A local runtime test is not proof of real Cloudflare hibernation. Each claimed property needs the corresponding evidence.
