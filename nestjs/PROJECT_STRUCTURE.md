# NestJS project structure and boundaries

```text
src/
  main.ts / app.ts / app.controller.ts
  config/          Parsed runtime allowlist and development/local-database guards
  common/          Strict input validation and error mapping
  database/        Dataset identity, schema-2 models, indexes and seed
  dev-session/     Selection sessions, ticket signing and bearer guard
  rooms/           Membership-scoped room reads, creation and snapshot paging
  messages/        Atomic sends, HTTP history windows and own-account read cursor
  room-sync/       Coalesced current-state relay, retries and recovery
  realtime/        Authenticated Worker HTTP client and presence
scripts/
  migrate-room-sync.mjs  Explicit owned-dataset schema-1 migration
  database.mjs / environment.mjs / setup.mjs / preflight.mjs
```

Controllers validate wire inputs and remain thin. RoomsService starts user-list reads from room_members. MessagesService owns complete send/read transactions; RoomProjectionDispatcher independently publishes current state after commit. RealtimeClient knows only internal application credentials and deadlines, never Cloudflare management credentials. Worker runtime/storage code is not imported into NestJS.

Initialization validates configuration, Mongo replica-set identity and owned dataset schema before indexes/seeding; only then can the relay bootstrap. A degraded Worker does not prevent Mongo message commits. Shutdown stops scheduling and waits for bounded per-user in-flight work before closing Mongo. Tests replace the Worker network boundary while retaining real Mongo transactions.
