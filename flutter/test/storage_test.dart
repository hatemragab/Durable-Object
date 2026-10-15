import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const testEpoch = '91000000-0000-4000-8000-000000000001';
Json testSync([int through = 0]) => {
  'epoch': testEpoch,
  'throughSeq': through,
  'syncedAt': DateTime.now().toUtc().toIso8601String(),
};
Json fixture(String name) => object(
  jsonDecode(File('../shared/fixtures/$name.json').readAsStringSync()),
);
Json batch(List<Json> events, {int? from, int? through}) => {
  'v': 2,
  'type': 'events.batch',
  'epoch': testEpoch,
  'batchId': '80000000-0000-4000-8000-000000000099',
  'fromSeq': from ?? events.first['streamSeq'],
  'toSeq': through ?? events.last['streamSeq'],
  'events': events,
};
Room eventRoom(String name) =>
    Room.fromJson(object(object(fixture(name)['data'])['room']));
Message eventMessage(String name) => Message.fromJson(
  fixture(name.startsWith('group') ? 'group-message' : 'direct-message'),
);

void main() {
  sqfliteFfiInit();
  late Directory directory;
  late LocalStorage storage;
  final opened = <ChatRepository>[];
  Future<ChatRepository> account([
    String user = '2',
    String dataset = defaultDataset,
  ]) async {
    final value = await storage.account(dataset, user);
    opened.add(value);
    await value.replaceRoomSnapshot([], testSync());
    return value;
  }

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('durable-chat-test-');
    storage = LocalStorage(
      factory: databaseFactoryFfi,
      directory: directory.path,
    );
  });
  tearDown(() async {
    for (final value in opened) {
      if (value.db.isOpen) await value.close();
    }
    opened.clear();
    await storage.close();
    await directory.delete(recursive: true);
  });

  test(
    'room-only shared fixtures parse and message bodies use HTTP models',
    () {
      for (final name in [
        'direct-room-created',
        'direct-message-created',
        'group-room-created',
        'group-message-created',
      ]) {
        final event = DurableEvent.fromJson(
          fixture(name),
          dataset: defaultDataset,
          recipient: '2',
        );
        expect(event.seq, greaterThan(0));
        expect(event.json['type'], 'room.upserted');
        expect(object(event.json['data']).keys, ['room']);
      }
      expect(eventMessage('group-message-created').roomSeq, 1);
      for (final name in ['wrong-recipient', 'unsupported-event']) {
        expect(
          () => DurableEvent.fromJson(
            fixture(name),
            dataset: defaultDataset,
            recipient: '2',
          ),
          throwsA(isA<ChatFailure>()),
        );
      }
    },
  );
  test('sparse coverage and empty coverage advance atomically without message journals', () async {
    final repo = await account();
    await repo.applyBatch(fixture('replay-batch-1-4'));
    expect(await repo.cursor(), 4);
    expect((await repo.rooms()).length, 2);
    expect(await repo.db.query('messages'), isEmpty);
    await repo.applyBatch(fixture('duplicate-batch-1-4'));
    await repo.applyBatch(fixture('overlapping-batch-3-6'));
    expect(await repo.cursor(), 6);
    await repo.applyBatch(batch([], from: 7, through: 12));
    expect(await repo.cursor(), 12);
    expect(
      await repo.db.rawQuery(
        "SELECT name FROM sqlite_master WHERE name = 'applied_events'",
      ),
      isEmpty,
    );
  });
  test('coverage gaps, wrong epoch, recipient and duplicate room rows preserve state', () async {
    final repo = await account();
    await repo.applyBatch(fixture('replay-batch-1-4'));
    final before = await repo.db.query('rooms');
    final room = fixture('group-message-created')..['streamSeq'] = 5;
    for (final invalid in [
      batch([], from: 6, through: 8),
      batch([], from: 5, through: 8)
        ..['epoch'] = '91000000-0000-4000-8000-000000000002',
      batch([fixture('wrong-recipient')..['streamSeq'] = 5]),
      batch([
        room,
        {...room, 'streamSeq': 6},
      ]),
      batch([fixture('unsupported-event')..['streamSeq'] = 5]),
    ]) {
      await expectLater(repo.applyBatch(invalid), throwsA(isA<ChatFailure>()));
      expect(await repo.cursor(), 4);
      expect(await repo.db.query('rooms'), before);
    }
  });
  test('SQLite failure rolls back snapshot upserts and cursor before ACK', () async {
    final repo = await account();
    await repo.db.execute(
      "CREATE TRIGGER fail_group BEFORE INSERT ON rooms WHEN NEW.id = '${eventRoom('group-room-created').id}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expectLater(
      repo.applyBatch(fixture('replay-batch-1-4')),
      throwsA(isA<DatabaseException>()),
    );
    expect(await repo.cursor(), 0);
    expect(await repo.rooms(), isEmpty);
    await repo.db.execute('DROP TRIGGER fail_group');
    await repo.applyBatch(fixture('replay-batch-1-4'));
    expect(await repo.cursor(), 4);
  });
  test('personal revisions override global version and stale REST cannot roll back unread', () async {
    final repo = await account();
    final room = eventRoom('direct-message-created');
    await repo.mergeRest(rooms: [room]);
    final read = Room.fromJson({
      ...room.json,
      'revision': room.revision + 1,
      'unreadCount': 0,
      'lastReadSeq': 1,
    });
    await repo.mergeRest(rooms: [read]);
    await repo.mergeRest(rooms: [room]);
    expect((await repo.rooms()).single.unreadCount, 0);
    expect((await repo.rooms()).single.version, room.version);
    await expectLater(
      repo.mergeRest(
        rooms: [
          Room.fromJson({...read.json, 'unreadCount': 1, 'lastReadSeq': 0}),
        ],
      ),
      throwsA(isA<ChatFailure>()),
    );
    expect(await repo.cursor(), 0);
  });
  test('full snapshot replaces room cache and preserves messages and queued intents', () async {
    final repo = await account('1');
    final room = eventRoom('direct-room-created');
    await repo.mergeRest(rooms: [room]);
    final id = await repo.enqueue(room.id, 'Offline draft');
    await repo.replaceRoomSnapshot([], testSync(40));
    expect(await repo.rooms(), isEmpty);
    expect((await repo.messages(room.id)).single['client_message_id'], id);
    expect(await repo.counts(), {'queued': 1, 'failed': 0});
    expect(await repo.cursor(), 40);
    expect((await repo.syncState())!['epoch'], testEpoch);
  });
  test(
    'HTTP confirmation merges an optimistic row without moving room cursor',
    () async {
      final repo = await account('1');
      final room = eventRoom('direct-room-created'),
          message = eventMessage('direct-message-created');
      await repo.mergeRest(rooms: [room]);
      await repo.enqueue(room.id, message.text, clientId: message.clientId);
      await repo.mergeRest(
        rooms: [eventRoom('direct-message-created')],
        messages: [message],
      );
      await repo.reconcileMessages(
        room.id,
        [message],
        {'fromRoomSeq': 1, 'throughRoomSeq': 1},
      );
      expect((await repo.messages(room.id)).length, 1);
      expect(await repo.counts(), {'queued': 0, 'failed': 0});
      expect(await repo.cursor(), 0);
    },
  );
  test('bounded reconciliation removes missing canonical rows only within coverage', () async {
    final repo = await account('1');
    final room = eventRoom('direct-message-created'),
        base = eventMessage('direct-message-created');
    await repo.mergeRest(rooms: [room]);
    Message at(int seq) => Message.fromJson({
      ...base.json,
      'id': '30000000-0000-4000-8000-${seq.toString().padLeft(12, '0')}',
      'clientMessageId':
          '40000000-0000-4000-8000-${seq.toString().padLeft(12, '0')}',
      'roomSeq': seq,
    });
    await repo.mergeRest(messages: [at(1), at(2), at(3), at(4)]);
    await repo.enqueue(room.id, 'Pending');
    await repo.reconcileMessages(
      room.id,
      [at(3)],
      {'fromRoomSeq': 2, 'throughRoomSeq': 3},
    );
    expect(
      (await repo.db.query(
        'messages',
        orderBy: 'room_seq',
      )).map((row) => row['room_seq']),
      [null, 1, 3, 4],
    );
    await repo.reconcileMessages(room.id, [], {
      'fromRoomSeq': 3,
      'throughRoomSeq': 3,
    });
    expect(
      (await repo.db.query(
        'messages',
        orderBy: 'room_seq',
      )).map((row) => row['room_seq']),
      [null, 1, 4],
    );
    expect(await repo.counts(), {'queued': 1, 'failed': 0});
  });
  test('large offline message gap shows only verified recent range until HTTP pages bridge it', () async {
    final repo = await account();
    final base = eventMessage('direct-message-created');
    Message at(int seq) => Message.fromJson({
      ...base.json,
      'id': '30000000-0000-4000-8000-${seq.toString().padLeft(12, '0')}',
      'clientMessageId':
          '40000000-0000-4000-8000-${seq.toString().padLeft(12, '0')}',
      'roomSeq': seq,
    });
    await repo.reconcileMessages(
      base.roomId,
      [for (var seq = 1; seq <= 30; seq++) at(seq)],
      {'fromRoomSeq': 1, 'throughRoomSeq': 30},
    );
    await repo.reconcileMessages(
      base.roomId,
      [for (var seq = 101; seq <= 130; seq++) at(seq)],
      {'fromRoomSeq': 101, 'throughRoomSeq': 130},
    );
    expect(
      (await repo.messages(
        base.roomId,
        limit: 200,
      )).map((row) => row['room_seq']),
      orderedEquals(List.generate(30, (i) => 101 + i)),
    );
    expect((await repo.db.query('messages')).length, 60);
    await repo.reconcileMessages(
      base.roomId,
      [for (var seq = 71; seq <= 100; seq++) at(seq)],
      {'fromRoomSeq': 71, 'throughRoomSeq': 100},
      latest: false,
    );
    expect(
      (await repo.messages(
        base.roomId,
        limit: 200,
      )).map((row) => row['room_seq']),
      orderedEquals(List.generate(60, (i) => 71 + i)),
    );
    // An old disconnected page arriving late cannot replace the new range.
    await repo.reconcileMessages(
      base.roomId,
      [for (var seq = 1; seq <= 30; seq++) at(seq)],
      {'fromRoomSeq': 1, 'throughRoomSeq': 30},
      latest: false,
    );
    expect((await repo.messageWindow(base.roomId))!['from_seq'], 71);
  });
  test('installation, sync metadata and pending intent survive restart in isolated accounts', () async {
    final device = await storage.deviceId();
    final repo = await account('1');
    final room = eventRoom('direct-room-created');
    await repo.mergeRest(rooms: [room]);
    final id = await repo.enqueue(room.id, 'Offline draft');
    await repo.outgoingState(id, 'sending', increment: true);
    await repo.close();
    await storage.close();
    storage = LocalStorage(
      factory: databaseFactoryFfi,
      directory: directory.path,
    );
    expect(await storage.deviceId(), device);
    final reopened = await storage.account(defaultDataset, '1');
    opened.add(reopened);
    expect((await reopened.messages(room.id)).single['send_state'], 'queued');
    expect(
      (await reopened.nextOutgoing(DateTime.now()))!['client_message_id'],
      id,
    );
    expect((await reopened.syncState())!['epoch'], testEpoch);
    final other = await account('2');
    expect(await other.rooms(), isEmpty);
    expect(await other.counts(), {'queued': 0, 'failed': 0});
    final otherDataset = await account(
      '1',
      '90000000-0000-4000-8000-000000000099',
    );
    expect(await otherDataset.rooms(), isEmpty);
  });
  test(
    'room-page continuation survives restart without changing replay cursor',
    () async {
      final repo = await account();
      await repo.replaceRoomSnapshot(
        [eventRoom('direct-room-created')],
        {...testSync(10), 'nextCursor': 'opaque-page-2'},
      );
      await repo.setRoomsNextCursor('opaque-page-3');
      await repo.close();
      final reopened = await storage.account(defaultDataset, '2');
      opened.add(reopened);
      expect((await reopened.syncState())!['nextCursor'], 'opaque-page-3');
      expect(await reopened.cursor(), 10);
      await reopened.setRoomsNextCursor(null);
      expect((await reopened.syncState())!['nextCursor'], isNull);
      expect(await reopened.cursor(), 10);
    },
  );
  test(
    'v1 SQLite migration preserves pending work and forces a v2 baseline',
    () async {
      final repo = await account('1');
      final room = eventRoom('direct-room-created');
      await repo.mergeRest(rooms: [room]);
      final clientId = await repo.enqueue(room.id, 'Legacy pending');
      final path = repo.db.path;
      await repo.close();
      final legacy = await databaseFactoryFfi.openDatabase(path);
      await legacy.execute('ALTER TABLE account_meta DROP COLUMN sync_epoch');
      await legacy.execute('ALTER TABLE account_meta DROP COLUMN synced_at');
      await legacy.execute('ALTER TABLE account_meta DROP COLUMN rooms_cursor');
      await legacy.execute('DROP TABLE message_windows');
      await legacy.execute(
        'CREATE TABLE applied_events(stream_seq INTEGER PRIMARY KEY, event_id TEXT, fingerprint TEXT)',
      );
      final oldRoom = {...room.json}
        ..remove('revision')
        ..remove('unreadCount')
        ..remove('lastReadSeq');
      await legacy.update('rooms', {'json': jsonEncode(oldRoom)});
      await legacy.update('account_meta', {
        'schema_version': 1,
        'last_applied_seq': 90,
      });
      await legacy.setVersion(1);
      await legacy.close();
      final migrated = await storage.account(defaultDataset, '1');
      opened.add(migrated);
      expect(await migrated.syncState(), isNull);
      expect(await migrated.cursor(), 0);
      expect((await migrated.rooms()).single.revision, room.version);
      expect(
        (await migrated.messages(room.id)).single['client_message_id'],
        clientId,
      );
      expect(await migrated.counts(), {'queued': 1, 'failed': 0});
      expect(
        await migrated.db.rawQuery(
          "SELECT name FROM sqlite_master WHERE name = 'applied_events'",
        ),
        isEmpty,
      );
    },
  );
  test('retry waits preserve room order and let other rooms send', () async {
    final repo = await account('1');
    final direct = eventRoom('direct-room-created'),
        group = eventRoom('group-room-created');
    await repo.mergeRest(rooms: [direct, group]);
    final first = await repo.enqueue(direct.id, 'First');
    final second = await repo.enqueue(direct.id, 'Second');
    final third = await repo.enqueue(group.id, 'Third');
    await repo.outgoingState(
      first,
      'queued',
      nextAttempt: DateTime.now().millisecondsSinceEpoch + 60000,
    );
    expect(
      (await repo.nextOutgoing(DateTime.now()))!['client_message_id'],
      third,
    );
    await repo.outgoingState(third, 'failed');
    expect(await repo.nextOutgoing(DateTime.now()), isNull);
    await repo.outgoingState(first, 'failed');
    expect(
      (await repo.nextOutgoing(DateTime.now()))!['client_message_id'],
      second,
    );
  });
  test('confirmed message content is immutable', () async {
    final repo = await account();
    final message = eventMessage('direct-message-created');
    await repo.mergeRest(messages: [message]);
    await expectLater(
      repo.mergeRest(
        messages: [
          Message.fromJson({...message.json, 'text': 'Tampered'}),
        ],
      ),
      throwsA(isA<ChatFailure>()),
    );
    expect((await repo.messages(message.roomId)).single['text'], message.text);
  });
  test(
    'query observation cannot miss a commit during its first read',
    () async {
      final repo = await account();
      final started = Completer<void>(), release = Completer<void>();
      var first = true;
      final observations = <List<Room>>[];
      final complete = Completer<void>();
      final subscription = repo
          .watchQuery(() async {
            final rows = await repo.rooms();
            if (first) {
              first = false;
              started.complete();
              await release.future;
            }
            return rows;
          })
          .listen((rows) {
            observations.add(rows);
            if (observations.length == 2) complete.complete();
          });
      await started.future;
      await repo.mergeRest(rooms: [eventRoom('direct-room-created')]);
      release.complete();
      await complete.future;
      expect(observations.first, isEmpty);
      expect(observations.last.length, 1);
      await subscription.cancel();
    },
  );
  test('new empty room accepts authoritative empty HTTP interval', () async {
    final repo = await account();
    final room = eventRoom('direct-room-created');
    await repo.reconcileMessages(room.id, [], {
      'fromRoomSeq': 1,
      'throughRoomSeq': 0,
    });
    expect(await repo.messages(room.id), isEmpty);
    expect((await repo.messageWindow(room.id))!['from_seq'], 1);
  });
  test('HTTP send confirmation extends an adjacent verified window without hiding the message', () async {
    final repo = await account('1');
    final message = eventMessage('direct-message-created');
    await repo.reconcileMessages(message.roomId, [], {
      'fromRoomSeq': 1,
      'throughRoomSeq': 0,
    });
    await repo.mergeRest(messages: [message]);
    expect(
      (await repo.messages(message.roomId)).single['server_id'],
      message.id,
    );
    expect((await repo.messageWindow(message.roomId))!['through_seq'], 1);
  });
  test(
    'server sync time survives batches without using the device clock',
    () async {
      final repo = await account();
      const serverTime = '2026-10-15T01:02:03.000Z';
      await repo.markSynced(serverTime);
      await repo.applyBatch(batch([], from: 1, through: 10));
      expect((await repo.syncState())!['syncedAt'], serverTime);
      expect(await repo.cursor(), 10);
      await expectLater(
        repo.markSynced('invalid-device-time'),
        throwsA(isA<ChatFailure>()),
      );
      expect((await repo.syncState())!['syncedAt'], serverTime);
    },
  );
}
