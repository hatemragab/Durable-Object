import 'dart:async';

import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:flutter_test/flutter_test.dart';

import 'session_test.dart' show TestApi, TestRepository, TestSocket;
import 'storage_test.dart' show testSync, testEpoch, fixture, eventRoom;
import 'scope_boundaries_test.dart' show until;

class SyncRepository extends TestRepository {
  Json? baseline = testSync();
  int snapshots = 0;
  final mergedRooms = <Room>[];
  ChatFailure? batchFailure;
  @override
  Future<int> applyBatch(Json batch) async {
    final error = batchFailure;
    batchFailure = null;
    if (error != null) throw error;
    return super.applyBatch(batch);
  }

  @override
  Future<Json?> syncState() async => baseline;
  @override
  Future<void> replaceRoomSnapshot(List<Room> rooms, Json sync) async {
    snapshots++;
    baseline = sync;
    committed = sync['throughSeq'] as int;
  }

  @override
  Future<void> mergeRest({
    List<Room> rooms = const [],
    List<Message> messages = const [],
  }) async {
    mergedRooms.addAll(rooms);
  }
}

class SyncApi extends TestApi {
  int snapshots = 0;
  Completer<Json>? snapshotGate;
  final histories = <Completer<Json>>[];
  final reads = <({int through, Completer<Json> response})>[];
  bool gateHistory = false;
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    if (path == '/rooms') {
      snapshots++;
      return snapshotGate?.future ??
          Future.value({'rooms': [], 'nextCursor': null, 'sync': testSync()});
    }
    if (path.endsWith('/messages') && method == 'GET') {
      final response = Completer<Json>();
      histories.add(response);
      if (!gateHistory) response.complete(emptyHistory());
      return response.future;
    }
    if (path.endsWith('/read')) {
      final response = Completer<Json>();
      reads.add((through: data!['throughRoomSeq'] as int, response: response));
      return response.future;
    }
    return super.request(method, path, data: data, query: query);
  }
}

Json emptyHistory() => {
  'messages': <Json>[],
  'hasMore': false,
  'nextBeforeRoomSeq': null,
  'window': {'fromRoomSeq': 0, 'throughRoomSeq': 0},
};

void main() {
  test(
    'first use and a 48-hour-old baseline require HTTP snapshot before socket',
    () async {
      for (final baseline in <Json?>[
        null,
        {
          ...testSync(),
          'syncedAt': DateTime.now()
              .toUtc()
              .subtract(const Duration(hours: 49))
              .toIso8601String(),
        },
      ]) {
        final repository = SyncRepository()..baseline = baseline;
        final api = SyncApi();
        final sockets = <TestSocket>[];
        final session = AccountSession(
          repository: repository,
          api: api,
          onChanged: () {},
          socketFactory: (_) {
            final socket = TestSocket();
            sockets.add(socket);
            return socket;
          },
        );
        await session.connect();
        expect(api.snapshots, 1);
        expect(repository.snapshots, 1);
        expect(sockets.length, 1);
        await session.dispose();
      }
    },
  );
  test('valid persisted baseline restores room-page continuation without another snapshot', () async {
    final repository = SyncRepository()
      ..baseline = {...testSync(4), 'nextCursor': 'opaque-page-2'};
    final api = SyncApi();
    final session = AccountSession(
      repository: repository,
      api: api,
      onChanged: () {},
      socketFactory: (_) => TestSocket(),
    );
    await session.connect();
    expect(session.roomsNextCursor, 'opaque-page-2');
    expect(api.snapshots, 0);
    await session.dispose();
  });
  test(
    'backgrounded snapshot response cannot replace the account baseline',
    () async {
      final repository = SyncRepository()..baseline = null;
      final api = SyncApi()..snapshotGate = Completer<Json>();
      final session = AccountSession(
        repository: repository,
        api: api,
        onChanged: () {},
        socketFactory: (_) => TestSocket(),
      );
      final connection = session.connect();
      await until(() async => api.snapshots == 1, 'snapshot started');
      await session.setForeground(false);
      api.snapshotGate!.complete({
        'rooms': [],
        'nextCursor': null,
        'sync': testSync(),
      });
      await connection;
      expect(repository.snapshots, 0);
      expect(repository.baseline, isNull);
      await session.dispose();
    },
  );
  test(
    'sync.required retires the socket, replaces snapshot and reconnects',
    () async {
      final repository = SyncRepository(), api = SyncApi();
      final sockets = <TestSocket>[];
      final session = AccountSession(
        repository: repository,
        api: api,
        onChanged: () {},
        socketFactory: (_) {
          final socket = TestSocket();
          sockets.add(socket);
          return socket;
        },
      );
      await session.start();
      await until(() async => sockets.length == 1, 'first socket');
      sockets.first.frame({
        'v': 2,
        'type': 'sync.required',
        'reason': 'CURSOR_EXPIRED',
      });
      await until(() async => sockets.length == 2, 'replacement socket');
      expect(api.snapshots, 1);
      expect(repository.snapshots, 1);
      expect(sockets.first.incoming.isClosed, isTrue);
      await session.dispose();
    },
  );
  test('detected coverage gap sends no ACK and automatically obtains a fresh snapshot', () async {
    final repository = SyncRepository()
      ..batchFailure = const ChatFailure('SEQ_GAP', 'Missing room coverage.');
    final api = SyncApi();
    final sockets = <TestSocket>[];
    final session = AccountSession(
      repository: repository,
      api: api,
      onChanged: () {},
      socketFactory: (_) {
        final socket = TestSocket();
        sockets.add(socket);
        return socket;
      },
    );
    await session.start();
    await until(() async => sockets.length == 1, 'first socket');
    sockets.first.frame(
      object(fixture('hello-and-resume')['hello'])..['headSeq'] = 4,
    );
    await until(
      () async => sockets.first.sent.any((raw) => raw.contains('"resume"')),
      'resume',
    );
    sockets.first.frame({
      'v': 2,
      'type': 'sync.started',
      'afterSeq': 0,
      'targetSeq': 4,
    });
    sockets.first.frame(fixture('replay-batch-1-4'));
    await until(() async => sockets.length == 2, 'automatic gap recovery');
    expect(sockets.first.sent.where((raw) => raw.contains('"ack"')), isEmpty);
    expect(repository.committed, 0);
    expect(repository.snapshots, 1);
    expect(api.snapshots, 1);
    expect(session.state, isNot('blocked'));
    await session.dispose();
  });
  test(
    'dynamic replay coverage accepts newer ready boundary with matching epoch',
    () async {
      final repository = SyncRepository(),
          api = SyncApi(),
          socket = TestSocket();
      final session = AccountSession(
        repository: repository,
        api: api,
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      await session.connect();
      final hello = object(fixture('hello-and-resume')['hello'])
        ..['headSeq'] = 4;
      socket.frame(hello);
      await until(
        () async => socket.sent.any((raw) => raw.contains('"resume"')),
        'resume',
      );
      socket.frame({
        'v': 2,
        'type': 'sync.started',
        'epoch': testEpoch,
        'afterSeq': 0,
        'targetSeq': 4,
      });
      socket.frame({
        'v': 2,
        'type': 'events.batch',
        'epoch': testEpoch,
        'batchId': '80000000-0000-4000-8000-000000000099',
        'fromSeq': 1,
        'toSeq': 6,
        'events': [],
      });
      socket.frame({
        'v': 2,
        'type': 'sync.ready',
        'epoch': testEpoch,
        'throughSeq': 6,
        'syncedAt': '2026-10-15T01:02:03.000Z',
      });
      await until(() async => session.state == 'live', 'dynamic ready');
      expect(repository.committed, 6);
      expect(repository.lastSyncedAt, '2026-10-15T01:02:03.000Z');
      socket.frame({
        'v': 2,
        'type': 'sync.ready',
        'epoch': '91000000-0000-4000-8000-000000000002',
        'throughSeq': 6,
      });
      await until(
        () async => session.state == 'blocked',
        'foreign ready rejected',
      );
      expect(repository.committed, 6);
      await session.dispose();
    },
  );
  test('room updates during HTTP fetch coalesce into one follow-up and closed rooms stay idle', () async {
    final repository = SyncRepository(), api = SyncApi()..gateHistory = true;
    final session = AccountSession(
      repository: repository,
      api: api,
      onChanged: () {},
    );
    final roomId = eventRoom('direct-room-created').id;
    await session.refreshActiveRoom();
    expect(api.histories, isEmpty);
    session.openRoom(roomId);
    final first = session.history(roomId);
    await until(() async => api.histories.length == 1, 'first HTTP request');
    final update = session.refreshActiveRoom();
    final another = session.refreshActiveRoom();
    expect(api.histories.length, 1);
    api.histories.first.complete(emptyHistory());
    await until(() async => api.histories.length == 2, 'one dirty follow-up');
    api.histories.last.complete(emptyHistory());
    await Future.wait([first, update, another]);
    expect(api.histories.length, 2);
    session.closeRoom(roomId);
    await session.refreshActiveRoom();
    expect(api.histories.length, 2);
    await session.dispose();
  });
  test('mark read coalesces displayed bounds and ignores response after leaving room', () async {
    final repository = SyncRepository(), api = SyncApi();
    final session = AccountSession(
      repository: repository,
      api: api,
      onChanged: () {},
    );
    final room = eventRoom('group-message-created');
    session.openRoom(room.id);
    final read = session.markRead(room.id, 1);
    await until(() async => api.reads.length == 1, 'read request');
    await session.markRead(room.id, 2);
    expect(api.reads.length, 1);
    api.reads.first.response.complete({'room': room.json});
    await until(() async => api.reads.length == 2, 'read follow-up');
    expect(api.reads.map((request) => request.through), [1, 2]);
    session.closeRoom(room.id);
    api.reads.last.response.complete({
      'room': {...room.json, 'revision': room.revision + 1},
    });
    await read;
    expect(repository.mergedRooms.length, 1);
    await session.markRead(room.id, 3);
    expect(api.reads.length, 2);
    await session.dispose();
  });
}
