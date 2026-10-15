# Worker structure and configuration

## Expected implementation layout

```text
cloudflare/
  AGENTS.md and specification documents
  src/
    index.ts                         Worker router and class export
    env.ts                           Typed runtime bindings
    auth/ticket-verifier.ts          Short-lived upgrade ticket verification
    auth/internal-auth.ts            Backend integration secret verification
    durable-objects/user-realtime.ts Runtime entry points and orchestration
    storage/migrations.ts            Application SQLite schema versioning
    storage/event-store.ts           Compacted room projection and bounded delta reads
    protocol/frames.ts               Shared-contract frame validation
    protocol/event-pump.ts           Resume/ACK/retransmission state machine
    presence/presence-service.ts     Lease evaluation and ephemeral fan-out
    scheduling/alarm-scheduler.ts    One central deadline scheduler
  test/
  wrangler.jsonc                     Created by implementing agent
  package.json and lockfile          Created by implementing agent
```

Keep helpers small; the important boundary is durable log versus per-socket protocol state, not the exact number of source files.

## Class and binding declaration

The official documentation checked on 15 October 2026 describes declarative `exports` entries for Durable Object classes. Declare `UserRealtime` with type `durable-object` and storage `sqlite`, plus the `USER_REALTIME` binding. The current docs support legacy migrations too, but one Worker must not combine both lifecycle flows. Use the chosen Wrangler's dry-run validation before deployment. If tooling cannot support the documented exports flow, resolve the toolchain or explicitly document a tested legacy `new_sqlite_classes` fallback for a **new** Worker. Do not switch an existing namespace destructively. ([CF-EXPORTS](../SOURCES.md#cf-exports))

Use a named `development` environment or an explicitly development-only Worker name. The deployed name must match the user's configured test Worker. Declare Durable Object bindings inside a named environment because those bindings are not inherited. Do not add a production target. Pin the tested compatibility date in the resulting config, initially 2026-10-15 if supported. ([CF-ENV](../SOURCES.md#cf-env))

## Runtime inputs

The Worker receives `APP_ENV=development`, `DATASET_ID`, `WS_TICKET_SECRET`, `REALTIME_INTERNAL_SECRET`, and `USER_REALTIME`. Optional test constants are compiled/shared defaults, not management secrets. The Worker does not need `MONGO_URI`, `DEV_SESSION_SECRET`, `CLOUDFLARE_API_TOKEN`, or the local NestJS base URL.

Worker secrets and local `.dev.vars` are distinct from NestJS configuration. The implementing agent must automate their mapping from the user's chosen `nestjs/.env` source; Cloudflare does not automatically load that file. Keep generated local secret files ignored and deploy only the required secret names. ([CF-SECRETS](../SOURCES.md#cf-secrets))

## Public and internal routes

| Route | Authentication | Behavior |
|---|---|---|
| `GET /health` | None | Minimal service/protocol/development flag; no secrets or private stream details |
| `GET /v1/ws?ticket=...` | Valid short-lived ticket | Upgrade; verified user/device/dataset selects object |
| `POST /internal/v1/users/:userId/events` | Internal bearer + dataset header | Upsert a current RoomUpdate source revision |
| `GET /internal/v1/users/:userId/stream` | Internal bearer + dataset header | Return datasetId, userId, epoch, headSeq, replayFloor, retainedFromSeq, eventCount, retentionMs |
| `POST /internal/v1/presence/query` | Internal bearer + dataset header | Body `userIds` subset of the three users; return PresenceDto list |

Internal presence delivery between objects is binding-only. Do not expose another Internet endpoint for it. Restrict methods and paths; unknown paths return 404. Object SQL is not available through a generic HTTP query endpoint.

## Append HTTP result

After confirmed storage acceptance return `datasetId`, `userId`, `epoch`, `acceptedSeq`, `headSeq`, and `duplicate` with status 200. The Worker assigns the cursor; requests contain `RoomUpdate` protocol v2 with no `streamSeq` or event ID. `acceptedSeq` confirms current room state accepted in SQLite, not delivery/read state. Older source revisions are superseded success; same revision with conflicting content returns `EVENT_CONFLICT`. Infrastructure failures must not become success. There is no contiguous event append or Mongo journal replay.

## No local callback requirement

The Worker validates tickets locally and already has its replay log. It never calls a LAN address, localhost, or a temporary tunnel to authenticate Flutter or fetch messages. This is what makes a real Cloudflare test compatible with a local NestJS backend.
