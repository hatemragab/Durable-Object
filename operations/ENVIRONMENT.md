# Environment variables and secret ownership

> Current protocol: [Room sync v2](../contracts/ROOM_SYNC_V2.md). Outbox, immutable message-event replay and indefinite retention instructions below belong to the original v1 plan. Use the root README migration/run commands and v2 verification status; no Redis is used.

The user edits **one source file: `nestjs/.env`**. This local file is ignored; the repository includes a placeholder-only example and a setup helper that preserves populated values. This section defines the implemented mapping; NestJS's file is not automatically read by Cloudflare.

## Variable inventory

| Variable in nestjs/.env | Required/default | Consumers |
|---|---|---|
| APP_ENV | `development`; reject production | NestJS, Worker nonsecret configuration |
| PORT | `3000` | NestJS |
| HOST | `127.0.0.1`; `0.0.0.0` only for trusted-LAN phone testing | NestJS |
| DATASET_ID | UUID; generate once if absent with explicit setup reporting | NestJS, Worker vars, public Flutter configuration |
| MONGO_URI | Dedicated local replica-set URI/database | NestJS only |
| DEV_SESSION_SECRET | Random secret, at least 32 bytes | NestJS runtime only |
| WS_TICKET_SECRET | Separate random secret, at least 32 bytes | NestJS runtime and Worker secret |
| REALTIME_INTERNAL_SECRET | Separate random secret, at least 32 bytes | NestJS runtime and Worker secret |
| REALTIME_BASE_URL | Actual deployed development Worker HTTPS origin; setup may fill after successful deployment | NestJS runtime; public endpoint returned to Flutter |
| CLOUDFLARE_ACCOUNT_ID | User-supplied account ID | Setup/deployment process only |
| CLOUDFLARE_API_TOKEN | User-supplied restricted deployment token | Setup/deployment process only |
| CLOUDFLARE_WORKER_NAME | Dedicated test name, e.g. `chat-poc-realtime-development` | Setup/deployment process only |
| CLOUDFLARE_ENVIRONMENT | `development` | Setup/deployment process only |
| FLUTTER_API_BASE_URL | Platform-specific reachable local API URL | Public Flutter run configuration |

Generate missing application signing/integration secrets once using a cryptographic RNG, store them locally without printing, and preserve them on subsequent runs. Never generate a fake Cloudflare management token/account ID. Record generated variable names, not their values. A user-populated REALTIME_BASE_URL must not be overwritten if it points elsewhere; report the mismatch instead.

## Worker mapping

Only WS_TICKET_SECRET and REALTIME_INTERNAL_SECRET become Worker runtime secrets. APP_ENV and DATASET_ID become nonsecret Worker vars. USER_REALTIME is a binding declared by the Worker project. Cloudflare management variables remain process-environment inputs to Wrangler and must never enter the Worker bundle, vars, secret payload, or Flutter build.

For local Worker tests the helper can generate ignored `.dev.vars.development` with only the runtime-secret allowlist. For real deployment, use Wrangler's documented secret upload flow. Current docs support uploading a secret file alongside Worker code; validate that against the pinned CLI and use a short-lived private temporary file when needed. ([CF-SECRETS](../SOURCES.md#cf-secrets), [CF-CLI](../SOURCES.md#cf-cli))

## Flutter mapping

Only API_BASE_URL and EXPECTED_DATASET_ID are required public build/run inputs. The server returns the realtime origin/ticket endpoint details. A public local run-config file or dart-defines can be generated. It contains no Cloudflare token, account API key, backend integration secret, or signing secret.

Remember that a physical phone's localhost is the phone, not the development computer. Public means safe to include in a test app, not an invitation to publish a debug endpoint.

## Validation and handling

Validate URLs, UUID dataset ID, environment, required nonempty secrets, and distinct secret values. Do not accept production URLs/targets by convenience. Redact authorization, ticket query values, secret-file contents, and any environment dumps. Do not use shell `source`/`eval` on the .env file; parse it as data and pass an explicit allowed environment to the CLI child process.

Ignore `.env`, `.env.*` except deliberately safe example files, `.dev.vars*`, private temporary secret files, generated local endpoint config, and runtime database files. Do not copy the source .env into the Worker directory. The running NestJS service should not log or use the management credentials simply because they live in the same file.
