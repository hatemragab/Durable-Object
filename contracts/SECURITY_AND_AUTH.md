# Development identity and integration security

This POC intentionally permits selecting any of three test accounts. It provides **no real end-user authentication**. The signed tokens prevent accidental/unauthorized use of the Internet-facing Worker, not impersonation by somebody who can already call the local development account-selector API. Use synthetic messages only.

## Development session

NestJS accepts `POST /api/v1/dev/session` with a seeded user ID and installation device ID. It validates `APP_ENV=development` and the ID allowlist, then issues a 24-hour signed session token. Required claims: issuer `chat-poc-nestjs`, audience `chat-poc-api`, subject equal to the user ID, `deviceId`, `datasetId`, `iat`, `exp`, and `jti`. Use HS256 with `DEV_SESSION_SECRET`, distinct from every other secret.

All room, message, realtime-ticket, and presence REST APIs require that token. Derive user/device identity from its verified claims, not an arbitrary header or request body's sender field. The API token is held in Flutter memory; if it expires or the app restarts, the same account can be selected again without a login UI. Cached data and pending sends survive without a token.

## WebSocket ticket

NestJS issues a 60-second HS256 ticket through its authenticated realtime-ticket endpoint. Claims: issuer `chat-poc-nestjs`, audience `chat-poc-realtime`, subject, deviceId, datasetId, `iat`, `exp`, `jti`, and `sessionExp` matching the longer API session expiry. Sign using `WS_TICKET_SECRET`, which is shared only by NestJS and the Worker runtime.

Flutter connects to `/v1/ws?ticket=<short-lived-ticket>`. Redact that query parameter in application logs, error reports, proxy traces, and setup output. Use WSS for the real Cloudflare endpoint. This portable query-ticket mechanism avoids depending on native-only custom WebSocket headers.

The Worker verifies signature, algorithm allowlist, issuer, audience, expiry/skew, sessionExp, user allowlist, and dataset before reaching a user object. It routes by the **verified** user ID. Strip client-supplied internal identity headers and create a trusted routing context. Do not trust a URL user ID, parse-only JWT decoding, or a forwarded claim supplied by the client.

A ticket is short-lived, **not single-use** in v1. Enforcing one-time consumption would require additional storage/protocol work and is intentionally excluded. The 60-second expiry is checked at upgrade, not used to disconnect an already accepted socket. The socket's authorization ends at `sessionExp`; its alarm and message handlers enforce that deadline.

## Backend-to-Worker integration

Use `REALTIME_INTERNAL_SECRET` as a separate long, random bearer token for Worker `/internal/v1/*` routes. Flutter never receives it. Require a dataset header matching the configured dataset and validate path/user/body consistency. Public WebSocket tickets may not call internal append, stream-inspection, or presence-query endpoints.

Internal object-to-object presence notifications use a binding call/private handler, not an unauthenticated public URL. Do not expose an arbitrary SQL executor, arbitrary object-name router, reset endpoint, or user-provided callback URL.

## Management credential boundary

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are setup/deployment inputs only. A setup helper may read them from `nestjs/.env` for Wrangler, but the running NestJS integration uses the Worker URL and internal secret. The API token is never a Worker secret and never a Flutter define. Scope it to the intended account and the permissions needed for test Worker deployment. Do not use the global account API key.

Use a maintained JWT library rather than custom signing code. `jose` documents Node and Cloudflare Worker runtime support; its module requirements still need validation in the selected build. ([JOSE](../SOURCES.md#jose))

## Lifecycle and limits

On a switch, close only this installation's old account socket, cancel its work, and clear its in-memory tokens. Other devices of that account remain connected. Expired/tampered tickets and malicious identity headers must have negative tests. Add conservative app-level connection/request controls appropriate for three users, but do not describe those as complete Internet abuse protection.

The dev Worker endpoint is Internet-addressable. Keep the local account-selection backend on loopback or a trusted LAN, without a public tunnel. These credentials and restrictions do not make the application production-ready.
