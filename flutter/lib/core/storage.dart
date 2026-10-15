import 'dart:async';
import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

import 'models.dart';

class LocalStorage {
  LocalStorage({DatabaseFactory? factory, this.directory})
    : factory = factory ?? databaseFactory;
  final DatabaseFactory factory;
  final String? directory;
  Database? _metadata;
  Future<String> get basePath async =>
      directory ?? await factory.getDatabasesPath();

  Future<String> deviceId() async {
    _metadata ??= await factory.openDatabase(
      p.join(await basePath, 'chat_installation.db'),
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (db, version) async {
          await db.execute(
            'CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
          );
        },
      ),
    );
    return _metadata!.transaction((txn) async {
      final rows = await txn.query(
        'metadata',
        where: 'key = ?',
        whereArgs: ['device_id'],
      );
      if (rows.isNotEmpty) return rows.single['value']! as String;
      final id = const Uuid().v4();
      await txn.insert('metadata', {'key': 'device_id', 'value': id});
      return id;
    });
  }

  Future<ChatRepository> account(String dataset, String user) async {
    uuid(dataset);
    userId(user);
    final db = await factory.openDatabase(
      p.join(await basePath, 'chat_${dataset}_$user.db'),
      options: OpenDatabaseOptions(
        version: 2,
        onConfigure: (db) async {
          await db.execute('PRAGMA foreign_keys = ON');
        },
        onCreate: (db, version) async {
          await db.execute(
            'CREATE TABLE account_meta(id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, dataset_id TEXT NOT NULL, user_id TEXT NOT NULL, last_applied_seq INTEGER NOT NULL DEFAULT 0, sync_epoch TEXT, synced_at TEXT, rooms_cursor TEXT, next_local_order INTEGER NOT NULL DEFAULT 1)',
          );
          await db.insert('account_meta', {
            'id': 1,
            'schema_version': 2,
            'dataset_id': dataset,
            'user_id': user,
          });
          await db.execute(
            'CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL)',
          );
          for (final id in demoUsers) {
            await db.insert('users', {'id': id, 'name': 'User $id'});
          }
          await db.execute(
            'CREATE TABLE rooms(id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)',
          );
          await db.execute(
            'CREATE TABLE messages(local_key TEXT PRIMARY KEY, server_id TEXT UNIQUE, room_id TEXT NOT NULL, sender_id TEXT NOT NULL, origin_device_id TEXT, client_message_id TEXT NOT NULL, room_seq INTEGER, text TEXT NOT NULL, server_created_at TEXT, local_created_at TEXT NOT NULL, local_order INTEGER NOT NULL, send_state TEXT NOT NULL, json TEXT, UNIQUE(sender_id, client_message_id))',
          );
          await db.execute(
            'CREATE UNIQUE INDEX room_message_sequence ON messages(room_id, room_seq) WHERE room_seq IS NOT NULL',
          );
          await db.execute(
            'CREATE TABLE message_windows(room_id TEXT PRIMARY KEY, from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL)',
          );
          await db.execute(
            'CREATE TABLE outgoing_messages(client_message_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, text TEXT NOT NULL, local_order INTEGER NOT NULL UNIQUE, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error_code TEXT)',
          );
        },
        onUpgrade: (db, oldVersion, newVersion) async {
          if (oldVersion < 2) {
            await db.execute(
              'ALTER TABLE account_meta ADD COLUMN sync_epoch TEXT',
            );
            await db.execute(
              'ALTER TABLE account_meta ADD COLUMN synced_at TEXT',
            );
            await db.execute(
              'ALTER TABLE account_meta ADD COLUMN rooms_cursor TEXT',
            );
            await db.update('account_meta', {
              'schema_version': 2,
              'last_applied_seq': 0,
            });
            await db.execute('DROP TABLE IF EXISTS applied_events');
            await db.execute(
              'CREATE TABLE message_windows(room_id TEXT PRIMARY KEY, from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL)',
            );
            // Preserve cached entities and outgoing intents; the missing v2 sync
            // baseline forces an authoritative snapshot before resuming.
            final rows = await db.query('rooms');
            for (final row in rows) {
              final value = object(jsonDecode(row['json']! as String));
              value.addAll({
                'revision': value['version'],
                'unreadCount': 0,
                'lastReadSeq': 0,
              });
              await db.update(
                'rooms',
                {'json': jsonEncode(value)},
                where: 'id = ?',
                whereArgs: [row['id']],
              );
            }
          }
        },
      ),
    );
    final meta = (await db.query('account_meta')).single;
    if (meta['dataset_id'] != dataset || meta['user_id'] != user) {
      await db.close();
      throw const ChatFailure(
        'DATASET_MISMATCH',
        'Account database identity mismatch.',
      );
    }
    await db.transaction((txn) async {
      await txn.update(
        'outgoing_messages',
        {'state': 'queued'},
        where: 'state = ?',
        whereArgs: ['sending'],
      );
      await txn.update(
        'messages',
        {'send_state': 'queued'},
        where: 'send_state = ?',
        whereArgs: ['sending'],
      );
    });
    return ChatRepository(db, dataset, user);
  }

  Future<void> close() async {
    await _metadata?.close();
    _metadata = null;
  }
}

class ChatRepository {
  ChatRepository(this.db, this.dataset, this.user);
  final Database db;
  final String dataset;
  final String user;
  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;
  Stream<T> watchQuery<T>(Future<T> Function() query) {
    late StreamController<void> triggers;
    StreamSubscription<void>? subscription;
    triggers = StreamController<void>(
      onListen: () {
        // Subscribe before the initial query so a concurrent commit is never lost.
        subscription = changes.listen(
          triggers.add,
          onError: triggers.addError,
          onDone: triggers.close,
        );
        triggers.add(null);
      },
      onCancel: () async {
        await subscription?.cancel();
      },
    );
    return triggers.stream.asyncMap((_) => query());
  }

  void _notify() {
    if (!_changes.isClosed) _changes.add(null);
  }

  Future<int> cursor() async =>
      (await db.query('account_meta')).single['last_applied_seq']! as int;
  Future<List<Room>> rooms() async =>
      (await db.query('rooms', orderBy: 'updated_at DESC, id'))
          .map(
            (row) => Room.fromJson(object(jsonDecode(row['json']! as String))),
          )
          .toList();
  Future<List<Json>> messages(String roomId, {int limit = 50}) async {
    final rows = await db.rawQuery(
      'SELECT m.* FROM messages m LEFT JOIN message_windows w ON w.room_id = m.room_id WHERE m.room_id = ? AND (m.room_seq IS NULL OR w.room_id IS NULL OR m.room_seq BETWEEN w.from_seq AND w.through_seq) ORDER BY m.room_seq IS NULL DESC, m.room_seq DESC, m.local_order DESC LIMIT ?',
      [roomId, limit],
    );
    return rows.reversed.map((row) => Map<String, dynamic>.from(row)).toList();
  }

  Future<Json?> latestPending(String roomId) async {
    final rows = await db.query(
      'messages',
      where: 'room_id = ? AND room_seq IS NULL',
      whereArgs: [roomId],
      orderBy: 'local_order DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : Map<String, dynamic>.from(rows.single);
  }

  Future<Json> counts() async {
    final pending = Sqflite.firstIntValue(
      await db.rawQuery(
        "SELECT COUNT(*) FROM outgoing_messages WHERE state != 'failed'",
      ),
    )!;
    final failed = Sqflite.firstIntValue(
      await db.rawQuery(
        "SELECT COUNT(*) FROM outgoing_messages WHERE state = 'failed'",
      ),
    )!;
    return {'queued': pending, 'failed': failed};
  }

  Future<String> enqueue(String roomId, String text, {String? clientId}) async {
    uuid(roomId);
    validateText(text);
    final id = clientId ?? const Uuid().v4();
    uuid(id);
    await db.transaction((txn) async {
      final count = Sqflite.firstIntValue(
        await txn.rawQuery('SELECT COUNT(*) FROM outgoing_messages'),
      )!;
      if (count >= 1000) {
        throw const ChatFailure('QUEUE_FULL', 'The pending queue is full.');
      }
      final room = await txn.query(
        'rooms',
        where: 'id = ?',
        whereArgs: [roomId],
      );
      if (room.isEmpty ||
          !Room.fromJson(object(jsonDecode(room.single['json']! as String)))
              .members
              .contains(user)) {
        throw const ChatFailure(
          'ROOM_FORBIDDEN',
          'This account cannot send to this room.',
        );
      }
      final order =
          (await txn.query('account_meta')).single['next_local_order']! as int;
      await txn.update('account_meta', {'next_local_order': order + 1});
      await txn.insert('messages', {
        'local_key': 'client:$id',
        'room_id': roomId,
        'sender_id': user,
        'client_message_id': id,
        'text': text,
        'local_created_at': DateTime.now().toUtc().toIso8601String(),
        'local_order': order,
        'send_state': 'queued',
      });
      await txn.insert('outgoing_messages', {
        'client_message_id': id,
        'room_id': roomId,
        'text': text,
        'local_order': order,
        'state': 'queued',
      });
    });
    _notify();
    return id;
  }

  Future<void> _room(DatabaseExecutor txn, Room incoming) async {
    if (!incoming.members.contains(user)) {
      throw const ChatFailure('ROOM_FORBIDDEN', 'Room excludes this account.');
    }
    final existing = await txn.query(
      'rooms',
      where: 'id = ?',
      whereArgs: [incoming.id],
    );
    if (existing.isNotEmpty) {
      final version = existing.single['version']! as int;
      if (version > incoming.revision) return;
      if (version == incoming.revision) {
        if (fingerprint(jsonDecode(existing.single['json']! as String)) !=
            fingerprint(incoming.json)) {
          throw const ChatFailure(
            'INTEGRITY_ERROR',
            'Conflicting room snapshot.',
          );
        }
        return;
      }
    }
    await txn.insert('rooms', {
      'id': incoming.id,
      'version': incoming.revision,
      'updated_at': incoming.json['updatedAt'],
      'json': jsonEncode(incoming.json),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> _message(DatabaseExecutor txn, Message incoming) async {
    final existing = await txn.query(
      'messages',
      where: 'server_id = ? OR (sender_id = ? AND client_message_id = ?)',
      whereArgs: [incoming.id, incoming.senderId, incoming.clientId],
    );
    if (existing.length > 1) {
      throw const ChatFailure(
        'INTEGRITY_ERROR',
        'Message has conflicting canonical identities.',
      );
    }
    if (existing.isNotEmpty) {
      final row = existing.single;
      if (row['json'] != null &&
          fingerprint(jsonDecode(row['json']! as String)) !=
              fingerprint(incoming.json)) {
        throw const ChatFailure(
          'INTEGRITY_ERROR',
          'Confirmed message changed.',
        );
      }
      if (row['room_id'] != incoming.roomId ||
          row['text'] != incoming.text ||
          row['sender_id'] != incoming.senderId ||
          row['client_message_id'] != incoming.clientId) {
        throw const ChatFailure(
          'INTEGRITY_ERROR',
          'Optimistic message identity changed.',
        );
      }
    }
    final key = existing.isEmpty
        ? 'server:${incoming.id}'
        : existing.single['local_key']! as String;
    final value = <String, Object?>{
      'local_key': key,
      'server_id': incoming.id,
      'room_id': incoming.roomId,
      'sender_id': incoming.senderId,
      'origin_device_id': incoming.json['originDeviceId'],
      'client_message_id': incoming.clientId,
      'room_seq': incoming.roomSeq,
      'text': incoming.text,
      'server_created_at': incoming.json['createdAt'],
      'local_created_at': existing.isEmpty
          ? incoming.json['createdAt']
          : existing.single['local_created_at'],
      'local_order': existing.isEmpty ? 0 : existing.single['local_order'],
      'send_state': 'sent',
      'json': jsonEncode(incoming.json),
    };
    if (existing.isEmpty) {
      await txn.insert('messages', value);
    } else {
      await txn.update(
        'messages',
        value,
        where: 'local_key = ?',
        whereArgs: [key],
      );
    }
    // A confirmed HTTP message adjacent to the verified cache extends it;
    // a nonadjacent response cannot conceal a missing history interval.
    final coverage = await txn.query(
      'message_windows',
      where: 'room_id = ?',
      whereArgs: [incoming.roomId],
    );
    if (coverage.isNotEmpty) {
      final from = coverage.single['from_seq']! as int;
      final through = coverage.single['through_seq']! as int;
      if (incoming.roomSeq == through + 1) {
        await txn.update(
          'message_windows',
          {'through_seq': incoming.roomSeq},
          where: 'room_id = ?',
          whereArgs: [incoming.roomId],
        );
      } else if (incoming.roomSeq == from - 1) {
        await txn.update(
          'message_windows',
          {'from_seq': incoming.roomSeq},
          where: 'room_id = ?',
          whereArgs: [incoming.roomId],
        );
      }
    }
    // A same-user message originating on another device has no local queue entry.
    if (incoming.senderId == user) {
      await txn.delete(
        'outgoing_messages',
        where: 'client_message_id = ?',
        whereArgs: [incoming.clientId],
      );
    }
  }

  Future<void> mergeRest({
    List<Room> rooms = const [],
    List<Message> messages = const [],
  }) async {
    await db.transaction((txn) async {
      for (final room in rooms) {
        await _room(txn, room);
      }
      for (final message in messages) {
        await _message(txn, message);
      }
    });
    _notify();
  }

  Future<Json?> syncState() async {
    final meta = (await db.query('account_meta')).single;
    if (meta['sync_epoch'] == null || meta['synced_at'] == null) return null;
    return {
      'epoch': meta['sync_epoch'],
      'throughSeq': meta['last_applied_seq'],
      'syncedAt': meta['synced_at'],
      'nextCursor': meta['rooms_cursor'],
    };
  }

  Future<void> replaceRoomSnapshot(List<Room> rooms, Json sync) async {
    final epoch = uuid(sync['epoch']);
    final through = sequence(sync['throughSeq']);
    final syncedAt = timestamp(sync['syncedAt']);
    final nextCursor = sync['nextCursor'] == null
        ? null
        : string(sync['nextCursor'], 'nextCursor');
    if (rooms.map((room) => room.id).toSet().length != rooms.length) {
      invalid('Duplicate room snapshot.');
    }
    await db.transaction((txn) async {
      await txn.delete('rooms');
      for (final room in rooms) {
        await _room(txn, room);
      }
      await txn.update('account_meta', {
        'sync_epoch': epoch,
        'last_applied_seq': through,
        'synced_at': syncedAt,
        'rooms_cursor': nextCursor,
      });
    });
    _notify();
  }

  Future<void> setRoomsNextCursor(String? cursor) async {
    await db.update('account_meta', {'rooms_cursor': cursor});
  }

  Future<void> markSynced(String syncedAt) async {
    // Resume age is evaluated by the server. A device clock must not turn a
    // valid baseline into a future timestamp that the Worker rejects.
    await db.update('account_meta', {'synced_at': timestamp(syncedAt)});
  }

  Future<Json?> messageWindow(String roomId) async {
    final rows = await db.query(
      'message_windows',
      where: 'room_id = ?',
      whereArgs: [roomId],
    );
    return rows.isEmpty ? null : Map<String, dynamic>.from(rows.single);
  }

  Future<void> reconcileMessages(
    String roomId,
    List<Message> messages,
    Json window, {
    bool latest = true,
  }) async {
    uuid(roomId);
    final from = sequence(window['fromRoomSeq']);
    final through = sequence(window['throughRoomSeq']);
    if (from > through + 1 ||
        messages.any(
          (message) =>
              message.roomId != roomId ||
              message.roomSeq < from ||
              message.roomSeq > through,
        ) ||
        messages.map((message) => message.roomSeq).toSet().length !=
            messages.length) {
      invalid('Invalid message window.');
    }
    await db.transaction((txn) async {
      final keep = messages.map((message) => message.id).toList();
      await txn.delete(
        'messages',
        where:
            'room_id = ? AND room_seq >= ? AND room_seq <= ? AND server_id IS NOT NULL${keep.isEmpty ? '' : ' AND server_id NOT IN (${List.filled(keep.length, '?').join(',')})'}',
        whereArgs: [roomId, from, through, ...keep],
      );
      for (final message in messages) {
        await _message(txn, message);
      }
      final coverage = await txn.query(
        'message_windows',
        where: 'room_id = ?',
        whereArgs: [roomId],
      );
      final priorFrom = coverage.isEmpty
          ? from
          : coverage.single['from_seq']! as int;
      final priorThrough = coverage.isEmpty
          ? through
          : coverage.single['through_seq']! as int;
      final joins = priorThrough + 1 >= from && through + 1 >= priorFrom;
      if (coverage.isEmpty || joins || latest) {
        await txn.insert('message_windows', {
          'room_id': roomId,
          'from_seq': joins ? (from < priorFrom ? from : priorFrom) : from,
          'through_seq': joins
              ? (through > priorThrough ? through : priorThrough)
              : through,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }
    });
    _notify();
  }

  Future<int> applyBatch(Json batch) async {
    if (batch['v'] != 2 ||
        batch['type'] != 'events.batch' ||
        utf8.encode(jsonEncode(batch)).length > 65536) {
      invalid('Invalid batch frame.');
    }
    uuid(batch['batchId']);
    final epoch = uuid(batch['epoch']);
    final from = sequence(batch['fromSeq'], positive: true);
    final to = sequence(batch['toSeq'], positive: true);
    final raw = batch['events'];
    if (to < from || raw is! List || raw.length > 50) {
      invalid('Invalid batch coverage.');
    }
    final events = raw
        .map(
          (e) => DurableEvent.fromJson(
            object(e),
            dataset: dataset,
            recipient: user,
          ),
        )
        .toList();
    var previous = from - 1;
    final roomIds = <String>{};
    for (final event in events) {
      if (event.seq <= previous ||
          event.seq < from ||
          event.seq > to ||
          !roomIds.add(event.room.id)) {
        invalid('Invalid compacted delta order.');
      }
      previous = event.seq;
    }
    await db.transaction((txn) async {
      final meta = (await txn.query('account_meta')).single;
      final current = meta['last_applied_seq']! as int;
      if (meta['sync_epoch'] != epoch) {
        throw const ChatFailure(
          'SYNC_REQUIRED',
          'Room snapshot baseline changed.',
        );
      }
      if (from > current + 1) {
        throw const ChatFailure('SEQ_GAP', 'Missing room delta coverage.');
      }
      if (to <= current) return;
      for (final event in events) {
        await _room(txn, event.room);
      }
      await txn.update('account_meta', {'last_applied_seq': to});
    });
    _notify();
    return to;
  }

  Future<Json?> nextOutgoing(DateTime now) async {
    // A waiting retry holds later sends in its room, but does not block another room.
    final rows = await db.rawQuery(
      "SELECT o.* FROM outgoing_messages o WHERE o.state = 'queued' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?) AND NOT EXISTS (SELECT 1 FROM outgoing_messages older WHERE older.room_id = o.room_id AND older.local_order < o.local_order AND older.state IN ('queued','sending')) ORDER BY o.local_order LIMIT 1",
      [now.millisecondsSinceEpoch],
    );
    return rows.isEmpty ? null : Map<String, dynamic>.from(rows.single);
  }

  Future<void> outgoingState(
    String id,
    String state, {
    String? error,
    int? nextAttempt,
    bool increment = false,
  }) async {
    await db.transaction((txn) async {
      final rows = await txn.query(
        'outgoing_messages',
        where: 'client_message_id = ?',
        whereArgs: [id],
      );
      if (rows.isEmpty) return; // The WebSocket may have confirmed it first.
      await txn.update(
        'outgoing_messages',
        {
          'state': state,
          'last_error_code': error,
          'next_attempt_at': nextAttempt,
          'attempts': (rows.single['attempts']! as int) + (increment ? 1 : 0),
        },
        where: 'client_message_id = ?',
        whereArgs: [id],
      );
      await txn.update(
        'messages',
        {'send_state': state},
        where: 'sender_id = ? AND client_message_id = ? AND room_seq IS NULL',
        whereArgs: [user, id],
      );
    });
    _notify();
  }

  Future<void> close() async {
    await db.close();
    await _changes.close();
  }
}
