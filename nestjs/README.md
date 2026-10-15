# Local NestJS API

The development API owns permanent MongoDB messages, fixed room memberships, and each user's current unread/read state. Cloudflare SQLite Durable Objects own the compact, 48-hour room-list delta buffer. MongoDB stores **no event log or event payloads**.

Use Node 24+, the pinned lockfiles and the repository setup instructions:

```sh
npm --prefix ../shared ci
npm --prefix ../shared run build
npm ci
npm run dev:preflight
npm run db:up
npm run build
npm run db:seed
npm run start:dev
```

For an existing schema-1 demo, stop the old backend and run the explicit migration before starting this version:

```sh
npm run db:migrate:room-sync -- --drop-event-outbox
```

This verifies the configured local dataset, creates missing `room_members`, preserves all rooms and messages, and drops the legacy `event_outbox` collection. Existing messages start as read at migration cutover because the previous schema had no read cursor. Rerunning preserves existing unread state. Routine startup and seeding never perform that deletion and refuse schema 1 until migration.

The ignored, user-controlled `.env` supplies development mode, a dataset UUID, dedicated loopback `chat_poc_*` replica-set MongoDB URI, distinct application secrets and the Worker origin. The process refuses production mode or an unowned nonempty database before collection/index writes. Keep MongoDB on loopback. `HOST=0.0.0.0` is only for explicitly enabled trusted-LAN phone testing; preserve the configured LAN URL when running `npm run start:dev`.

## Terminal logging

Logging is enabled by default for `npm run start:dev`, `npm start` and the local API helper. Nest prints startup/module/route messages. Each completed or aborted HTTP request prints its method, matched route template, status, duration, request ID and safe error code. Malformed/oversized JSON is logged too; unknown paths use `unmatched` instead of echoing submitted URLs. For example:

```text
[HTTP] GET /api/v1/rooms operation=ROOMS_FULL_SNAPSHOT status=200 durationMs=12.3 requestId=<uuid>
[HTTP] POST /api/v1/realtime/ticket status=401 durationMs=1.2 requestId=<uuid> code=UNAUTHORIZED
[RoomSync] Realtime connected user=1 head=30
[RoomSync] Published room states user=1 count=1 head=31
```

Room-list requests have explicit operation tags:

- `operation=ROOMS_FULL_SNAPSHOT`: GET rooms without a paging cursor (initial load, manual refresh or full-sync recovery).
- `operation=ROOMS_PAGE`: GET rooms with a cursor, fetching older rooms.

Check `status=200` for a returned snapshot, or the status/error code for a failed attempt. `requestId` correlates the request. The classifier checks only whether the cursor exists; its value and other query values are never printed. A server response log does not prove that the phone committed the snapshot to SQLite. The tag does not identify the client trigger (first use versus expiry/gap/manual refresh). Short deltas travel through Cloudflare WebSockets and do not produce a NestJS rooms snapshot request.

To filter only full snapshot requests when starting the backend from the repository root:

```sh
npm --prefix nestjs run start:dev 2>&1 | grep 'ROOMS_FULL_SNAPSHOT'
```

The relay reports first failure/error-code changes, recovery and actual publication counts; unchanged failed polls do not flood the terminal. Logs omit request/response bodies, authorization headers, query strings, ticket URLs and raw driver exceptions/stacks. The console logger also redacts configured credentials and bearer/JWT/URL strings. Request error status/code and dependency diagnostics remain available. Test/embedding callers can explicitly pass `createApp(config, {logger:false})` to silence their own application. No `.env` logging setting is required. Startup readiness reads the shared protocol version instead of printing an obsolete version.

A send transaction commits the immutable message, global room preview and every member's current room revision/unread count together. It marks each current membership dirty. A separate per-user relay publishes the latest room state after commit and conditionally clears that revision's dirty marker only after Cloudflare acceptance. Crashes/restarts rescan dirty current state. Many offline messages therefore produce one latest room update, without a MongoDB queue containing their payloads. A 201 means MongoDB committed; Cloudflare may still be unavailable.

Dirty current state is still checked every second. Idle Cloudflare epoch/head reconciliation runs every five minutes, with immediate checks on backend startup or explicit reconciliation. This reduces background Cloudflare requests without slowing ordinary dirty-state publication. Silent replacement/rollback of a stream containing only already-clean rows can take up to five minutes plus request/poll time to discover and repair; socket epoch checks and HTTP snapshot fencing still use current Worker metadata.

`GET /api/v1/rooms` returns the latest 20 user-owned room items, keyset pagination and a synchronization barrier captured from Cloudflare **before** reading the Mongo snapshot. Apply that first-page snapshot with the earlier barrier, then resume deltas; never adopt a later cursor that could skip an intervening change. Further pages are live keyset pages, not an immutable multi-request snapshot. Concurrent room moves converge through deltas.

Opening/reconnecting an active room fetches the latest 30 messages over HTTP. `window` identifies the authoritative sequence range for reconciliation; absent cached canonical rows may be removed only within that range. Older history is fetched in strict `beforeRoomSeq` pages. Reading is explicit through `POST /rooms/:roomId/read`; it monotonically advances only the caller's read cursor and emits their updated room summary to their other devices, without peer read receipts.

```sh
npm run typecheck
npm run format:check
npm test
```

Tests build and run Jest/Supertest against a **real local `rs0` replica set**, default port 27028. Each fixture uses a new `chat_poc_test_*` database/dataset and never resets the development dataset. The Worker transport is replaced in these tests: they prove backend transactions, concurrent unread/read semantics, snapshot barriers, idempotent/coalesced publication, restart and epoch recovery, access controls and explicit migration. They do not prove real Cloudflare or mobile execution.

The approved model remains one NestJS process. `/api/v1/dev/diagnostics` reports only the caller's Worker epoch/head, pending room count, blocked status and dependency health. A missing Worker prevents obtaining a fresh full-sync barrier; MongoDB message writes can still commit and remain recoverable through dirty memberships. API credentials, ticket credentials and Worker integration credentials remain separate; management credentials never enter Flutter or Worker runtime.
