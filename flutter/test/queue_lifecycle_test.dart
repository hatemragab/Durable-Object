import 'dart:async';
import 'dart:io';

import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:durable_chat_demo/core/storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'session_test.dart' show TestApi, TestSocket;
import 'storage_test.dart' show eventRoom, eventMessage, testSync;

class DeferredSendApi extends TestApi {
  final started = Completer<void>();
  final response = Completer<Json>();
  int sends = 0;
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    if (path.endsWith('/messages')) {
      sends++;
      if (!started.isCompleted) started.complete();
      return response.future;
    }
    return super.request(method, path, data: data, query: query);
  }
}

void main() {
  sqfliteFfiInit();
  late Directory directory;
  late LocalStorage storage;
  final repos = <ChatRepository>[];
  Future<ChatRepository> open(String user) async {
    final repo = await storage.account(defaultDataset, user);
    repos.add(repo);
    await repo.replaceRoomSnapshot([], testSync());
    return repo;
  }

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('chat-queue-lifecycle-');
    storage = LocalStorage(
      factory: databaseFactoryFfi,
      directory: directory.path,
    );
  });
  tearDown(() async {
    for (final repo in repos) {
      if (repo.db.isOpen) await repo.close();
    }
    repos.clear();
    await storage.close();
    await directory.delete(recursive: true);
  });
  test('account switch discards an in-flight REST result and preserves original queued intent', () async {
    final repoA = await open('1'), api = DeferredSendApi();
    final room = eventRoom('direct-room-created'),
        message = eventMessage('direct-message-created');
    await repoA.mergeRest(rooms: [room]);
    await repoA.enqueue(room.id, message.text, clientId: message.clientId);
    final session = AccountSession(
      repository: repoA,
      api: api,
      onChanged: () {},
      socketFactory: (_) => TestSocket(),
    );
    await session.start();
    await api.started.future;
    final disposal = session.dispose();
    final repoB = await open('2');
    api.response.complete({
      'room': eventRoom('direct-message-created').json,
      'message': message.json,
    });
    await disposal;
    expect(await repoB.rooms(), isEmpty);
    expect(await repoB.cursor(), 0);
    expect(await repoB.counts(), {'queued': 0, 'failed': 0});
    final reopened = await open('1');
    final pending = (await reopened.messages(room.id)).single;
    expect(pending['client_message_id'], message.clientId);
    expect(pending['send_state'], 'queued');
    expect(pending['server_id'], isNull);
  });
  test('HTTP reconciliation before an ambiguous POST failure never resurrects outgoing work', () async {
    final repo = await open('1'), api = DeferredSendApi();
    final room = eventRoom('direct-room-created'),
        message = eventMessage('direct-message-created');
    await repo.mergeRest(rooms: [room]);
    await repo.enqueue(room.id, message.text, clientId: message.clientId);
    final session = AccountSession(
      repository: repo,
      api: api,
      onChanged: () {},
      socketFactory: (_) => TestSocket(),
    );
    await session.start();
    await api.started.future;
    await repo.reconcileMessages(
      room.id,
      [message],
      {'fromRoomSeq': 1, 'throughRoomSeq': 1},
    );
    api.response.completeError(
      const ChatFailure(
        'TIMEOUT',
        'Response lost after commit.',
        retryable: true,
      ),
    );
    final deadline = DateTime.now().add(const Duration(seconds: 2));
    while (session.diagnostic?.contains('TIMEOUT') != true &&
        DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(session.diagnostic, contains('TIMEOUT'));
    expect(await repo.counts(), {'queued': 0, 'failed': 0});
    expect((await repo.messages(room.id)).single['send_state'], 'sent');
    expect(api.sends, 1);
    await session.dispose();
  });
}
