import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart'
    show debugPrintSynchronously, kDebugMode;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';
import 'models.dart';
import 'storage.dart';

abstract interface class ChatSocket {
  Stream<dynamic> get stream;
  Future<void> get ready;
  int? get closeCode;
  void send(String data);
  Future<void> close();
}

class StandardChatSocket implements ChatSocket {
  StandardChatSocket(Uri uri) : channel = WebSocketChannel.connect(uri);
  final WebSocketChannel channel;
  @override
  Stream<dynamic> get stream => channel.stream;
  @override
  Future<void> get ready => channel.ready;
  @override
  int? get closeCode => channel.closeCode;
  @override
  void send(String data) => channel.sink.add(data);
  @override
  Future<void> close() async {
    await channel.sink.close(1000);
  }
}

typedef SocketFactory = ChatSocket Function(Uri uri);
typedef SyncLogSink = void Function(String message);

enum FullSnapshotReason {
  firstUse('FIRST_USE'),
  baselineExpired('BASELINE_EXPIRED_48H'),
  epochChanged('EPOCH_CHANGED'),
  cursorExpired('CURSOR_EXPIRED'),
  cursorAhead('CURSOR_AHEAD'),
  deltaTooLarge('DELTA_TOO_LARGE'),
  coverageGap('COVERAGE_GAP'),
  manualRefresh('MANUAL_REFRESH'),
  serverRequired('SERVER_REQUIRED');

  const FullSnapshotReason(this.label);
  final String label;

  static FullSnapshotReason fromServer(Object? value) => switch (value) {
    'EPOCH_CHANGED' => epochChanged,
    'CURSOR_EXPIRED' => cursorExpired,
    'CURSOR_AHEAD' => cursorAhead,
    'DELTA_TOO_LARGE' => deltaTooLarge,
    _ => serverRequired,
  };
}

class AccountSession {
  AccountSession({
    required this.repository,
    required this.api,
    required this.onChanged,
    SocketFactory? socketFactory,
    Random? random,
    SyncLogSink? syncLog,
  }) : _syncLog = syncLog ?? debugPrintSynchronously,
       socketFactory = socketFactory ?? StandardChatSocket.new,
       random = random ?? Random();
  final ChatRepository repository;
  final ApiClient api;
  final void Function() onChanged;
  final SocketFactory socketFactory;
  final Random random;
  final SyncLogSink _syncLog;
  String state = 'idle';
  String? diagnostic;
  int? remoteHead;
  final Map<String, Presence> presence = {};
  bool foreground = true;
  bool _active = true;
  bool _blocked = false;
  bool _sessionNeedsRenewal = false;
  int _authFailures = 0;
  int _socketGeneration = 0;
  ChatSocket? _socket;
  StreamSubscription<dynamic>? _subscription;
  StreamSubscription<void>? _repositorySubscription;
  Timer? _reconnect,
      _heartbeat,
      _pong,
      _handshake,
      _presenceRefresh,
      _stable,
      _queueTimer,
      _freshness;
  Future<void> _serial = Future.value();
  Future<void>? _sendOperation;
  Future<void>? _connectOperation;
  int _attempts = 0;
  bool _hello = false;
  bool _resumeAccepted = false;
  int? _resumeAfter, _replayTarget;
  String? _connectionId;
  bool _needsFullSync = false;
  FullSnapshotReason? _fullSnapshotReason;
  String? _roomsNextCursor;
  bool _loadingRooms = false;
  String? get roomsNextCursor => _roomsNextCursor;
  bool get loadingRooms => _loadingRooms;
  String? _activeRoom;
  int _roomGeneration = 0;
  final Map<String, Future<Json>> _historyOperations = {};
  final Set<String> _historyDirty = {};
  final Map<String, Json> _latestHistory = {};
  Json? latestHistory(String roomId) => _latestHistory[roomId];
  int _historyRevision = 0;
  String? _epoch;
  Future<void>? _readOperation;
  int _readWanted = 0;
  String? _readRoom;
  final Map<String, int> _readSent = {};
  String? get connectionId => _connectionId;
  bool get connected =>
      _active &&
      foreground &&
      _resumeAccepted &&
      ['replaying', 'live'].contains(state);
  bool _current(int generation) =>
      _active && foreground && generation == _socketGeneration;
  // Only fixed labels, validated protocol IDs, counters and enum reasons belong here.
  // Logging must never disrupt SQLite/ACK behavior or print a payload/ticket/exception.
  void _log(String event, [Map<String, Object> fields = const {}]) {
    if (!kDebugMode) return;
    try {
      _syncLog(
        '[RoomSyncClient] $event user=${repository.user}'
        '${fields.entries.map((entry) => ' ${entry.key}=${entry.value}').join()}',
      );
    } catch (_) {
      // A failed diagnostic sink cannot change synchronization behavior.
    }
  }

  void _notify() {
    if (_active) onChanged();
  }

  void _state(String value, [String? reason]) {
    state = value;
    diagnostic = reason;
    _notify();
  }

  Future<void> start() async {
    _repositorySubscription = repository.changes.listen((_) {
      _notify();
      unawaited(drain());
    });
    _queueTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      unawaited(drain());
      if (foreground &&
          !_blocked &&
          _socket == null &&
          _connectOperation == null &&
          _reconnect == null) {
        unawaited(connect());
      }
    });
    _freshness = Timer.periodic(const Duration(seconds: 10), (_) => _notify());
    unawaited(connect());
    unawaited(drain());
  }

  Future<void> connect({bool manual = false}) async {
    if (!_active || !foreground || _connectOperation != null) return;
    if (manual) {
      _blocked = false;
      _attempts = 0;
      _authFailures = 0;
      _sessionNeedsRenewal = true;
      _reconnect?.cancel();
      _reconnect = null;
    }
    if (_blocked) return;
    final operation = _connect();
    _connectOperation = operation;
    try {
      await operation;
    } finally {
      _connectOperation = null;
    }
  }

  Future<void> _connect() async {
    await _retire();
    final generation = _socketGeneration;
    if (!_current(generation)) return;
    try {
      _state('obtainingSession');
      await api.session(force: _sessionNeedsRenewal);
      _sessionNeedsRenewal = false;
      if (!_current(generation)) return;
      final sync = await repository.syncState();
      _roomsNextCursor = sync?['nextCursor'] as String?;
      final snapshotReason = _needsFullSync
          ? _fullSnapshotReason ?? FullSnapshotReason.serverRequired
          : sync == null
          ? FullSnapshotReason.firstUse
          : DateTime.now()
                    .toUtc()
                    .difference(DateTime.parse(timestamp(sync['syncedAt'])))
                    .inMilliseconds >=
                172800000
          ? FullSnapshotReason.baselineExpired
          : null;
      if (snapshotReason != null) {
        await _loadSnapshot(generation: generation, reason: snapshotReason);
        _needsFullSync = false;
        _fullSnapshotReason = null;
      }
      if (!_current(generation)) return;
      _state('obtainingTicket');
      final ticket = await api.request('POST', '/realtime/ticket', data: {});
      if (!_current(generation)) return;
      final base = Uri.parse(string(ticket['url'], 'socket URL'));
      if (!['ws', 'wss'].contains(base.scheme) ||
          base.userInfo.isNotEmpty ||
          base.hasFragment) {
        invalid('Invalid socket URL.');
      }
      // Ticket is used only in the upgrade URL and never rendered/logged.
      final uri = base.replace(
        queryParameters: {
          ...base.queryParameters,
          'ticket': string(ticket['ticket'], 'ticket'),
        },
      );
      final socket = socketFactory(uri);
      _socket = socket;
      _state('connecting');
      _handshake = Timer(
        const Duration(seconds: 10),
        () => _failure(
          generation,
          const ChatFailure(
            'HANDSHAKE_TIMEOUT',
            'Timed out waiting for hello/resume.',
            retryable: true,
          ),
        ),
      );
      _subscription = socket.stream.listen(
        (raw) {
          _received(raw, generation);
        },
        onError: (_) {
          _failure(
            generation,
            const ChatFailure(
              'SOCKET_UNAVAILABLE',
              'Realtime transport unavailable.',
              retryable: true,
            ),
          );
        },
        onDone: () {
          _closed(generation, socket.closeCode);
        },
      );
      await socket.ready.timeout(const Duration(seconds: 10));
      if (_current(generation) && !_hello) _state('awaitingHello');
    } on ChatFailure catch (error) {
      _failure(generation, error);
    } catch (_) {
      _failure(
        generation,
        const ChatFailure(
          'SOCKET_UNAVAILABLE',
          'Realtime connection failed.',
          retryable: true,
        ),
      );
    }
  }

  void _send(Json frame) => _socket?.send(jsonEncode({'v': 2, ...frame}));
  void _received(dynamic raw, int generation) {
    if (!_current(generation)) return;
    if (raw == 'pong') {
      _pong?.cancel();
      _pong = null;
      return;
    }
    Json frame;
    try {
      if (raw is! String || utf8.encode(raw).length > 65536) {
        invalid('Invalid incoming frame.');
      }
      frame = object(jsonDecode(raw));
      if (frame['v'] != 2) invalid('Unsupported protocol.');
      if (frame['type'] == 'sync.required') {
        _fullSnapshotReason = FullSnapshotReason.fromServer(frame['reason']);
        _log('FULL_SNAPSHOT_REQUIRED', {
          'reason': _fullSnapshotReason!.label,
          'source': 'server_frame',
        });
      }
      if (frame['type'] == 'presence.snapshot' ||
          frame['type'] == 'presence.changed') {
        _presenceFrame(frame);
        return;
      }
    } catch (error) {
      _failure(
        generation,
        error is ChatFailure
            ? error
            : const ChatFailure('PROTOCOL_ERROR', 'Invalid realtime data.'),
      );
      return;
    }
    // Durable/control handling is serial; heartbeat and presence bypass SQL replay.
    _serial = _serial
        .then((_) async {
          if (!_current(generation)) return;
          switch (frame['type']) {
            case 'hello':
              if (_hello ||
                  frame['datasetId'] != repository.dataset ||
                  frame['userId'] != repository.user ||
                  frame['deviceId'] != api.device) {
                invalid('Hello identity mismatch.');
              }
              _connectionId = uuid(frame['connectionId']);
              remoteHead = sequence(frame['headSeq']);
              final sync = await repository.syncState();
              if (!_current(generation)) return;
              if (sync == null || uuid(frame['epoch']) != sync['epoch']) {
                _needsFullSync = true;
                _fullSnapshotReason = sync == null
                    ? FullSnapshotReason.firstUse
                    : FullSnapshotReason.epochChanged;
                _log('FULL_SNAPSHOT_REQUIRED', {
                  'reason': _fullSnapshotReason!.label,
                  'source': 'hello',
                });
                throw const ChatFailure(
                  'SYNC_REQUIRED',
                  'Room baseline changed.',
                  retryable: true,
                );
              }
              _epoch = sync['epoch'] as String;
              sequence(frame['replayFloor']);
              if (frame['retentionMs'] != 172800000 ||
                  frame['heartbeatIntervalMs'] != 20000 ||
                  frame['heartbeatTimeoutMs'] != 10000) {
                invalid('Unsupported hello parameters.');
              }
              timestamp(frame['sessionExpiresAt']);
              _hello = true;
              _state('resuming');
              _resumeAfter = await repository.cursor();
              if (!_current(generation)) return;
              _send({
                'type': 'resume',
                'epoch': sync['epoch'],
                'afterSeq': _resumeAfter,
                'syncedAt': sync['syncedAt'],
              });
              _log('DELTA_RESUME_SENT', {'afterSeq': _resumeAfter!});
              _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
                if (!_current(generation) || _pong != null) return;
                _socket?.send('ping');
                _pong = Timer(
                  const Duration(seconds: 10),
                  () => _failure(
                    generation,
                    const ChatFailure(
                      'HEARTBEAT_TIMEOUT',
                      'Realtime heartbeat timed out.',
                      retryable: true,
                    ),
                  ),
                );
              });
            case 'sync.started':
              if (!_hello ||
                  _resumeAccepted ||
                  frame['afterSeq'] != _resumeAfter ||
                  frame['epoch'] != _epoch) {
                invalid('Unexpected resume confirmation.');
              }
              _replayTarget = sequence(frame['targetSeq']);
              if (_replayTarget! < _resumeAfter!) {
                invalid('Invalid replay target.');
              }
              _resumeAccepted = true;
              remoteHead = _replayTarget;
              _handshake?.cancel();
              _state('replaying');
              _log('DELTA_SYNC_STARTED', {
                'afterSeq': _resumeAfter!,
                'targetSeq': _replayTarget!,
              });
              _send({
                'type': 'presence.watch',
                'userIds': demoUsers
                    .where((id) => id != repository.user)
                    .toList(),
              });
              // presence.watch already returns the initial snapshot.
              _presenceRefresh = Timer.periodic(const Duration(seconds: 30), (
                _,
              ) {
                if (_current(generation)) _send({'type': 'presence.refresh'});
              });
              _stable = Timer(const Duration(seconds: 30), () {
                if (_current(generation) && _resumeAccepted) _attempts = 0;
              });
            // Room deltas, rather than unconditional REST snapshots, drive reconnects.
            case 'events.batch':
              if (!_resumeAccepted) invalid('Batch before resume.');
              final batchId = uuid(frame['batchId']);
              final from = sequence(frame['fromSeq'], positive: true);
              final to = sequence(frame['toSeq'], positive: true);
              if (frame['events'] is! List) invalid('Invalid delta rows.');
              final batchFields = <String, Object>{
                'batch': batchId,
                'fromSeq': from,
                'throughSeq': to,
                'rowsInBatch': (frame['events'] as List).length,
              };
              _log('DELTA_RECEIVED', {
                ...batchFields,
                'phase': state == 'live' ? 'live' : 'replay',
              });
              final before = await repository.cursor();
              if (!_current(generation)) return;
              int through;
              try {
                through = await repository.applyBatch(frame);
              } catch (_) {
                _log('DELTA_SAVE_FAILED', batchFields);
                rethrow;
              }
              _log(
                through > before
                    ? 'DELTA_SQLITE_COMMITTED'
                    : 'DELTA_ALREADY_SAVED',
                {...batchFields, 'savedCursor': max(before, through)},
              );
              if (!_current(generation)) {
                _log('DELTA_ACK_SKIPPED', {
                  ...batchFields,
                  'reason': 'CONNECTION_RETIRED',
                });
                return;
              }
              remoteHead = max(remoteHead ?? 0, through);
              _send({
                'type': 'ack',
                'batchId': frame['batchId'],
                'throughSeq': through,
              });
              _log('DELTA_ACK_SENT', {...batchFields, 'throughSeq': through});
              _notify();
              if ((frame['events'] as List).any(
                (event) =>
                    object(object(object(event)['data'])['room'])['id'] ==
                    _activeRoom,
              )) {
                unawaited(refreshActiveRoom());
              }
            case 'sync.required':
              _needsFullSync = true;
              throw const ChatFailure(
                'SYNC_REQUIRED',
                'Room snapshot required.',
                retryable: true,
              );
            case 'sync.ready':
              final committed = await repository.cursor();
              if (!_current(generation)) return;
              if (!_resumeAccepted ||
                  state != 'replaying' ||
                  frame['epoch'] != _epoch ||
                  sequence(frame['throughSeq']) < _replayTarget! ||
                  committed < sequence(frame['throughSeq'])) {
                invalid('Invalid sync.ready boundary.');
              }
              remoteHead = max(remoteHead ?? 0, sequence(frame['throughSeq']));
              await repository.markSynced(timestamp(frame['syncedAt']));
              if (!_current(generation)) return;
              _state('live');
              _log('DELTA_SYNC_READY', {'savedCursor': committed});
              unawaited(refreshActiveRoom());
            case 'error':
              throw ChatFailure(
                string(frame['code'], 'error code'),
                string(frame['message'], 'error message'),
                retryable: frame['retryable'] == true,
              );
            default:
              invalid('Unknown server frame.');
          }
        })
        .catchError((Object error) {
          _failure(
            generation,
            error is ChatFailure
                ? error
                : const ChatFailure(
                    'PROTOCOL_ERROR',
                    'Could not apply realtime data.',
                  ),
          );
        });
  }

  void _presenceFrame(Json frame) {
    switch (frame['type']) {
      case 'presence.snapshot':
        if (!_resumeAccepted || frame['items'] is! List) {
          invalid('Invalid presence snapshot.');
        }
        final parsed = (frame['items'] as List)
            .map((item) => Presence.fromJson(object(item)))
            .toList();
        if (parsed.map((item) => item.id).toSet().length != parsed.length ||
            parsed.any((item) => item.id == repository.user)) {
          invalid('Invalid presence watch result.');
        }
        for (final item in parsed) {
          _presence(item);
        }
        _notify();
      case 'presence.changed':
        if (!_resumeAccepted) invalid('Presence before resume.');
        _presence(Presence.fromJson(object(frame['item'])));
        _notify();
      default:
        invalid('Invalid presence frame.');
    }
  }

  void _presence(Presence item) {
    if (item.id == repository.user) invalid('Presence excludes the viewer.');
    final previous = presence[item.id];
    if (previous?.revision != null &&
        item.revision != null &&
        item.revision! < previous!.revision!) {
      return;
    }
    presence[item.id] = item;
  }

  String presenceFor(String user) =>
      presence[user]?.freshState(DateTime.now(), connected: connected) ??
      'unknown';

  void _closed(int generation, int? code) {
    if (!_current(generation)) return;
    if (code == 4010) {
      _needsFullSync = true;
      if (_fullSnapshotReason == null) {
        _fullSnapshotReason = FullSnapshotReason.serverRequired;
        _log('FULL_SNAPSHOT_REQUIRED', {
          'reason': _fullSnapshotReason!.label,
          'source': 'close_4010',
        });
      }
    }
    if (code == 4001 || code == 1008) {
      _sessionNeedsRenewal = true;
      if (code == 1008 && ++_authFailures > 1) {
        _failure(
          generation,
          const ChatFailure(
            'UNAUTHORIZED',
            'Realtime authorization failed after session renewal.',
          ),
        );
        return;
      }
    }
    if ([4002, 4009, 1009].contains(code)) {
      _failure(
        generation,
        ChatFailure(
          code == 4009 ? 'DEVICE_REPLACED' : 'PROTOCOL_ERROR',
          code == 4009
              ? 'Another connection replaced this device. Use Retry connection explicitly.'
              : 'Realtime protocol error ($code).',
        ),
      );
    } else {
      _failure(
        generation,
        const ChatFailure(
          'REALTIME_UNAVAILABLE',
          'Realtime disconnected; cached data is available.',
          retryable: true,
        ),
      );
    }
  }

  void _failure(int generation, ChatFailure error) {
    if (!_current(generation)) return;
    if (['SEQ_GAP', 'SYNC_REQUIRED'].contains(error.code)) {
      _needsFullSync = true;
      _fullSnapshotReason ??= error.code == 'SEQ_GAP'
          ? FullSnapshotReason.coverageGap
          : FullSnapshotReason.serverRequired;
      if (error.code == 'SEQ_GAP') {
        _log('FULL_SNAPSHOT_REQUIRED', {
          'reason': _fullSnapshotReason!.label,
          'source': 'local_coverage_check',
        });
      }
      error = ChatFailure(error.code, error.message, retryable: true);
    }
    _blocked = !error.retryable;
    _state(
      _blocked ? 'blocked' : 'retryWaiting',
      '${error.code}: ${error.message}',
    );
    unawaited(_retire());
    if (!_blocked && _active && foreground) {
      final ms = random.nextInt(
        min(30000, 1000 * (1 << min(_attempts++, 5))) + 1,
      );
      _reconnect?.cancel();
      _reconnect = Timer(Duration(milliseconds: ms), () {
        _reconnect = null;
        unawaited(connect());
      });
    }
  }

  Future<void> _retire() async {
    _socketGeneration++;
    _hello = false;
    _resumeAccepted = false;
    _connectionId = null;
    presence.clear();
    for (final timer in [
      _heartbeat,
      _pong,
      _handshake,
      _presenceRefresh,
      _stable,
    ]) {
      timer?.cancel();
    }
    _heartbeat = null;
    _pong = null;
    _handshake = null;
    _presenceRefresh = null;
    _stable = null;
    final socket = _socket;
    _socket = null;
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    try {
      await socket?.close().timeout(const Duration(seconds: 1));
    } catch (_) {
      /* Best-effort close cannot prevent a new generation. */
    }
  }

  Future<void> _loadSnapshot({
    required int generation,
    required FullSnapshotReason reason,
  }) async {
    final elapsed = Stopwatch()..start();
    _log('FULL_SNAPSHOT_REQUESTED', {'reason': reason.label, 'limit': 20});
    try {
      final result = await api.request('GET', '/rooms', query: {'limit': 20});
      if (!_current(generation)) {
        throw const ChatFailure('CANCELLED', 'Account or foreground changed.');
      }
      final rooms = (result['rooms'] as List)
          .map((row) => Room.fromJson(object(row)))
          .toList();
      final sync = object(result['sync']);
      final through = sequence(sync['throughSeq']);
      _log('FULL_SNAPSHOT_RECEIVED', {
        'reason': reason.label,
        'rooms': rooms.length,
        'throughSeq': through,
      });
      await repository.replaceRoomSnapshot(rooms, {
        ...sync,
        'nextCursor': result['nextCursor'],
      });
      _log('FULL_SNAPSHOT_SQLITE_COMMITTED', {
        'reason': reason.label,
        'rooms': rooms.length,
        'savedCursor': through,
        'durationMs': elapsed.elapsedMilliseconds,
      });
      _roomsNextCursor = result['nextCursor'] == null
          ? null
          : string(result['nextCursor'], 'nextCursor');
      _notify();
    } catch (_) {
      _log('FULL_SNAPSHOT_FAILED', {
        'reason': reason.label,
        'durationMs': elapsed.elapsedMilliseconds,
      });
      rethrow;
    }
  }

  Future<void> refreshRooms() async {
    if (_loadingRooms || !_active) return;
    _loadingRooms = true;
    _notify();
    try {
      await _retire();
      await _serial;
      await _loadSnapshot(
        generation: _socketGeneration,
        reason: FullSnapshotReason.manualRefresh,
      );
      _needsFullSync = false;
      _fullSnapshotReason = null;
      if (_active && foreground) unawaited(connect());
    } on ChatFailure catch (error) {
      if (_active) {
        diagnostic = error.toString();
        _notify();
      }
    } finally {
      _loadingRooms = false;
      _notify();
    }
  }

  Future<void> loadMoreRooms() async {
    final cursor = _roomsNextCursor;
    if (_loadingRooms || cursor == null || !_active) return;
    _loadingRooms = true;
    _notify();
    try {
      final result = await api.request(
        'GET',
        '/rooms',
        query: {'limit': 20, 'cursor': cursor},
      );
      if (!_active) return;
      await repository.mergeRest(
        rooms: (result['rooms'] as List)
            .map((row) => Room.fromJson(object(row)))
            .toList(),
      );
      _roomsNextCursor = result['nextCursor'] == null
          ? null
          : string(result['nextCursor'], 'nextCursor');
      await repository.setRoomsNextCursor(_roomsNextCursor);
    } on ChatFailure catch (error) {
      if (_active) diagnostic = error.toString();
    } finally {
      _loadingRooms = false;
      _notify();
    }
  }

  void openRoom(String roomId) {
    uuid(roomId);
    _activeRoom = roomId;
    _readRoom = roomId;
    _readWanted = 0;
    _roomGeneration++;
  }

  void closeRoom(String roomId) {
    if (_activeRoom != roomId) return;
    _activeRoom = null;
    _roomGeneration++;
    _readWanted = 0;
  }

  Future<void> refreshActiveRoom() async {
    final room = _activeRoom;
    if (!_active || !foreground || room == null) return;
    try {
      await history(room, refresh: true);
    } on ChatFailure catch (error) {
      if (_active && _activeRoom == room) {
        diagnostic = error.toString();
        _notify();
      }
    }
  }

  Future<void> markRead(String roomId, int throughRoomSeq) async {
    if (!_active ||
        !foreground ||
        _activeRoom != roomId ||
        throughRoomSeq <= 0) {
      return;
    }
    if (_readRoom != roomId) {
      _readRoom = roomId;
      _readWanted = 0;
    }
    if (throughRoomSeq <= (_readSent[roomId] ?? 0)) return;
    _readWanted = max(_readWanted, throughRoomSeq);
    if (_readOperation != null) return;
    final generation = _roomGeneration;
    final operation = () async {
      var sent = _readSent[roomId] ?? 0;
      while (_active &&
          foreground &&
          generation == _roomGeneration &&
          _activeRoom == roomId &&
          _readWanted > sent) {
        final wanted = _readWanted;
        final result = await api.request(
          'POST',
          '/rooms/$roomId/read',
          data: {'throughRoomSeq': wanted},
        );
        if (!_active ||
            !foreground ||
            generation != _roomGeneration ||
            _activeRoom != roomId) {
          return;
        }
        await repository.mergeRest(
          rooms: [Room.fromJson(object(result['room']))],
        );
        sent = wanted;
        _readSent[roomId] = wanted;
      }
    }();
    _readOperation = operation;
    try {
      await operation;
    } on ChatFailure catch (error) {
      if (_active) {
        diagnostic = error.toString();
        _notify();
      }
    } finally {
      _readOperation = null;
      final current = _activeRoom;
      if (current != null &&
          current != roomId &&
          _readWanted > (_readSent[current] ?? 0)) {
        unawaited(markRead(current, _readWanted));
      }
    }
  }

  Future<Room> createRoom({
    String? peer,
    String? title,
    List<String>? others,
    String? requestId,
  }) async {
    final result = await api.request(
      'POST',
      peer != null ? '/rooms/direct' : '/rooms/group',
      data: peer != null
          ? {'peerUserId': peer}
          : {
              'title': title,
              'memberUserIds': others,
              'clientRequestId': requestId,
            },
    );
    if (!_active) throw const ChatFailure('CANCELLED', 'Account changed.');
    final room = Room.fromJson(object(result['room']));
    await repository.mergeRest(rooms: [room]);
    return room;
  }

  Future<Json> history(
    String roomId, {
    int? before,
    bool refresh = false,
  }) async {
    if (before != null) return _fetchHistory(roomId, before: before);
    final existing = _historyOperations[roomId];
    if (existing != null) {
      if (refresh) _historyDirty.add(roomId);
      return existing;
    }
    final operation = () async {
      Json result;
      do {
        _historyDirty.remove(roomId);
        result = await _fetchHistory(roomId);
      } while (_active &&
          foreground &&
          _activeRoom == roomId &&
          _historyDirty.remove(roomId));
      return result;
    }();
    _historyOperations[roomId] = operation;
    try {
      return await operation;
    } finally {
      _historyOperations.remove(roomId);
    }
  }

  Future<Json> _fetchHistory(String roomId, {int? before}) async {
    final result = await api.request(
      'GET',
      '/rooms/$roomId/messages',
      query: {'limit': 30, 'beforeRoomSeq': ?before},
    );
    if (!_active) throw const ChatFailure('CANCELLED', 'Account changed.');
    final previous = await repository.messageWindow(roomId);
    final window = object(result['window']);
    await repository.reconcileMessages(
      roomId,
      (result['messages'] as List)
          .map((row) => Message.fromJson(object(row)))
          .toList(),
      window,
      latest: before == null,
    );
    if (before == null) {
      final from = sequence(window['fromRoomSeq']);
      final through = sequence(window['throughRoomSeq']);
      final reset =
          previous == null ||
          (previous['through_seq'] as int) + 1 < from ||
          through + 1 < (previous['from_seq'] as int);
      _latestHistory[roomId] = {
        'revision': ++_historyRevision,
        'reset': reset,
        'hasMore': result['hasMore'],
        'nextBeforeRoomSeq': result['nextBeforeRoomSeq'],
      };
      _notify();
    }
    return result;
  }

  Future<void> drain() async {
    if (!_active || !foreground || _sendOperation != null) return;
    final operation = _drain();
    _sendOperation = operation;
    try {
      await operation;
    } finally {
      _sendOperation = null;
    }
  }

  Future<void> _drain() async {
    while (_active && foreground) {
      final item = await repository.nextOutgoing(DateTime.now());
      if (item == null || !_active || !foreground) return;
      final id = item['client_message_id']! as String;
      await repository.outgoingState(id, 'sending', increment: true);
      try {
        final response = await api.request(
          'POST',
          '/rooms/${item['room_id']}/messages',
          data: {'clientMessageId': id, 'text': item['text']},
        );
        if (!_active) return;
        await repository.mergeRest(
          rooms: [Room.fromJson(object(response['room']))],
          messages: [Message.fromJson(object(response['message']))],
        );
        unawaited(refreshActiveRoom());
      } on ChatFailure catch (error) {
        if (!_active) return;
        final temporary = error.retryable || error.code == 'CANCELLED';
        final delay = random.nextInt(
          min(30000, 1000 * (1 << min(item['attempts']! as int, 5))) + 1,
        );
        await repository.outgoingState(
          id,
          temporary ? 'queued' : 'failed',
          error: error.code,
          nextAttempt: temporary
              ? DateTime.now().millisecondsSinceEpoch +
                    max(delay, error.retryAfterMs ?? 0)
              : null,
        );
        diagnostic = error.toString();
        _notify();
      } catch (_) {
        if (_active) {
          await repository.outgoingState(
            id,
            'failed',
            error: 'INTEGRITY_ERROR',
          );
          diagnostic = 'The send response failed validation.';
          _notify();
        }
      }
    }
  }

  Future<void> setForeground(bool value) async {
    if (!_active || foreground == value) return;
    foreground = value;
    if (!value) {
      _reconnect?.cancel();
      _reconnect = null;
      _state('backgroundPaused', diagnostic);
      await _retire();
    } else {
      if (_blocked) {
        _state('blocked', diagnostic);
      } else {
        unawaited(connect());
      }
      unawaited(drain());
    }
  }

  Future<void> dispose() async {
    if (!_active) return;
    _active = false;
    _reconnect?.cancel();
    _queueTimer?.cancel();
    _freshness?.cancel();
    api.close();
    await _repositorySubscription?.cancel();
    await _retire();
    await _serial;
    await _connectOperation;
    await _sendOperation;
    await _readOperation?.catchError((Object _) {});
    await Future.wait(
      _historyOperations.values.map(
        (future) => future.then<void>((_) {}, onError: (Object _) {}),
      ),
    );
    await repository.close();
  }
}
