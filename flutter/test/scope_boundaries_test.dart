import 'dart:async';
import 'dart:io';

import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/api.dart';
import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:durable_chat_demo/core/storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'session_test.dart' show TestApi, TestSocket;
import 'storage_test.dart'
    show batch, eventRoom, eventMessage, fixture, testSync;

const alternateDataset = '90000000-0000-4000-8000-000000000099';

Future<void> until(Future<bool> Function() condition, String reason) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (DateTime.now().isBefore(deadline)) {
    if (await condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('Timed out: $reason');
}

Future<Map<String, List<Map<String, Object?>>>> snapshot(
  ChatRepository repo,
) async {
  final tables = await repo.db.rawQuery(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return {
    for (final table in tables)
      table['name']! as String: await repo.db.query(
        table['name']! as String,
        orderBy: 'rowid',
      ),
  };
}

Future<void> resume(
  AccountSession session,
  TestSocket socket, {
  required int after,
  required int head,
  String? user,
}) async {
  final hello = object(fixture('hello-and-resume')['hello']);
  hello['headSeq'] = head;
  if (user != null) hello['userId'] = user;
  socket.frame(hello);
  await until(() async => session.state == 'resuming', 'hello accepted');
  await until(
    () async => socket.sent.any((raw) => raw.contains('"resume"')),
    'resume emitted',
  );
  socket.frame({
    'v': 2,
    'type': 'sync.started',
    'afterSeq': after,
    'targetSeq': head,
  });
  await until(() async => session.state == 'replaying', 'resume accepted');
}

class GatedRepository extends ChatRepository {
  GatedRepository(ChatRepository original)
    : super(original.db, original.dataset, original.user);
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<int> applyBatch(Json value) async {
    if (!entered.isCompleted) entered.complete();
    await release.future;
    return super.applyBatch(value);
  }
}

class GatedStorage extends LocalStorage {
  GatedStorage(String path)
    : super(factory: databaseFactoryFfi, directory: path);
  GatedRepository? delayed;
  @override
  Future<ChatRepository> account(String dataset, String user) async {
    final original = await super.account(dataset, user);
    if (user == '2' && delayed == null) {
      delayed = GatedRepository(original);
      return delayed!;
    }
    return original;
  }
}

class ScopedApi extends ApiClient {
  ScopedApi(super.config, super.user, super.device, {this.room});
  final Room? room;
  final sends = <Json>[];
  @override
  Future<void> session({bool force = false}) async {}
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    if (path == '/realtime/ticket') {
      return {
        'datasetId': config.dataset,
        'url': 'ws://localhost/v1/ws',
        'ticket': 'synthetic-test-ticket',
      };
    }
    if (path == '/rooms') {
      return {
        'datasetId': config.dataset,
        'rooms': [],
        'sync': testSync(),
        'nextCursor': null,
      };
    }
    if (method == 'POST' && path.endsWith('/messages')) {
      sends.add({
        'datasetId': config.dataset,
        'apiUrl': config.apiBaseUrl,
        'path': path,
        ...data!,
      });
      if (room == null || path != '/rooms/${room!.id}/messages') {
        throw const ChatFailure(
          'ROOM_FORBIDDEN',
          'Unexpected room in this test API.',
        );
      }
      const created = '2026-10-15T00:00:00.000Z';
      const serverId = '30000000-0000-4000-8000-000000000099';
      final message = {
        'id': serverId,
        'roomId': room!.id,
        'senderId': user,
        'originDeviceId': device,
        'clientMessageId': data['clientMessageId'],
        'roomSeq': 1,
        'type': 'text',
        'text': data['text'],
        'createdAt': created,
      };
      final acceptedRoom = {
        ...room!.json,
        'version': 2,
        'revision': 2,
        'lastMessageSeq': 1,
        'lastMessage': {
          'messageId': serverId,
          'senderId': user,
          'text': data['text'],
          'roomSeq': 1,
          'createdAt': created,
        },
      };
      return {
        'datasetId': config.dataset,
        'room': acceptedRoom,
        'message': message,
        'duplicate': false,
      };
    }
    throw StateError('Unexpected public request in scoped API: $path');
  }
}

void main() {
  sqfliteFfiInit();

  test('wrong-dataset durable batch preserves every account table and emits no ACK', () async {
    final directory = await Directory.systemTemp.createTemp(
      'chat-wrong-dataset-',
    );
    final storage = LocalStorage(
      factory: databaseFactoryFfi,
      directory: directory.path,
    );
    final repo = await storage.account(defaultDataset, '2');
    final socket = TestSocket();
    final runtime = AccountSession(
      repository: repo,
      api: TestApi(),
      onChanged: () {},
      socketFactory: (_) => socket,
    );
    try {
      await repo.replaceRoomSnapshot([], testSync());
      await repo.applyBatch(fixture('replay-batch-1-4'));
      await repo.enqueue(
        eventRoom('direct-room-created').id,
        'Keep this account-local intent.',
      );
      // Connect directly to isolate incoming validation while preserving an undrained queue.
      await runtime.connect();
      await resume(runtime, socket, after: 4, head: 4);
      socket.frame({'v': 2, 'type': 'sync.ready', 'throughSeq': 4});
      await until(
        () async => runtime.state == 'live',
        'initial replay complete',
      );
      final before = await snapshot(repo);
      final corrupt = fixture('duplicate-batch-1-4');
      for (final raw in corrupt['events'] as List) {
        object(raw)['datasetId'] = alternateDataset;
      }
      socket.frame(corrupt);
      await until(
        () async => runtime.state == 'blocked',
        'dataset mismatch visible',
      );
      expect(await snapshot(repo), before);
      expect(await repo.cursor(), 4);
      expect(socket.sent.where((raw) => raw.contains('"ack"')), isEmpty);
      expect(runtime.diagnostic, contains('identity/protocol mismatch'));
    } finally {
      await runtime.dispose();
      await storage.close();
      await directory.delete(recursive: true);
    }
  });

  test('delayed replay released after account switch commits only into its captured database', () async {
    final directory = await Directory.systemTemp.createTemp(
      'chat-delayed-replay-',
    );
    final storage = GatedStorage(directory.path);
    final sockets = <TestSocket>[];
    final container = ProviderContainer(
      overrides: [
        storageProvider.overrideWithValue(storage),
        apiFactoryProvider.overrideWithValue((_, _, _) => TestApi()),
        socketFactoryProvider.overrideWithValue((_) {
          final socket = TestSocket();
          sockets.add(socket);
          return socket;
        }),
      ],
    );
    ChatRepository? reopened;
    try {
      final controller = container.read(accountProvider.notifier);
      await controller.select('2');
      final previous = container.read(accountProvider).session!;
      await until(() async => sockets.length == 1, 'first account socket');
      await resume(previous, sockets.first, after: 0, head: 4);
      sockets.first.frame(fixture('replay-batch-1-4'));
      await storage.delayed!.entered.future;
      final switching = controller.switchAccount();
      final selecting = controller.select('3');
      expect(container.read(accountProvider).session, isNull);
      expect(container.read(accountProvider).loading, isTrue);
      storage.delayed!.release.complete();
      await switching;
      await selecting;
      final current = container.read(accountProvider).session!;
      expect(current.repository.user, '3');
      expect(previous.repository.db.isOpen, isFalse);
      expect(current.repository.db.isOpen, isTrue);
      expect(await current.repository.rooms(), isEmpty);
      expect(await current.repository.cursor(), 0);
      expect(await current.repository.counts(), {'queued': 0, 'failed': 0});
      expect(sockets.first.sent.where((raw) => raw.contains('"ack"')), isEmpty);
      reopened = await storage.account(defaultDataset, '2');
      expect(await reopened.cursor(), 4);
      expect((await reopened.rooms()).length, 2);
      await reopened.close();
      reopened = null;
      await controller.switchAccount();
    } finally {
      if (storage.delayed != null && !storage.delayed!.release.isCompleted) {
        storage.delayed!.release.complete();
      }
      await reopened?.close();
      await container.read(accountProvider.notifier).switchAccount();
      container.dispose();
      await storage.close();
      await directory.delete(recursive: true);
    }
  });

  test('new configured dataset dispatches only its own queue and retains the old dataset intent', () async {
    final directory = await Directory.systemTemp.createTemp(
      'chat-config-change-',
    );
    final storage = LocalStorage(
      factory: databaseFactoryFfi,
      directory: directory.path,
    );
    const oldConfig = AppConfig();
    const newConfig = AppConfig(
      dataset: alternateDataset,
      apiBaseUrl: 'http://127.0.0.1:39001/api/v1',
    );
    final newRoom = Room.fromJson({
      ...eventRoom('direct-room-created').json,
      'id': '20000000-0000-4000-8000-000000000099',
    });
    final oldApis = <ScopedApi>[];
    final newApis = <ScopedApi>[];
    ProviderContainer make(
      AppConfig config,
      List<ScopedApi> clients, {
      Room? room,
    }) => ProviderContainer(
      overrides: [
        configProvider.overrideWithValue(config),
        storageProvider.overrideWithValue(storage),
        apiFactoryProvider.overrideWithValue((config, user, device) {
          final api = ScopedApi(config, user, device, room: room);
          clients.add(api);
          return api;
        }),
        socketFactoryProvider.overrideWithValue((_) => TestSocket()),
      ],
    );
    final oldApp = make(oldConfig, oldApis);
    var oldDisposed = false;
    ProviderContainer? newApp;
    ChatRepository? oldCache;
    try {
      await oldApp.read(accountProvider.notifier).select('1');
      final oldSession = oldApp.read(accountProvider).session!;
      await oldSession.setForeground(false);
      final creation = fixture('direct-room-created')..['userId'] = '1';
      await oldSession.repository.replaceRoomSnapshot([], testSync());
      await oldSession.repository.applyBatch(batch([creation]));
      final oldClientId = await oldSession.repository.enqueue(
        eventRoom('direct-room-created').id,
        'Pending only in the old dataset',
      );
      final device = oldSession.api.device;
      await oldApp.read(accountProvider.notifier).switchAccount();
      oldApp.dispose();
      oldDisposed = true;
      newApp = make(newConfig, newApis, room: newRoom);
      await newApp.read(accountProvider.notifier).select('1');
      final current = newApp.read(accountProvider).session!;
      expect(current.api.config.dataset, alternateDataset);
      expect(current.api.config.apiBaseUrl, newConfig.apiBaseUrl);
      expect(current.api.device, device);
      expect(await current.repository.rooms(), isEmpty);
      expect(await current.repository.cursor(), 0);
      expect(await current.repository.counts(), {'queued': 0, 'failed': 0});
      await current.repository.mergeRest(rooms: [newRoom]);
      final newClientId = await current.repository.enqueue(
        newRoom.id,
        'Send only in the new dataset',
      );
      await current.drain();
      await until(
        () async => (await current.repository.messages(newRoom.id)).any(
          (row) =>
              row['client_message_id'] == newClientId &&
              row['send_state'] == 'sent',
        ),
        'new scoped queue drains',
      );
      expect(oldApis.expand((api) => api.sends), isEmpty);
      final requests = newApis.expand((api) => api.sends).toList();
      expect(requests.length, 1);
      expect(requests.single['datasetId'], alternateDataset);
      expect(requests.single['apiUrl'], newConfig.apiBaseUrl);
      expect(requests.single['clientMessageId'], newClientId);
      expect(
        requests.any((request) => request['clientMessageId'] == oldClientId),
        isFalse,
      );
      oldCache = await storage.account(defaultDataset, '1');
      expect(await oldCache.cursor(), 1);
      final retained = (await oldCache.messages(
        eventRoom('direct-room-created').id,
      )).single;
      expect(retained['client_message_id'], oldClientId);
      expect(retained['send_state'], 'queued');
      expect(retained['server_id'], isNull);
      expect(await oldCache.counts(), {'queued': 1, 'failed': 0});
      await oldCache.close();
      oldCache = null;
      await newApp.read(accountProvider.notifier).switchAccount();
    } finally {
      await oldCache?.close();
      if (newApp != null) {
        await newApp.read(accountProvider.notifier).switchAccount();
        newApp.dispose();
      }
      if (!oldDisposed) {
        await oldApp.read(accountProvider.notifier).switchAccount();
        oldApp.dispose();
      }
      await storage.close();
      await directory.delete(recursive: true);
    }
  });

  test('other-device room delta carries no messages; HTTP merges own sender without queue', () async {
    final directory = await Directory.systemTemp.createTemp(
      'chat-other-device-',
    );
    final storage = LocalStorage(
      factory: databaseFactoryFfi,
      directory: directory.path,
    );
    final repo = await storage.account(defaultDataset, '2');
    final socket = TestSocket();
    final runtime = AccountSession(
      repository: repo,
      api: TestApi(),
      onChanged: () {},
      socketFactory: (_) => socket,
    );
    try {
      await runtime.connect();
      await resume(runtime, socket, after: 0, head: 2);
      final echo = fixture('direct-message-created');
      final data = object(echo['data']);
      final message = {
        ...eventMessage('direct-message-created').json,
        'senderId': '2',
        'originDeviceId': '60000000-0000-4000-8000-000000000002',
      };
      object(object(data['room'])['lastMessage'])['senderId'] = '2';
      socket.frame(batch([echo], from: 1, through: 2));
      await until(() async => await repo.cursor() == 2, 'room delta committed');
      expect(await repo.messages(eventRoom('direct-room-created').id), isEmpty);
      await repo.reconcileMessages(
        eventRoom('direct-room-created').id,
        [Message.fromJson(message)],
        {'fromRoomSeq': 1, 'throughRoomSeq': 1},
      );
      final rows = await repo.messages(eventRoom('direct-room-created').id);
      expect(rows.length, 1);
      expect(rows.single['sender_id'], repo.user);
      expect(rows.single['origin_device_id'], isNot(runtime.api.device));
      expect(rows.single['send_state'], 'sent');
      expect(rows.single['server_id'], message['id']);
      expect(rows.single['client_message_id'], message['clientMessageId']);
      expect(await repo.counts(), {'queued': 0, 'failed': 0});
      expect(await repo.db.query('outgoing_messages'), isEmpty);
    } finally {
      await runtime.dispose();
      await storage.close();
      await directory.delete(recursive: true);
    }
  });
}
