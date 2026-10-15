# Flutter project structure

```text
flutter/
  AGENTS.md and specification documents
  lib/
    main.dart
    app.dart
    core/
      config/                 Public endpoint/dataset configuration
      database/               App metadata DB, account DB, migrations
      network/                REST transport and reachability state
      realtime/               WebSocket transport, frames, reconnect manager
      lifecycle/              Foreground/account-generation coordination
      errors/                 Typed errors and user-visible mapping
    features/
      account/
        data/                 Dev-session repository
        application/          Account controller/providers
        presentation/         Three-account picker
      chat/
        domain/               UserSummary, RoomDto, MessageDto and local states
        data/                 DAOs, reducers, repositories, outgoing queue
        application/          Room/message/creation/send controllers
        presentation/
          pages/              Chat list, create direct/group, messages
          widgets/            Required bubble/composer adapters, status icons
      presence/
        application/          Ephemeral presence map/freshness controller
      diagnostics/
        presentation/         Small development details sheet
  test/
  integration_test/
  android/ and ios/
  pubspec.yaml and pubspec.lock
```

Feature-first organization is sufficient. Keep pure domain/contract parsing independent of Flutter widgets; test reducers without starting a UI. Use the built-in Navigator and a single app theme. The directory names are the expected ownership boundaries, not a requirement to create empty files for every possible layer.

## Core interfaces

`ChatRepository`: cached rooms/messages queries, canonical entity merges, batch reduction, outgoing enqueue/retry, cursor read. It owns SQLite access and post-commit invalidation signals.

`RealtimeConnectionManager`: exactly one active socket generation, ticket acquisition, hello/resume, heartbeat/reconnect, serial batch processing, presence frame routing. It delegates all durable application to ChatRepository.

`OutgoingDispatcher`: one active send request overall for the selected account; uses persisted original client IDs; does not require the WebSocket to be connected.

`DevSessionRepository`: list/select/renew the test account and issue tickets. Tokens remain in memory; account data persists separately.

`PresenceController`: an ephemeral source-user map with freshness and unknown state; never part of the durable message reducer.

## Dependency rules

Data layer may depend on transport, database, and pure contract types. Application controllers coordinate repositories and lifecycle. Presentation depends on providers and adapters. Socket callbacks never append directly to a widget list. Required UI package types stay inside widget adapters rather than becoming database models.
