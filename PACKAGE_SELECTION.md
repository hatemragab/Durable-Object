# Package selection and toolchain policy

Prefer small adapters around maintained packages rather than adding a full chat framework. The versions of the two user-selected widgets below were observed on their official package pages on 15 October 2026; recheck dependency resolution during implementation. Other dependencies should be pinned to compatible resolved releases in application lockfiles, not guessed here.

## Flutter

| Package/tool | Role and constraint |
|---|---|
| Flutter 3.47+ | User-required SDK baseline; verify the installed SDK and bundled Dart version |
| `flutter_riverpod` | Manually declared providers and Notifier/AsyncNotifier controllers; no code-generation requirement |
| `sqflite` + `path` | Android/iOS local SQLite, migrations and transactions; repositories publish query invalidations |
| `web_socket_channel` | Standard WebSocket transport; implement this project's reconnect/replay policy above it |
| `dio` | REST requests, cancellation, timeouts; never let generic retries change idempotency keys |
| `uuid` | Persisted installation/device ID and stable outgoing client message/request IDs |
| `connectivity_plus` | Optional network-change trigger only; not proof that either server is reachable |
| `v_chat_bubbles` **2.2.0 observed** | Required text bubble rendering through a thin app adapter |
| `v_chat_input_ui` **3.4.2 observed** | Required text composer; disable all non-text actions |
| `sqflite_common_ffi` | Optional desktop-host unit-test SQLite adapter, not a new desktop product target |

The bubble/composer pages state minimum Flutter 3.44 and Dart 3.12. Those are package requirements, not a claim that any uninspected SDK installation meets them. The user's higher target still requires a real resolution/build check. ([PKG-BUBBLES](SOURCES.md#pkg-bubbles), [PKG-INPUT](SOURCES.md#pkg-input))

Riverpod supports a no-code-generation setup. SQLite transactions and platform support are described by sqflite; web_socket_channel provides a transport API rather than a full chat delivery protocol. ([PKG-RIVERPOD](SOURCES.md#pkg-riverpod), [PKG-SQLITE](SOURCES.md#pkg-sqlite), [PKG-WS](SOURCES.md#pkg-ws))

Do not add Freezed, a routing framework, a second local database, a full V Chat SDK, or reactive database generators just for this POC. Use the built-in Navigator. A tiny app-metadata SQLite database can persist the device ID and previously selected account; no preferences plugin is required. Tokens can remain in memory and be reissued after account selection when online.

## NestJS and shared contracts

Use NestJS core, ConfigModule, Mongoose integration, class-validator/class-transformer or an equivalent consistently applied DTO validator, and one JWT implementation. `jose` is suitable for JWT creation/verification across Node and Workers; verify its module/runtime requirements against the selected NestJS build. Use native fetch with an abort timeout for the Worker integration. ([NEST-MONGO](SOURCES.md#nest-mongo), [JOSE](SOURCES.md#jose))

Use Jest and Supertest for backend tests. A real isolated Mongo replica set or a replica-set-capable test helper is necessary for transaction tests; an in-memory mock of save() is not sufficient evidence.

## Cloudflare

Use TypeScript, Wrangler, generated Worker runtime types, native SQL storage, and Cloudflare's Vitest integration. Keep the Worker free of Node-only backend imports. A small environment-neutral TypeScript contract package may be shared. Cloudflare documents runtime-aware testing helpers; use them instead of mocking every Durable Object behavior. ([CF-TEST](SOURCES.md#cf-test))

## Package verification gate

Before building all screens, compile a minimal text bubble and text-only composer against the resolved package versions. Verify the real constructor signatures, callback types, disabled-action behavior, and native platform build requirements. The input package carries native transitive plugins even when features are disabled: do not assume disabling a button removes its build dependencies. Do not add microphone/camera/location permissions or keys merely to satisfy unused UI features.
