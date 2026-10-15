# Flutter development client

Android/iOS development client using Flutter **3.47.6**, Dart **3.13.5**, Riverpod and native SQLite. Direct dependencies and the complete lockfile remain pinned.

Protocol v2 synchronizes the **room list only** over Cloudflare WebSockets. Each room snapshot is specific to the selected user and includes its preview, personal `revision`, `unreadCount` and `lastReadSeq`. Message bodies are fetched through HTTP when the room is opened, the app reconnects with that room open, or that room changes. No Redis or durable message-event replay is used.

## Run and validate

Start MongoDB and NestJS using the root runbook, then from this directory:

```sh
flutter pub get
flutter run -d 3CC14436-EC3C-4419-A079-C84951E5FA07 --dart-define-from-file=config.local.json
flutter analyze --no-pub
flutter test --no-pub
flutter build ios --simulator --debug --no-codesign --dart-define-from-file=config.local.json
flutter build apk --debug --dart-define-from-file=config.local.json
```

`config.local.json` contains public values only: `API_BASE_URL` (including `/api/v1`) and `EXPECTED_DATASET_ID`. It is ignored. No management credential, signing secret or internal publish secret belongs in Flutter configuration. The default public API URL is `http://127.0.0.1:3000/api/v1`. Release mode refuses development account selection.

Agent-run device/UI testing uses only the existing iPhone 17 Pro, iOS 26.0 simulator with explicit UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`, unless the user authorizes another target. This protocol change was validated with host unit/widget tests and static analysis; earlier native/cloud receipts describe protocol v1 and do not validate v2. Native integration sources have been adapted, but current v2 native/device results must be recorded separately in the root status report.

## Room synchronization

The account database persists the stream epoch, committed coverage cursor, server-issued synchronization time and older-room continuation. Batch application never substitutes the phone clock for that server time. First use, a baseline at least 48 hours old, a changed epoch, expired Cloudflare coverage or a detected gap obtains `GET /rooms?limit=20`. The first page replaces cached room rows while retaining message caches and outgoing intents. Its synchronization barrier was captured before MongoDB read the snapshot; the socket resumes from that barrier. Later 20-room pages merge room snapshots and persist their continuation without advancing the stream cursor.

Cloudflare keeps at most the latest room update per room within its 48-hour retention window. Consequently a batch can skip sequence numbers or contain no room rows while covering a sequence interval. SQLite applies room snapshots and advances the coverage cursor in one transaction before the client ACKs. A different epoch or missing coverage triggers a new HTTP snapshot. Cursor metadata is bounded; the client does not maintain an everlasting `applied_events` journal.

Rooms merge by personal `revision`, independently of global room `version`. A stale snapshot cannot roll back unread state, and conflicting equal revisions are rejected. Account databases, requests, sockets and pending sends remain isolated by dataset/account. Switching accounts waits for captured local work before closing its database.

## Monitor room sync on Android

Debug builds print `[RoomSyncClient]` lines in the phone's Flutter logs. With the currently authorized Android device connected, watch them from a separate terminal:

```sh
"$HOME/Library/Android/sdk/platform-tools/adb" -s 44458219 logcat -v time -s flutter:I | grep 'RoomSyncClient'
```

Use the device ID from `flutter devices` if the connected device changes. These logs come from the phone, so they do not appear in the NestJS terminal. The command can also show older lines still in Android's log buffer; check their timestamps.

The usual delta sequence is `DELTA_RESUME_SENT` → `DELTA_SYNC_STARTED` → `DELTA_RECEIVED` → `DELTA_SQLITE_COMMITTED` → `DELTA_ACK_SENT` → `DELTA_SYNC_READY`. A live update starts at `DELTA_RECEIVED phase=live`. Each batch logs its ID, coverage boundaries and `rowsInBatch` (room-state rows, not messages). `savedCursor` advances only after successful local persistence. Sparse or empty batches can still advance coverage.

`DELTA_RECEIVED` alone does not prove a save. `DELTA_SQLITE_COMMITTED` confirms the repository transaction completed before ACK; `DELTA_ALREADY_SAVED` identifies duplicate coverage. `DELTA_ACK_SENT` means the phone sent its acknowledgement, not that Cloudflare received it or a person read a message. A failed transaction logs `DELTA_SAVE_FAILED` and sends no ACK. If the connection retires during a successful save, `DELTA_ACK_SKIPPED reason=CONNECTION_RETIRED` explains why that save has no ACK.

Full snapshots log `FULL_SNAPSHOT_REQUESTED`, `FULL_SNAPSHOT_RECEIVED`, then `FULL_SNAPSHOT_SQLITE_COMMITTED`; failure logs `FULL_SNAPSHOT_FAILED`. The request includes `limit=20` and a reason:

| Reason | Meaning |
| --- | --- |
| `FIRST_USE` | This account has no local synchronization baseline. |
| `BASELINE_EXPIRED_48H` | The last server-issued baseline is at least 48 hours old. |
| `EPOCH_CHANGED` | Cloudflare's stream epoch differs from the saved epoch. |
| `CURSOR_EXPIRED` | Cloudflare no longer has the required retained coverage. |
| `CURSOR_AHEAD` | The saved cursor is ahead of Cloudflare's stream. |
| `DELTA_TOO_LARGE` | Cloudflare requires a snapshot instead of a large replay. |
| `COVERAGE_GAP` | The phone detected missing stream coverage while applying a batch. |
| `MANUAL_REFRESH` | The room list was refreshed manually. |
| `SERVER_REQUIRED` | The server required a snapshot without a recognized detailed reason. |

`FULL_SNAPSHOT_REQUIRED` records the server/local trigger when present; `FULL_SNAPSHOT_REQUESTED` records the actual HTTP request attempt. NestJS separately logs `operation=ROOMS_FULL_SNAPSHOT` for that request. Diagnostics contain counters and validated metadata, with no message bodies, room titles, tickets, authorization headers or raw errors. They are disabled outside Debug mode.

## Messages and unread state

Opening a room shows cached rows immediately, then fetches the latest 30 messages. Older history uses `beforeRoomSeq` with 30-message pages. HTTP responses include an authoritative `window` interval. The reducer removes missing canonical rows only inside that interval, preserving pending sends, older cached history and rows newer than the response boundary. An empty room uses the valid empty interval `1..0`.

SQLite also tracks the currently verified message range. If a device cached messages 1–30 and reconnects to a latest window of 101–130, it displays 101–130 and fetches intervening history through HTTP; it does not present the disconnected old cache as contiguous history. Old rows remain cached. Only overlapping or adjacent history pages extend the verified range.

Open-room refresh is serialized with a dirty follow-up when another update arrives during the current request. Closed rooms receive summaries without downloading message bodies. HTTP POST responses or history confirmation reconcile outgoing rows by canonical message ID and `(senderId, clientMessageId)`; room previews do not confirm sends. Composer text clears only after the outgoing intent has been committed locally.

Unread badges use the server's personal room snapshot. After layout, the message page checks which committed message bubbles overlap its viewport and sends `POST /rooms/:id/read` with the highest displayed `throughRoomSeq`. Requests coalesce, the backend advances the read boundary monotonically, and responses from a closed room or retired account cannot clear another room. This is account unread state; there are no peer read receipts.

Pin/mute controls, message edits, delete-for-me, delete-for-everyone and room hiding remain future features. Current bounded reconciliation is prepared to remove absent rows within an authoritative HTTP window; it does not detect an old deletion outside fetched windows. Those features need explicit mutation/version/tombstone contracts before implementation.

## Manual testing on a physical phone

Keep the Mac and phone on the same Wi-Fi network with MongoDB and NestJS running. The configured LAN API address is `http://192.168.1.131:3000/api/v1`; the WebSocket origin is issued by NestJS. Open `http://192.168.1.131:3000/api/v1/health` in the phone's browser first. A physical phone must use the Mac's LAN address rather than `localhost`.

For an iPhone, connect by USB, trust the Mac and enable Developer Mode. Use the existing signing team if Xcode requests provisioning, allow the Local Network prompt, then explicitly select the physical device ID from `flutter devices`:

```sh
flutter run --debug -d "YOUR_AUTHORIZED_PHYSICAL_PHONE_DEVICE_ID" --dart-define-from-file=config.local.json
```

See [Flutter's iOS setup](https://docs.flutter.dev/platform-integration/ios/setup), [iOS debugging](https://docs.flutter.dev/platform-integration/ios/ios-debugging), and [Apple local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

Debug Xcode configuration supplies `CHAT_POC_LAN_HOST=192.168.1.131`. The existing bundle phase adds an HTTP ATS exception for that exact IP in Debug only. Release/Profile have no HTTP exception or global TLS bypass. If DHCP changes the Mac IP, update the public Flutter configuration and `ios/Flutter/Debug.xcconfig`, then rebuild. Android Debug already permits local HTTP; enable USB debugging, approve the phone's prompt, and select its authorized device ID explicitly. These manual instructions do not authorize an agent to substitute another device automatically.

Test with two installations/accounts: new-message previews and unread counts, opening/reading a room on one device and observing its badge clear on another, offline short-gap room recovery, and latest-30 HTTP reconciliation after a large message gap. Stop only NestJS to test the persisted outgoing queue, then restart it and verify one canonical message. Longer than 48-hour and deleted-event recovery require a fresh room snapshot; cached messages remain available while the API is unavailable.

## Required composer package patch

`packages/v_chat_input_ui/` vendors the **official pub.dev 3.4.2** library sources and original MIT license. Original source: https://pub.dev/packages/v_chat_input_ui/versions/3.4.2 ; repository: https://github.com/v-chat-sdk/v_chat_input_ui . The bubble package remains official hosted `v_chat_bubbles` **2.2.0**.

Upstream `VMessageInputWidget.onSubmitText` is a `ValueChanged<String>` and `_submitCurrentValue` invokes it, then immediately clears its private controller. Its public controller exposes panel actions only. Consequently the unmodified package cannot await a native SQLite write before clearing a draft.

The single modified Dart source is `lib/src/input/message_input_widget.dart`: change the callback to `FutureOr<void> Function(String)`; guard duplicate submissions; await successful consumer persistence; clear only if the current draft still equals the submitted draft; preserve input on a consumer-reported failure. The app adapter reports that failure visibly. The vendor pubspec removes publishing screenshot references whose images are not needed at runtime. All other library files are unchanged. Regression widget tests verify delayed success, failed storage, duplicate submit suppression, exact Unicode/whitespace content and a new draft typed during persistence. This patch is local; the global pub cache is untouched.

Both required packages carry native media/map dependencies even with non-text actions disabled. No media permissions, location keys, notification/background modes or media upload handlers are configured. Android manifest merger rules remove the unused camera/microphone/storage/location permissions inherited from plugins. Android compilation uses SDK 37 because the required transitive permission-handler plugin needs it; target SDK 36 and minimum SDK 24 remain the inspected Flutter defaults. Debug Android builds permit local HTTP for the developer's backend; release is unsupported. iOS simulator build resolves the native dependencies through SPM and CocoaPods; plugin SPM-adoption warnings are documented build output, not removed package features.

## Native probes

After the matching v2 backend and Worker are available, the explicit simulator smoke command is:

```sh
flutter test integration_test/app_smoke_test.dart \
  -d 3CC14436-EC3C-4419-A079-C84951E5FA07 \
  --dart-define-from-file=config.local.json --no-pub
```

For a deployed development Worker, add `--dart-define=REQUIRE_CLOUD_REALTIME=true` and `--dart-define=EXPECTED_REALTIME_ORIGIN=<verified HTTPS Worker origin>`. The probe checks issued and actually used endpoints, HTTP message confirmation, advancing room-stream coverage, navigation and account storage isolation. Endpoint reports omit ticket queries.

The restart and OS lifecycle probes under `integration_test/` retain their explicit marker/operator-controller workflow. Their v2 sources now assert room-state replay and HTTP message windows rather than a permanent client event journal. They have not been executed for this change. Host tests use real SQLite through `sqflite_common_ffi`, injected API/socket transports, widget rendering and virtual clocks; they are not native device or real Cloudflare proof.
