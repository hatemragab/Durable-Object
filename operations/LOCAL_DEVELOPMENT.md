# Local development and real Cloudflare test runbook

> Current protocol: [Room sync v2](../contracts/ROOM_SYNC_V2.md). Outbox, immutable message-event replay and indefinite retention instructions below belong to the original v1 plan. Use the root README migration/run commands and v2 verification status; no Redis is used.

The command interfaces below are implemented in this repository. Current local, real-cloud and mobile verification evidence is recorded in [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md). The dedicated development Worker is deployed; the original specifications alone are not verification evidence.

## Preflight

Record the actual Flutter/Dart, Node/npm, Wrangler, Docker, MongoDB, Android, and Xcode versions. Use the requested Flutter 3.47+ baseline and resolve both selected UI packages. Verify a Free Workers plan is available; never change account billing automatically. Confirm the selected Worker name is new or belongs to this exact demo before updating it.

## Local MongoDB

Create a single-node replica set named `rs0` in a dedicated development container/volume. Expose port 27017 on host loopback only. Initialize the replica set once and wait for PRIMARY. A development URI for a host-running NestJS process should include the dedicated database name, replicaSet=rs0, and a connection approach tested with the container's advertised hostname; directConnection=true is a common explicit single-node development choice.

The implementing agent must prove its chosen URI works from the **host NestJS process**, not just from mongosh inside the container. Handle a container-only advertised hostname deliberately. Do not expose unauthenticated MongoDB to the LAN or Internet. MongoDB documents replica sets for development and the transaction requirements that rule out a plain standalone instance. ([MDB-DEV](../SOURCES.md#mdb-dev), [MDB-TXN](../SOURCES.md#mdb-txn))

Seeding inserts only missing users. It does not drop collections or reset sequences. Store a dataset identity record and reject accidental mismatches.

## Setup helper contract

### Effective Free-plan evidence

The implementation requires positive account-specific plan verification before real deployment. Current documented account subscription/settings APIs do not expose a stable positive Workers Free field; an empty list, zero price, or unrelated `free` zone subscription is not treated as proof. No generic confirmation flag bypasses this check. With access to the intended account, inspect its actual Workers plan in the Cloudflare dashboard, retain a screenshot as ignored `.local/cloudflare-plan.png`, and record the same observation in ignored `.local/cloudflare-plan-verification.json`:

```json
{
  "accountId": "the actual account id from nestjs/.env",
  "plan": "Workers Free",
  "method": "dashboard-observation",
  "sourceUrl": "https://dash.cloudflare.com/the-actual-account-id/workers-and-pages",
  "observedAt": "actual UTC observation timestamp"
}
```

These fields record a completed observation, not an assertion to fill without checking. Setup requires matching account/source, screenshot evidence, an observation less than24hours old, and no observed paid/partner Workers subscription. Without that evidence it stops before deployment. It never upgrades/downgrades billing. The current deployment passed this gate using an actual account dashboard observation and subscription readback; repeat the observation when it expires before a later deployment.

Provide `npm --prefix nestjs run dev:setup` from repository root. It must:

1. Parse/validate nestjs/.env without printing secrets. Generate missing app-only secrets and dataset ID once; never invent management credentials.
2. Check the dedicated local database and initialize/seed it non-destructively, or report the precise missing prerequisite.
3. Prepare the development Worker vars, SQLite class declaration, and bindings. Verify the installed Wrangler accepts the configuration with a dry-run.
4. Deploy **only** the chosen test Worker using the account/token from the parsed allowlist. Supply only the two runtime secrets using the supported secure deployment flow. Preserve any existing unrelated Worker and do not add a custom domain.
5. Discover the actual deployed HTTPS origin from successful CLI/API output. Update an absent REALTIME_BASE_URL safely; verify an already supplied value rather than guessing an account subdomain.
6. Call minimal health plus an authenticated stream/presence endpoint, and verify a ticket-authorized socket test with synthetic data. Missing/invalid keys must fail clearly.
7. Generate public Flutter endpoint/dataset run settings and print next commands, actual nonsecret endpoints, and any remaining device/toolchain blockers.

A temp secret file must have private permissions, contain only the runtime-secret allowlist, and be deleted in a finally/cleanup path. Prefer the documented direct code-plus-secret deployment option when supported rather than leaving a partially configured public app accepting requests. Until all secrets/config are valid, application routes must fail closed. ([CF-SECRETS](../SOURCES.md#cf-secrets))

No tunnel is needed: NestJS publishes outward to Cloudflare and Flutter connects separately to both. The Worker never calls the local backend.

## Required command interface

| Command from repository root | Agent implementation obligation |
|---|---|
| `npm --prefix nestjs run dev:preflight` | Report dependencies/config readiness without secret values |
| `npm --prefix nestjs run db:up` | Start/init local replica set safely |
| `npm --prefix nestjs run db:seed` | Idempotently ensure three users |
| `npm --prefix nestjs run dev:setup` | Configure/test the dedicated Cloudflare development service |
| `npm --prefix nestjs run start:dev` | Start local API and ordered dispatcher |
| `npm --prefix nestjs test` | Backend tests |
| `npm --prefix cloudflare test` | Runtime-aware Worker tests |
| `npm --prefix cloudflare run dev:local` | Optional entirely local Worker for fast tests, distinct storage from real cloud |
| `flutter analyze`, `flutter test` inside flutter/ | Client static/unit/widget checks |

Document exact Flutter run commands with nonsecret dart-defines and a selected device ID after verifying the local toolchain. Do not use a localhost Worker URL for the approved real-cloud trial.

## Client endpoint mapping

| Client | Local NestJS base URL pattern |
|---|---|
| Android emulator | `http://10.0.2.2:3000/api/v1` for the host-loopback alias |
| iOS simulator on the same Mac | Test `http://127.0.0.1:3000/api/v1` from the actual simulator |
| Physical Android/iPhone | `http://<developer-computer-LAN-IP>:3000/api/v1`; same trusted LAN, host binding/firewall allow this test |

Android documents the emulator's special host address. For device/network differences, verify a real health request before debugging sockets. ([ANDROID-NET](../SOURCES.md#android-net))

The real Worker always uses its HTTPS/WSS origin. For local HTTP to NestJS, configure only necessary debug network policy and local-network permissions for the actual platform/networking stack. Do not globally disable TLS verification or copy broad development exceptions into release settings. Android network security settings and Apple's local-network usage description are official references. ([ANDROID-SEC](../SOURCES.md#android-sec), [APPLE-LAN](../SOURCES.md#apple-lan))

## Start order

Start Mongo and wait for PRIMARY; seed/verify dataset; configure the test Worker; start NestJS; verify API health and stream relay; launch Flutter instances with the correct public config. Use separate app installations/simulators to obtain distinct device IDs. Selecting User 2 on two installations must not require a second account record.

## Shutdown and reset

Stopping local NestJS/Docker/Flutter is not deleting the deployed Worker or its SQLite data. Close demo clients to stop their polling/heartbeats. Keep data for later offline/reconnect tests.

A deliberate new dataset uses a fresh DATASET_ID, a distinct database or explicitly approved reset, synchronized Worker config, and matching Flutter public config. Do not erase old pending messages silently. Removing the dev Worker/namespace is destructive and must be an explicit cleanup action, not part of setup, tests, or routine shutdown.
