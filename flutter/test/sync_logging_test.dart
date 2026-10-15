import 'dart:async';
import 'dart:math';

import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'room_sync_test.dart' show SyncApi, SyncRepository;
import 'session_test.dart'
    show TestApi, TestRepository, TestSocket, handshake, hello;
import 'storage_test.dart' show fixture, testSync;
import 'scope_boundaries_test.dart' show until;

class GatedSnapshotRepository extends SyncRepository {
  final save = Completer<void>();
  @override
  Future<void> replaceRoomSnapshot(List<Room> rooms, Json sync) async {
    await save.future;
    await super.replaceRoomSnapshot(rooms, sync);
  }
}

void main() {
  test(
    'delta log proves receive, SQLite commit, then ACK; duplicates are already saved',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository();
      final entries = <({String line, int cursor, int acks})>[];
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
        syncLog: (line) => entries.add((
          line: line,
          cursor: repo.committed,
          acks: socket.sent.where((raw) => raw.contains('"ack"')).length,
        )),
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      repo.gate = Completer<void>();
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      expect(entries.where((e) => e.line.contains('DELTA_RECEIVED')).length, 1);
      expect(
        entries.where((e) => e.line.contains('DELTA_SQLITE_COMMITTED')),
        isEmpty,
      );
      expect(socket.sent.where((raw) => raw.contains('"ack"')), isEmpty);
      repo.gate!.complete();
      clock.flushMicrotasks();
      final received = entries.indexWhere(
        (e) => e.line.contains('DELTA_RECEIVED'),
      );
      final committed = entries.indexWhere(
        (e) => e.line.contains('DELTA_SQLITE_COMMITTED'),
      );
      final ack = entries.indexWhere((e) => e.line.contains('DELTA_ACK_SENT'));
      expect(received, lessThan(committed));
      expect(committed, lessThan(ack));
      expect(entries[committed].cursor, 4);
      expect(entries[committed].acks, 0);
      expect(entries[ack].acks, 1);
      expect(entries[committed].line, contains('rowsInBatch=2'));
      expect(entries[committed].line, contains('savedCursor=4'));
      socket.frame(fixture('duplicate-batch-1-4'));
      clock.flushMicrotasks();
      expect(
        entries.where((e) => e.line.contains('DELTA_ALREADY_SAVED')).length,
        1,
      );
      expect(
        entries.where((e) => e.line.contains('DELTA_SQLITE_COMMITTED')).length,
        1,
      );
      final output = entries.map((e) => e.line).join('\n');
      for (final secret in [
        'redacted',
        'Hello User 2',
        'Demo group',
        'ticket=',
        'ws://',
      ]) {
        expect(output, isNot(contains(secret)));
      }
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );

  test(
    'failed storage never logs saved or ACK, and emits no raw error',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository()..fail = true;
      final logs = <String>[];
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
        syncLog: logs.add,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      expect(logs.any((line) => line.contains('DELTA_SAVE_FAILED')), isTrue);
      expect(
        logs.any(
          (line) =>
              line.contains('DELTA_SQLITE_COMMITTED') ||
              line.contains('DELTA_ACK_SENT'),
        ),
        isFalse,
      );
      expect(logs.join(), isNot(contains('Injected transaction rollback')));
      expect(repo.committed, 0);
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );

  test(
    'retired socket can log a completed SQLite save but never an ACK sent',
    () => fakeAsync((clock) {
      final socket = TestSocket(),
          repo = TestRepository()..gate = Completer<void>();
      final logs = <String>[];
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
        syncLog: logs.add,
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      unawaited(session.setForeground(false));
      clock.flushMicrotasks();
      repo.gate!.complete();
      clock.flushMicrotasks();
      expect(
        logs.any((line) => line.contains('DELTA_SQLITE_COMMITTED')),
        isTrue,
      );
      expect(logs.any((line) => line.contains('DELTA_ACK_SKIPPED')), isTrue);
      expect(logs.any((line) => line.contains('DELTA_ACK_SENT')), isFalse);
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );

  test(
    'a broken log sink cannot prevent commit or ACK',
    () => fakeAsync((clock) {
      final socket = TestSocket(), repo = TestRepository();
      final session = AccountSession(
        repository: repo,
        api: TestApi(),
        onChanged: () {},
        socketFactory: (_) => socket,
        syncLog: (_) => throw StateError('log sink unavailable'),
      );
      unawaited(session.start());
      clock.flushMicrotasks();
      handshake(socket, clock);
      socket.frame(fixture('replay-batch-1-4'));
      clock.flushMicrotasks();
      expect(repo.committed, 4);
      expect(socket.sent.any((raw) => raw.contains('"ack"')), isTrue);
      unawaited(session.dispose());
      clock.flushMicrotasks();
    }),
  );

  test('first use and expiry report the cause, and saved is logged only after snapshot commit', () async {
    for (final expired in [false, true]) {
      final repo = GatedSnapshotRepository()
        ..baseline = expired
            ? {
                ...testSync(),
                'syncedAt': DateTime.now()
                    .toUtc()
                    .subtract(const Duration(hours: 49))
                    .toIso8601String(),
              }
            : null;
      final api = SyncApi();
      final logs = <String>[];
      final session = AccountSession(
        repository: repo,
        api: api,
        onChanged: () {},
        socketFactory: (_) => TestSocket(),
        syncLog: logs.add,
      );
      final connection = session.connect();
      await until(
        () async => logs.any((line) => line.contains('FULL_SNAPSHOT_RECEIVED')),
        'snapshot arrived',
      );
      final reason = expired ? 'BASELINE_EXPIRED_48H' : 'FIRST_USE';
      expect(
        logs.any(
          (line) =>
              line.contains('FULL_SNAPSHOT_REQUESTED') &&
              line.contains('reason=$reason'),
        ),
        isTrue,
      );
      expect(
        logs.any((line) => line.contains('FULL_SNAPSHOT_SQLITE_COMMITTED')),
        isFalse,
      );
      repo.save.complete();
      await connection;
      expect(repo.snapshots, 1);
      expect(
        logs.any(
          (line) =>
              line.contains('FULL_SNAPSHOT_SQLITE_COMMITTED') &&
              line.contains('reason=$reason'),
        ),
        isTrue,
      );
      await session.dispose();
    }
  });

  test('manual refresh logs its own reason', () async {
    final logs = <String>[];
    final session = AccountSession(
      repository: SyncRepository(),
      api: SyncApi(),
      onChanged: () {},
      socketFactory: (_) => TestSocket(),
      syncLog: logs.add,
    );
    await session.connect();
    await session.refreshRooms();
    expect(
      logs.any(
        (line) =>
            line.contains('FULL_SNAPSHOT_REQUESTED') &&
            line.contains('reason=MANUAL_REFRESH'),
      ),
      isTrue,
    );
    await session.dispose();
  });

  test(
    'server reason survives close 4010, and unknown text is never logged',
    () => fakeAsync((clock) {
      for (final reason in [
        'DELTA_TOO_LARGE',
        'CURSOR_EXPIRED',
        'CURSOR_AHEAD',
        'EPOCH_CHANGED',
        'private-ticket-value',
      ]) {
        final sockets = <TestSocket>[], logs = <String>[];
        final session = AccountSession(
          repository: SyncRepository(),
          api: SyncApi(),
          onChanged: () {},
          random: Random(0),
          socketFactory: (_) {
            final socket = TestSocket();
            sockets.add(socket);
            return socket;
          },
          syncLog: logs.add,
        );
        unawaited(session.start());
        clock.flushMicrotasks();
        final socket = sockets.single;
        socket.frame({'v': 2, 'type': 'sync.required', 'reason': reason});
        socket.closeCode = 4010;
        unawaited(socket.incoming.close());
        clock.flushMicrotasks();
        clock.elapse(const Duration(seconds: 1));
        clock.flushMicrotasks();
        final expected = reason == 'private-ticket-value'
            ? 'SERVER_REQUIRED'
            : reason;
        expect(
          logs.any(
            (line) =>
                line.contains('FULL_SNAPSHOT_REQUESTED') &&
                line.contains('reason=$expected'),
          ),
          isTrue,
        );
        expect(logs.join(), isNot(contains('private-ticket-value')));
        unawaited(session.dispose());
        clock.flushMicrotasks();
      }
    }),
  );

  test(
    'epoch mismatch and local coverage gaps request snapshots with distinct reasons',
    () => fakeAsync((clock) {
      for (final gap in [false, true]) {
        final repo = SyncRepository();
        if (gap) {
          repo.batchFailure = const ChatFailure('SEQ_GAP', 'private details');
        }
        final sockets = <TestSocket>[], logs = <String>[];
        final session = AccountSession(
          repository: repo,
          api: SyncApi(),
          onChanged: () {},
          random: Random(0),
          socketFactory: (_) {
            final socket = TestSocket();
            sockets.add(socket);
            return socket;
          },
          syncLog: logs.add,
        );
        unawaited(session.start());
        clock.flushMicrotasks();
        if (gap) {
          handshake(sockets.single, clock);
          sockets.single.frame(fixture('replay-batch-1-4'));
        } else {
          sockets.single.frame(
            hello()..['epoch'] = '91000000-0000-4000-8000-000000000002',
          );
        }
        clock.flushMicrotasks();
        clock.elapse(const Duration(seconds: 1));
        clock.flushMicrotasks();
        final expected = gap ? 'COVERAGE_GAP' : 'EPOCH_CHANGED';
        expect(
          logs.any(
            (line) =>
                line.contains('FULL_SNAPSHOT_REQUESTED') &&
                line.contains('reason=$expected'),
          ),
          isTrue,
        );
        expect(logs.join(), isNot(contains('private details')));
        unawaited(session.dispose());
        clock.flushMicrotasks();
      }
    }),
  );
}
