# Durable Objects chat proof of concept

**Protocol v2 implementation · 15 October 2026 · See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for verification and blockers**

This repository implements a small NestJS + MongoDB + Flutter chat demo with a SQLite-backed Cloudflare Durable Object per user. Protocol v2 uses compacted room snapshots, 48-hour replay and unread counts, with no MongoDB event journal. The development Worker is deployed on Workers Free; v2 local and cloud room-sync tests pass. Earlier v1 native/device results are historical. The updated Flutter app still needs the user's mobile trial; see the implementation status for exact evidence.

## Room sync v2

The current design removes `event_outbox`: MongoDB keeps permanent messages and current per-user `room_members` state; Cloudflare retains one latest room update per room for 48 hours. New/expired/large gaps obtain a top-20 HTTP room snapshot. Messages load by HTTP in pages of 30, with account-wide unread counts. See [the normative design](contracts/ROOM_SYNC_V2.md). Older v1 cloud/native results below are historical until rerun for v2.

For an existing schema-1 demo dataset, stop the old API and explicitly migrate before starting v2:

```sh
npm --prefix shared run build
npm --prefix nestjs run build
npm --prefix nestjs run db:migrate:room-sync -- --drop-event-outbox
```

This is an operator migration: it removes only the owned demo database's obsolete outbox after membership backfill. It preserves rooms/messages; migrated pre-existing history starts read because v1 had no read state. Do not run it against another database.

## Run locally

Requires Node24+, Flutter3.47+, and the MongoDB server binary (or a compatible dedicated replica set). The included database helper runs an isolated native `mongod` on loopback27028 under ignored `.local/mongo`; Docker and `mongosh` are not required. It never drops existing data.

```sh
npm run bootstrap
npm --prefix nestjs run dev:preflight
npm --prefix nestjs run dev:setup -- --local
```

Setup initializes missing application configuration in ignored `nestjs/.env`, seeds the dedicated replica set, validates the Worker configuration, writes only two runtime secrets to the ignored local Worker secret file, and creates public `flutter/config.local.json`. Existing user-entered values are preserved.

Run in separate terminals from the repository root:

```sh
npm --prefix cloudflare run dev:local -- --config wrangler.local.jsonc
npm --prefix nestjs run dev:local
```

Then, inside `flutter/`:

```sh
flutter run -d 3CC14436-EC3C-4419-A079-C84951E5FA07 --dart-define-from-file=config.local.json
```

This uses local workerd and the authorized iPhone17Pro/iOS26.0 simulator. It does not deploy Cloudflare or demonstrate multiple native devices.

## Real development Worker

Current verified origin: <https://chat-poc-realtime-development.hatemragapdev.workers.dev>. NestJS remains on the developer's computer. The ignored `nestjs/.env` contains the deployment credentials and discovered origin; management credentials are excluded from Worker bindings and Flutter configuration.

Fill `CLOUDFLARE_ACCOUNT_ID`, a restricted `CLOUDFLARE_API_TOKEN`, and the dedicated development Worker name in `nestjs/.env`, then run:

```sh
npm --prefix nestjs run dev:setup
npm --prefix nestjs run start:dev
```

Before real deployment, record the effective Workers Free plan observation described in [the runbook](operations/LOCAL_DEVELOPMENT.md#effective-free-plan-evidence). Current documented account APIs do not expose a positive Free-plan field; missing or stale evidence blocks deployment. Setup also inspects the exact target, rejects an existing unrelated dataset/environment, deploys code with only the runtime-secret allowlist, discovers and verifies the actual origin, and tests authenticated stream access and a ticket-authorized socket. Management credentials remain deployment inputs. Missing credentials block deployment clearly; no temporary account, custom domain, or plan upgrade is created. The GitHub remote is the user-specified [hatemragab/Durable-Object](https://github.com/hatemragab/Durable-Object); no commit or push is needed for direct Wrangler deployment.

## Physical phone testing on the local network

The current Mac Wi-Fi address is `192.168.1.131`. The API is configured with `HOST=0.0.0.0` on port3000, and the ignored `flutter/config.local.json` now selects `http://192.168.1.131:3000/api/v1` with the existing dataset. Cloudflare remains the HTTPS/WSS realtime service; MongoDB remains on loopback27028.

Keep the phone and Mac on the same trusted Wi-Fi. Open <http://192.168.1.131:3000/api/v1/health> on the phone, connect it by USB and follow the [physical-phone Flutter instructions](flutter/README.md#manual-testing-on-your-physical-phone). The iOS Debug build includes a typed HTTP exception for this exact IP and a local-network permission description; Release/Profile are unchanged. The physical phone's browser reachability, signing and app runtime still need the user's trial. If DHCP changes the Mac address, update the backend's `FLUTTER_API_BASE_URL`, regenerate the public Flutter config and update `flutter/ios/Flutter/Debug.xcconfig` before rebuilding.

## Verification commands

```sh
npm --prefix shared test
npm --prefix nestjs test
npm --prefix nestjs run typecheck
npm --prefix nestjs run format:check
npm --prefix cloudflare test
npm --prefix cloudflare run typecheck
npm --prefix cloudflare run build
npm run test:safety
node testing/local-smoke.mjs
```

The final smoke command requires the two local services above. It adds bounded synthetic messages and uses independent SQLite harness clients; it does not clear the dataset. Inside `flutter/`, run `dart format --output=none --set-exit-if-changed lib test integration_test`, `flutter analyze`, and `flutter test`. Native integration commands/results are recorded in the implementation report. Shared schemas are in `shared/src/index.ts`; the self-contained OpenAPI3.1 document is `contracts/openapi.yaml`.

Protocol-v2 end-to-end verification is `node testing/local-smoke.mjs` (local Worker) or `node testing/local-smoke.mjs --cloud` (verified deployed Worker). Both delegate to `testing/room-sync-smoke.mjs`: independent device SQLite application before ACK, compacted reconnects, unread races, history windows, first-page pagination and expired-baseline fallback. Reports are ignored under `.local/room-sync-*`. The v1 outage/transport/native controller scripts are retired with an explicit guard; their historical reports do not establish v2 behavior. `node testing/room-sync-outage-smoke.mjs` owns port3001 temporarily and proves SQLite room replay using only Cloudflare after stopping that probe API; it does not stop another user-run API. Unit/runtime tests cover the v2 fault boundaries. No native-device v2 test is implied.

## Start here

Continue by reading [AGENTS.md](AGENTS.md), [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), [REQUIREMENTS.md](REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The task documents describe the approved scope; their original unchecked gates must be compared with current evidence.

`nestjs/`, `cloudflare/`, and `flutter/` are the component projects, with source alongside their original specifications. `shared/` contains environment-neutral TypeScript contracts and golden JSON fixtures consumed across the implementations.

## Approved decisions

| Area | Decision |
|---|---|
| Execution | NestJS and MongoDB on the developer's computer; Flutter on Android/iOS simulators or phones |
| Cloudflare | A real, authenticated **development Worker**, using SQLite-backed Durable Objects on Workers Free |
| Main database | MongoDB is the permanent room/message authority |
| Delivery database | Each user's Durable Object SQLite stores latest room changes for 48 hours and device ACK diagnostics |
| Client database | Account-isolated Flutter SQLite caches rooms/messages and persists outgoing messages and replay cursors |
| Users | Exactly `1`, `2`, `3`, displayed as User 1, User 2, User 3; seed automatically |
| Entry flow | Pick an account; no login, passwords, registration, or external identity provider |
| Rooms/messages | Direct and group rooms; text only; fixed membership after creation |
| Send/receive | Send and fetch messages through NestJS REST; synchronize room state through a standard Cloudflare WebSocket |
| Flutter | User-required Flutter 3.47+; verify the actual installed SDK and package resolution |
| State/UI packages | Riverpod, sqflite, web_socket_channel, v_chat_bubbles, v_chat_input_ui |
| Secrets | User edits `nestjs/.env`; an agent-built setup command maps the required subset to Worker secrets/config |

**Development-only does not mean everything is local.** The approved Cloudflare component runs in the real Cloudflare account and has an Internet-addressable endpoint. Its application routes require credentials. There is no production application deployment, public demo invitation, store release, domain change, or paid-plan upgrade in scope.

## Navigation

| Folder/document | Purpose |
|---|---|
| [REQUIREMENTS.md](REQUIREMENTS.md) | Features, limits, exclusions, and user flows |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Ownership, ordering, delivery boundaries, topology |
| [contracts/DOMAIN_AND_EVENTS.md](contracts/DOMAIN_AND_EVENTS.md) | Canonical identifiers, DTOs, durable event payloads |
| [contracts/DEFAULTS_AND_ERRORS.md](contracts/DEFAULTS_AND_ERRORS.md) | Shared constants and error semantics |
| [nestjs/TASKS.md](nestjs/TASKS.md) | Backend implementation work |
| [cloudflare/TASKS.md](cloudflare/TASKS.md) | Worker, SQLite, WebSocket, presence work |
| [flutter/TASKS.md](flutter/TASKS.md) | Cache, state management, UI, reconnect work |
| [operations/ENVIRONMENT.md](operations/ENVIRONMENT.md) | Variable ownership and safe configuration |
| [operations/LOCAL_DEVELOPMENT.md](operations/LOCAL_DEVELOPMENT.md) | Setup, run order, simulators, physical phones |
| [testing/TEST_SCENARIOS.md](testing/TEST_SCENARIOS.md) | Functional and failure-injection scenarios |
| [testing/ACCEPTANCE_CRITERIA.md](testing/ACCEPTANCE_CRITERIA.md) | Completion gates |
| [SOURCES.md](SOURCES.md) | Official documentation and package references |

## What this validates

A user with two devices receives the same room and message changes on both. Either device can disconnect, restart, and catch up independently without duplicate visible messages. Messages composed offline survive an app restart and are sent idempotently after the local backend is reachable. Direct-chat presence remains online while at least one of the peer's devices has a live session.

This is a bounded correctness experiment. Cloudflare keeps compacted room state for 48 hours; MongoDB stores permanent messages without a retained event journal. See [Room sync v2](contracts/ROOM_SYNC_V2.md) for snapshot recovery, history reconciliation and limits.
