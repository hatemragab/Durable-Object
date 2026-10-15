# Sources and verification notes

**Reference check date: 15 October 2026.** These are official platform documentation, official package pages, or maintainer sources. The archive contains an original project design, not a copy of these sources.

Platform and package statements cite the IDs below. Sequence allocation, ACK rules, presence policies, replay limits, folder structure, task lists, and test cases are project decisions. None of the sources establishes that this particular project has been built or tested.

Exact dependency resolution, CLI compatibility, actual account plan, platform builds, and runtime behavior must be rechecked by the implementing agent. The user supplied the Flutter 3.47+ target; an actual installed SDK was not inspected during this documentation task.

<a id="cf-start"></a>
## CF-START: Cloudflare: Getting started with Durable Objects
`https://developers.cloudflare.com/durable-objects/get-started/`

Worker-to-object binding, SQLite-backed class setup, and development deployment.

<a id="cf-exports"></a>
## CF-EXPORTS: Cloudflare: Durable Object class exports
`https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/`

Current declarative exports flow; legacy migrations are distinct. The current page title differs from its legacy URL path.

<a id="cf-env"></a>
## CF-ENV: Cloudflare: Durable Object environments
`https://developers.cloudflare.com/durable-objects/reference/environments/`

Named-environment isolation and non-inherited bindings.

<a id="cf-storage"></a>
## CF-STORAGE: Cloudflare: SQLite-backed Durable Object Storage
`https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/`

Private SQL storage, synchronous transactions, storage API behavior.

<a id="cf-state"></a>
## CF-STATE: Cloudflare: Durable Object State
`https://developers.cloudflare.com/durable-objects/api/state/`

Hibernation socket attachment/enumeration, auto-response, and timestamp APIs.

<a id="cf-ws"></a>
## CF-WS: Cloudflare: Use WebSockets
`https://developers.cloudflare.com/durable-objects/best-practices/websockets/`

Hibernation lifecycle, handler model, and reconstruction using attachments.

<a id="cf-alarm"></a>
## CF-ALARM: Cloudflare: Alarms
`https://developers.cloudflare.com/durable-objects/api/alarms/`

Alarm API and retry/idempotency considerations. Timing defaults in this pack are project choices.

<a id="cf-test"></a>
## CF-TEST: Cloudflare: Vitest integration test APIs
`https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/`

Runtime-aware helpers for Worker and Durable Object tests.

<a id="cf-secrets"></a>
## CF-SECRETS: Cloudflare: Worker secrets
`https://developers.cloudflare.com/workers/configuration/secrets/`

Local versus deployed secrets, allowlisting, and secret-file upload with code.

<a id="cf-cli"></a>
## CF-CLI: Cloudflare: Wrangler commands
`https://developers.cloudflare.com/workers/wrangler/commands/`

CLI reference; verify flags against the installed/pinned version.

<a id="cf-pricing"></a>
## CF-PRICING: Cloudflare: Durable Objects pricing
`https://developers.cloudflare.com/durable-objects/platform/pricing/`

Detailed Free-plan quotas and accounting. Prefer this platform page to abbreviated marketing tables.

<a id="cf-limits"></a>
## CF-LIMITS: Cloudflare: Durable Objects limits
`https://developers.cloudflare.com/durable-objects/platform/limits/`

Per-object Free/Paid storage ceilings and other platform constraints.

<a id="mdb-txn"></a>
## MDB-TXN: MongoDB: Transaction production considerations
`https://www.mongodb.com/docs/manual/core/transactions-production-consideration/`

Transaction deployment requirements; standalone MongoDB is not adequate for this plan.

<a id="mdb-dev"></a>
## MDB-DEV: MongoDB: Replica sets for testing and development
`https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set-for-testing/`

Development replica-set setup guidance; the agent must verify its own container/host connectivity.

<a id="mgo-txn"></a>
## MGO-TXN: Mongoose: Transactions
`https://mongoosejs.com/docs/transactions.html`

Session-bound transaction operations and warnings against parallel operations within a transaction.

<a id="nest-mongo"></a>
## NEST-MONGO: NestJS: MongoDB integration
`https://docs.nestjs.com/techniques/mongodb`

Mongoose model/provider integration with NestJS.

<a id="pkg-riverpod"></a>
## PKG-RIVERPOD: Riverpod: Getting started
`https://riverpod.dev/docs/introduction/getting_started`

Provider setup; code generation is not mandatory.

<a id="pkg-sqlite"></a>
## PKG-SQLITE: sqflite: official package page
`https://pub.dev/packages/sqflite`

Android/iOS SQLite support and transaction API.

<a id="pkg-ws"></a>
## PKG-WS: web_socket_channel: official package page
`https://pub.dev/packages/web_socket_channel`

Standard WebSocket stream/sink and readiness API.

<a id="pkg-bubbles"></a>
## PKG-BUBBLES: v_chat_bubbles: official package page
`https://pub.dev/packages/v_chat_bubbles`

Observed release 2.2.0; text bubble/scope APIs and published SDK requirements.

<a id="pkg-bubble-status"></a>
## PKG-BUBBLE-STATUS: v_chat_bubbles: VMessageStatus API
`https://pub.dev/documentation/v_chat_bubbles/latest/v_chat_bubbles/VMessageStatus.html`

Documented sending/sent/delivered/read/error values; this POC deliberately does not use delivered/read.

<a id="pkg-input"></a>
## PKG-INPUT: v_chat_input_ui: official package page
`https://pub.dev/packages/v_chat_input_ui`

Observed release 3.4.2; text composer, independent feature switches, local callbacks, and published SDK requirements.

<a id="pkg-dio"></a>
## PKG-DIO: dio: official package page
`https://pub.dev/packages/dio`

REST transport, cancellation and timeout reference.

<a id="pkg-connectivity"></a>
## PKG-CONNECTIVITY: connectivity_plus: official package page
`https://pub.dev/packages/connectivity_plus`

Network connectivity changes are not proof of endpoint or Internet reachability.

<a id="pkg-uuid"></a>
## PKG-UUID: uuid: official package page
`https://pub.dev/packages/uuid`

Client UUID generation.

<a id="jose"></a>
## JOSE: jose: maintainer repository
`https://github.com/panva/jose`

JWT/JWS implementation and supported Node/Web-interoperable runtimes.

<a id="flutter-lifecycle"></a>
## FLUTTER-LIFECYCLE: Flutter: AppLifecycleState
`https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html`

Foreground/background states, observers, and missing termination notifications.

<a id="android-net"></a>
## ANDROID-NET: Android: Emulator networking
`https://developer.android.com/studio/run/emulator-networking`

Host-loopback alias and emulator connectivity behavior.

<a id="android-sec"></a>
## ANDROID-SEC: Android: Network security configuration
`https://developer.android.com/privacy-and-security/security-config`

Debug/local-network HTTP policy guidance; never disable production TLS validation.

<a id="apple-lan"></a>
## APPLE-LAN: Apple: NSLocalNetworkUsageDescription
`https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription`

Official setup reference for local-network usage text. The page is JavaScript-rendered; the agent must inspect actual platform guidance and test its device configuration.
