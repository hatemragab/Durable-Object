# Free-tier boundaries and demo cost controls

> Current protocol: [Room sync v2](../contracts/ROOM_SYNC_V2.md). Outbox, immutable message-event replay and indefinite retention instructions below belong to the original v1 plan. Use the root README migration/run commands and v2 verification status; no Redis is used.

The design targets a small real Cloudflare development trial, not an assurance of zero cost for any account/workload. Check the effective account plan and current limits before running it. Do not upgrade, change billing, or create paid infrastructure automatically.

## Documented platform limits

Cloudflare's detailed Durable Objects pricing page checked on 15 October 2026 lists SQLite-backed objects on Workers Free with: 100,000 requests/day; 13,000 GB-s duration/day; 5 million row reads/day; 100,000 row writes/day; and 5 GB total SQLite data. Operations exceeding a free limit can fail; daily limits reset at 00:00 UTC. ([CF-PRICING](../SOURCES.md#cf-pricing))

The detailed limits page lists 1 GB per object on Free, versus 10 GB per object on Paid. These are platform ceilings, not targets for this three-user experiment. ([CF-LIMITS](../SOURCES.md#cf-limits))

A marketing page may show different abbreviated figures; use the detailed platform pricing/limits pages and the actual account dashboard for operational verification. Do not use the protocol's 10,000-event demo cap as a substitute for account-level quota checks.

## Where usage comes from

Message fan-out writes one event copy for each recipient, including the sender. SQL indexes, metadata updates, device ACKs, and alarm scheduling also generate work. A chat message is not necessarily exactly one SQL row-write billing unit. The Worker gateway, Durable Object calls, heartbeat traffic, snapshot queries, and alarms have distinct accounting; consult the detailed current pricing page rather than dividing all activity by the WebSocket billing ratio.

Static auto-pong avoids its own handler wakeup, but our active-session sweeps and presence reconciliation still wake objects. Use short smoke runs and bounded synthetic traffic rather than leaving test clients polling for days. Remove unnecessary always-running timers/pending promises and confirm Hibernation API usage. ([CF-WS](../SOURCES.md#cf-ws))

## Demo controls

The per-user 10,000-event and 100-room limits are enforced before mutation commit. Use a much smaller set for normal tests, typically tens to a few hundred messages. The local outgoing queue is capped at 1,000 messages. Do not run load tests against the real free account without a separate explicit decision.

When a quota or storage operation fails, preserve authoritative Mongo/outgoing data, stop claiming realtime health, and retry with backoff. Never delete unacknowledged events, switch to fake live delivery, or purchase more quota as an invisible workaround.

Published Mongo journal rows and Cloudflare events remain intentionally retained. Provide an explicit development cleanup runbook, but do not invoke it as a test fixture against an existing user dataset.
