import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/api.dart';
import 'package:durable_chat_demo/app.dart' show presenceLabel;
import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:durable_chat_demo/core/storage.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart' show Database;

import 'storage_test.dart' show fixture, testSync, testEpoch;

class TestSocket implements ChatSocket {
  TestSocket() {
    incoming = StreamController<dynamic>(
      sync: true,
      onListen: () => listens++,
      onCancel: () {
        cancellations++;
        return Future<void>.value();
      },
    );
  }
  late final StreamController<dynamic> incoming;
  int listens = 0, cancellations = 0;
  int get activeListeners => listens - cancellations;
  final sent = <String>[];
  @override
  Future<void> get ready => Future.value();
  @override
  Stream<dynamic> get stream => incoming.stream;
  @override
  int? closeCode;
  @override
  void send(String data) => sent.add(data);
  void frame(Json frame) => incoming.add(
    jsonEncode({
      'epoch': testEpoch,
      if (frame['type'] == 'sync.ready')
        'syncedAt': DateTime.now().toUtc().toIso8601String(),
      ...frame,
    }),
  );
  @override
  Future<void> close() async {
    if (!incoming.isClosed) await incoming.close();
  }
}

class TestApi extends ApiClient {
  TestApi()
    : super(const AppConfig(), '2', '60000000-0000-4000-8000-000000000001');
  int renewals = 0;
  @override
  Future<void> session({bool force = false}) async {
    if (force) renewals++;
  }

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    if (path == '/realtime/ticket') {
      return {'url': 'ws://localhost/v1/ws', 'ticket': 'redacted'};
    }
    if (path == '/rooms') {
      return {'rooms': [], 'nextCursor': null, 'sync': testSync()};
    }
    throw StateError('Unexpected request $path');
  }
}

class TestRepository implements ChatRepository {
  TestRepository({this.account = '2'});
  final String account;
  @override
  String get dataset => defaultDataset;
  @override
  String get user => account;
  final changesController = StreamController<void>.broadcast();
  @override
  Stream<void> get changes => changesController.stream;
  int committed = 0, activeReductions = 0, maxReductions = 0;
  String? lastSyncedAt;
  Completer<void>? gate;
  Completer<void>? cursorGate;
  bool fail = false, closed = false;
  @override
  Future<Json?> syncState() async => testSync(committed);
  @override
  Future<void> markSynced(String syncedAt) async {
    lastSyncedAt = syncedAt;
  }

  @override
  Future<Json?> messageWindow(String roomId) async => null;
  @override
  Future<void> replaceRoomSnapshot(List<Room> rooms, Json sync) async {
    committed = sync['throughSeq'] as int;
  }

  @override
  Future<void> reconcileMessages(
    String room,
    List<Message> messages,
    Json window, {
    bool latest = true,
  }) async {}
  @override
  Future<int> cursor() async {
    await cursorGate?.future;
    return committed;
  }

  @override
  Future<int> applyBatch(Json batch) async {
    activeReductions++;
    maxReductions = max(maxReductions, activeReductions);
    await gate?.future;
    try {
      if (fail) {
        throw const ChatFailure(
          'SQL_FAILURE',
          'Injected transaction rollback.',
        );
      }
      committed = batch['toSeq'] as int;
      return committed;
    } finally {
      activeReductions--;
    }
  }

  @override
  Future<void> mergeRest({
    List<Room> rooms = const [],
    List<Message> messages = const [],
  }) async {}
  @override
  Future<Json?> nextOutgoing(DateTime now) async => null;
  @override
  Future<void> close() async {
    closed = true;
    await changesController.close();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class ScopeDatabase implements Database {
  bool closed = false;
  @override
  Future<void> close() async => closed = true;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// Data is stubbed, but watchQuery and close are inherited production methods.
class ScopeRepository extends ChatRepository {
  ScopeRepository() : super(ScopeDatabase(), defaultDataset, '2');
  int activeListeners = 0, messageQueries = 0;
  @override
  Stream<void> get changes {
    final source = super.changes;
    return Stream<void>.multi((controller) {
      activeListeners++;
      var active = true;
      void released() {
        if (!active) return;
        active = false;
        activeListeners--;
      }

      final subscription = source.listen(
        controller.add,
        onError: controller.addError,
        onDone: () {
          released();
          controller.close();
        },
      );
      controller.onCancel = () {
        released();
        unawaited(subscription.cancel());
        return Future<void>.value();
      };
    });
  }

  @override
  Future<Json?> syncState() async => testSync();
  @override
  Future<void> markSynced(String syncedAt) async {}
  @override
  Future<Json?> messageWindow(String roomId) async => null;
  @override
  Future<void> reconcileMessages(
    String room,
    List<Message> messages,
    Json window, {
    bool latest = true,
  }) async {}
  @override
  Future<int> cursor() async => 0;
  @override
  Future<List<Room>> rooms() async => [];
  @override
  Future<List<Json>> messages(String roomId, {int limit = 50}) async {
    messageQueries++;
    return [];
  }

  @override
  Future<void> mergeRest({
    List<Room> rooms = const [],
    List<Message> messages = const [],
  }) async {}
  @override
  Future<Json?> nextOutgoing(DateTime now) async => null;
}

class ScopeApi extends TestApi {
  final historyRooms = <String>[];
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    if (path.endsWith('/messages')) {
      historyRooms.add(path);
      return {
        'messages': <Json>[],
        'hasMore': false,
        'window': {'fromRoomSeq': 0, 'throughRoomSeq': 0},
      };
    }
    return super.request(method, path, data: data, query: query);
  }
}

class ScopeAccount extends AccountController {
  ScopeAccount(this.session);
  final AccountSession session;
  @override
  AccountState build() => AccountState(session: session);
}

Json hello() => object(fixture('hello-and-resume')['hello'])..['headSeq'] = 4;
void handshake(TestSocket socket, FakeAsync clock) {
  socket.frame(hello());
  clock.flushMicrotasks();
  socket.frame({'v': 2, 'type': 'sync.started', 'afterSeq': 0, 'targetSeq': 4});
  clock.flushMicrotasks();
}

void main() {
  test(
    'initial presence watch requests one snapshot and periodic repair stays active',
    () => fakeAsync((clock) {
      final socket = TestSocket();
      final session = AccountSession(
        repository: TestRepository(),
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      expect(
        socket.sent.where((raw) => raw.contains('presence.watch')).length,
        1,
      );
      expect(
        socket.sent.where((raw) => raw.contains('presence.refresh')),
        isEmpty,
      );
      clock.elapse(const Duration(seconds: 20));
      socket.incoming.add('pong');
      clock.flushMicrotasks();
      clock.elapse(const Duration(seconds: 10));
      clock.flushMicrotasks();
      expect(
        socket.sent.where((raw) => raw.contains('presence.refresh')).length,
        1,
      );
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'repeated production room scopes retain one socket and bounded timers then fully dispose',
    () => fakeAsync((clock) {
      final repository = ScopeRepository(), api = ScopeApi();
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
      unawaited(session.start());
      final accountTimers = clock.periodicTimerCount;
      clock.flushMicrotasks();
      final socket = sockets.single;
      socket.frame(hello()..['headSeq'] = 0);
      clock.flushMicrotasks();
      socket.frame({
        'v': 2,
        'type': 'sync.started',
        'afterSeq': 0,
        'targetSeq': 0,
      });
      socket.frame({'v': 2, 'type': 'sync.ready', 'throughSeq': 0});
      clock.flushMicrotasks();
      expect(session.state, 'live');
      final container = ProviderContainer(
        overrides: [accountProvider.overrideWith(() => ScopeAccount(session))],
      );
      final inbox = container.listen(roomsProvider, (_, _) {});
      clock.flushMicrotasks();
      clock.elapse(Duration.zero);
      final baselineListeners = repository.activeListeners;
      final baselineTimers = clock.pendingTimers.length;
      expect(baselineListeners, 2); // Account runtime plus the retained inbox.
      expect(accountTimers, greaterThan(0));
      final rooms = [
        object(object(fixture('direct-room-created')['data'])['room'])['id']
            as String,
        object(object(fixture('group-room-created')['data'])['room'])['id']
            as String,
      ];
      for (var visit = 0; visit < 20; visit++) {
        final roomId = rooms[visit % rooms.length];
        for (final limit in [50, 100]) {
          // MessagePage's ref.watch and ref.listen share this exact family.
          final provider = messagesProvider((roomId: roomId, limit: limit));
          final window = container.listen(provider, (_, _) {});
          final arrivals = container.listen(provider, (_, _) {});
          unawaited(session.history(roomId, before: limit == 100 ? 51 : null));
          clock.flushMicrotasks();
          clock.elapse(Duration.zero);
          expect(repository.activeListeners, baselineListeners + 1);
          expect(clock.pendingTimers.length, baselineTimers);
          expect(sockets.length, 1);
          expect(socket.activeListeners, 1);
          expect(socket.listens, 1);
          window.close();
          arrivals.close();
          clock.elapse(Duration.zero); // Actual Riverpod autoDispose boundary.
          clock.flushMicrotasks();
          expect(repository.activeListeners, baselineListeners);
          expect(clock.pendingTimers.length, baselineTimers);
        }
      }
      expect(repository.messageQueries, 40);
      expect(api.historyRooms.length, 40);
      for (var pulse = 1; pulse <= 4; pulse++) {
        clock.elapse(const Duration(seconds: 20));
        socket.incoming.add('pong');
        clock.flushMicrotasks();
        expect(socket.sent.where((frame) => frame == 'ping').length, pulse);
        expect(sockets.length, 1);
        expect(socket.activeListeners, 1);
        expect(clock.pendingTimers.length, lessThanOrEqualTo(baselineTimers));
      }
      unawaited(session.setForeground(false));
      clock.flushMicrotasks();
      clock.elapse(const Duration(seconds: 1)); // Bounded transport close.
      clock.flushMicrotasks();
      expect(session.state, 'backgroundPaused');
      expect(socket.activeListeners, 0);
      expect(socket.cancellations, 1);
      expect(socket.incoming.isClosed, isTrue);
      expect(clock.periodicTimerCount, accountTimers);
      expect(clock.nonPeriodicTimerCount, 0);
      clock.elapse(const Duration(minutes: 2));
      clock.flushMicrotasks();
      expect(sockets.length, 1);
      expect(clock.periodicTimerCount, accountTimers);
      final pausedTimers = clock.pendingTimers.length;
      inbox.close();
      container.dispose();
      var disposed = false;
      unawaited(session.dispose().then((_) => disposed = true));
      clock.flushMicrotasks();
      expect(disposed, isTrue);
      expect((repository.db as ScopeDatabase).closed, isTrue);
      expect(repository.activeListeners, 0);
      expect(clock.pendingTimers, isEmpty);
      final queriesAfterDispose = repository.messageQueries;
      clock.elapse(const Duration(minutes: 5));
      clock.flushMicrotasks();
      expect(sockets.length, 1);
      expect(socket.listens, 1);
      expect(socket.cancellations, 1);
      expect(repository.messageQueries, queriesAfterDispose);
      expect(clock.pendingTimers, isEmpty);
      debugPrint(
        'S14: 20 room visits/40 windows; timers live=$baselineTimers '
        'background=$pausedTimers disposed=0; socket listens=1/cancels=1.',
      );
    }),
  );
  test(
    'hello identity, local cursor resume and ACK only after serial commit',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository();
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
        random: Random(0),
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      expect(jsonDecode(socket.sent.first)['afterSeq'], 0);
      repo.gate = Completer<void>();
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      socket.frame(fixture('duplicate-batch-1-4'));
      clock.flushMicrotasks();
      expect(socket.sent.where((value) => value.contains('"ack"')), isEmpty);
      expect(repo.maxReductions, 1);
      repo.gate!.complete();
      clock.flushMicrotasks();
      expect(repo.committed, 4);
      expect(socket.sent.where((value) => value.contains('"ack"')).length, 2);
      expect(repo.maxReductions, 1);
      socket.frame({'v': 2, 'type': 'sync.ready', 'throughSeq': 4});
      clock.flushMicrotasks();
      expect(session.state, 'live');
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'rollback emits no ACK and visibly blocks synchronization',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository()..fail = true;
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      expect(socket.sent.where((value) => value.contains('"ack"')), isEmpty);
      expect(repo.committed, 0);
      expect(session.state, 'blocked');
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'heartbeat continues through more than70 seconds of slow replay',
    () => fakeAsync((clock) {
      final socket = TestSocket(),
          repo = TestRepository()..gate = Completer<void>();
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      for (var i = 0; i < 4; i++) {
        clock.elapse(const Duration(seconds: 20));
        socket.incoming.add('pong');
        clock.flushMicrotasks();
      }
      expect(socket.sent.where((value) => value == 'ping').length, 4);
      expect(session.state, 'replaying');
      repo.gate!.complete();
      clock.flushMicrotasks();
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'no pong reconnects and replacement4009 stops automatic fight',
    () => fakeAsync((clock) {
      final sockets = <TestSocket>[];
      final repo = TestRepository();
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) {
          final socket = TestSocket();
          sockets.add(socket);
          return socket;
        },
        random: Random(0),
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(sockets.single, clock);
      clock.elapse(const Duration(seconds: 31));
      clock.flushMicrotasks();
      expect(sockets.length, 2);
      final current = sockets.last;
      current.closeCode = 4009;
      unawaited(current.incoming.close());
      clock.flushMicrotasks();
      expect(session.state, 'blocked');
      clock.elapse(const Duration(minutes: 2));
      clock.flushMicrotasks();
      expect(sockets.length, 2);
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'background stops socket and old frames cannot mutate disposed account',
    () => fakeAsync((clock) {
      final sockets = <TestSocket>[];
      final repo = TestRepository();
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) {
          final socket = TestSocket();
          sockets.add(socket);
          return socket;
        },
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(sockets.single, clock);
      unawaited(session.setForeground(false));
      clock.flushMicrotasks();
      expect(session.state, 'backgroundPaused');
      expect(session.presenceFor('1'), 'unknown');
      clock.elapse(const Duration(minutes: 2));
      clock.flushMicrotasks();
      expect(sockets.length, 1);
      unawaited(session.setForeground(true));
      clock.flushMicrotasks();
      expect(sockets.length, 2);
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'wrong hello preserves the committed cursor',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository()..committed = 95;
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      socket.frame(hello()..['userId'] = '1');
      clock.flushMicrotasks();
      expect(session.state, 'blocked');
      expect(repo.committed, 95);
      expect(socket.sent, isEmpty);
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'dispose releases the account repository and prevents future reconnects',
    () async {
      final repo = TestRepository();
      final socket = TestSocket();
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      await session.start();
      await Future<void>.delayed(Duration.zero);
      await session.dispose();
      expect(repo.closed, isTrue);
      await session.connect();
      expect(session.connected, isFalse);
    },
  );
  test(
    'presence refresh applies while a durable transaction is waiting',
    () => fakeAsync((clock) {
      final socket = TestSocket(),
          repo = TestRepository()..gate = Completer<void>();
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      socket.frame({
        'v': 2,
        'type': 'presence.snapshot',
        'items': [
          {
            ...fixture('presence-online-two-devices'),
            'userId': '1',
            'observedAt': DateTime.now().toUtc().toIso8601String(),
          },
        ],
      });
      clock.flushMicrotasks();
      expect(session.presenceFor('1'), 'online');
      expect(repo.committed, 0);
      expect(socket.sent.where((frame) => frame.contains('"ack"')), isEmpty);
      repo.gate!.complete();
      clock.flushMicrotasks();
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'cursor ahead of remote head stays committed while repair is pending',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository()..committed = 95;
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      socket.frame(hello());
      clock.flushMicrotasks();
      expect(jsonDecode(socket.sent.first)['afterSeq'], 95);
      socket.frame({
        'v': 2,
        'type': 'error',
        'code': 'STREAM_NOT_READY',
        'message': 'Journal repair pending',
        'retryable': true,
      });
      clock.flushMicrotasks();
      expect(repo.committed, 95);
      expect(session.state, 'retryWaiting');
      expect(socket.sent.where((frame) => frame.contains('"ack"')), isEmpty);
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test(
    'group presence counts User2 once across two devices and excludes viewer',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository(account: '1');
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      socket.frame(hello()..['userId'] = '1');
      clock.flushMicrotasks();
      socket.frame({
        'v': 2,
        'type': 'sync.started',
        'afterSeq': 0,
        'targetSeq': 4,
      });
      clock.flushMicrotasks();
      final now = DateTime.now().toUtc().toIso8601String();
      socket.frame({
        'v': 2,
        'type': 'presence.snapshot',
        'items': [
          {
            ...fixture('presence-online-two-devices'),
            'userId': '2',
            'observedAt': now,
          },
          {...fixture('presence-unknown'), 'userId': '3'},
        ],
      });
      clock.flushMicrotasks();
      // Even if a local map contains the viewer, the group count excludes it.
      session.presence['1'] = Presence.fromJson({
        ...fixture('presence-online-two-devices'),
        'userId': '1',
        'observedAt': now,
      });
      final room = Room.fromJson(
        object(object(fixture('group-room-created')['data'])['room']),
      );
      expect(presenceLabel(session, room), '1 online · Presence updating');
      socket.frame({
        'v': 2,
        'type': 'presence.changed',
        'item': {
          'userId': '3',
          'state': 'offline',
          'activeDeviceCount': 0,
          'connectionCount': 0,
          'revision': 1,
          'observedAt': now,
        },
      });
      clock.flushMicrotasks();
      expect(presenceLabel(session, room), '1 of 2 others online');
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );
  test('stale sync.ready cannot overwrite replacement or background state', () {
    for (final replaced in [false, true]) {
      fakeAsync((clock) {
        final socket = TestSocket(), repo = TestRepository();
        final session = AccountSession(
          repository: repo,
          api: TestApi(),
          onChanged: () {},
          socketFactory: (_) => socket,
        );
        unawaited(session.start());
        clock.flushMicrotasks();
        handshake(socket, clock);
        repo.committed = 4;
        repo.cursorGate = Completer<void>();
        socket.frame({'v': 2, 'type': 'sync.ready', 'throughSeq': 4});
        clock.flushMicrotasks();
        if (replaced) {
          socket.closeCode = 4009;
          unawaited(socket.incoming.close());
        } else {
          unawaited(session.setForeground(false));
        }
        clock.flushMicrotasks();
        repo.cursorGate!.complete();
        clock.flushMicrotasks();
        expect(session.state, replaced ? 'blocked' : 'backgroundPaused');
        expect(session.connected, isFalse);
        unawaited(session.dispose());
        clock.flushMicrotasks();
      });
    }
  });
}
