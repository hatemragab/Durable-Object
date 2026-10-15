import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/api.dart';
import 'core/models.dart';
import 'core/session.dart';
import 'core/storage.dart';

final configProvider = Provider<AppConfig>((ref) => const AppConfig());
final apiFactoryProvider =
    Provider<ApiClient Function(AppConfig, String, String)>(
      (ref) =>
          (config, user, device) => ApiClient(config, user, device),
    );
final socketFactoryProvider = Provider<SocketFactory>(
  (ref) => StandardChatSocket.new,
);
final storageProvider = Provider<LocalStorage>((ref) {
  final storage = LocalStorage();
  ref.onDispose(() {
    unawaited(storage.close());
  });
  return storage;
});

class AccountState {
  const AccountState({
    this.session,
    this.loading = false,
    this.error,
    this.revision = 0,
  });
  final AccountSession? session;
  final bool loading;
  final String? error;
  final int revision;
}

final accountProvider = NotifierProvider<AccountController, AccountState>(
  AccountController.new,
);

class AccountController extends Notifier<AccountState> {
  int _generation = 0;
  bool _disposed = false;
  AccountSession? _ownedSession;
  Future<void> _operations = Future.value();

  Future<void> _enqueue(Future<void> Function() action) {
    final operation = _operations.then((_) => action());
    // Keep later lifecycle operations serialized even if a caller receives an error.
    _operations = operation.catchError((Object _) {});
    return operation;
  }

  Future<void> _retireOwned() async {
    final owned = _ownedSession;
    _ownedSession = null;
    await owned?.dispose();
  }

  @override
  AccountState build() {
    ref.onDispose(() {
      _disposed = true;
      _generation++;
      // Do not read notifier state/ref in disposal. Finish opening/closing work
      // before releasing its privately owned runtime and native database.
      unawaited(_enqueue(_retireOwned).catchError((Object _) {}));
    });
    return const AccountState();
  }

  Future<void> select(String user) {
    final generation = ++_generation;
    state = const AccountState(loading: true);
    return _enqueue(() async {
      try {
        await _retireOwned();
        if (_disposed || generation != _generation) return;
        final config = ref.read(configProvider);
        config.validate();
        final storage = ref.read(storageProvider);
        final device = await storage.deviceId();
        final repository = await storage.account(config.dataset, user);
        if (_disposed || generation != _generation) {
          await repository.close();
          return;
        }
        late final AccountSession runtime;
        runtime = AccountSession(
          repository: repository,
          api: ref.read(apiFactoryProvider)(config, user, device),
          socketFactory: ref.read(socketFactoryProvider),
          onChanged: () {
            if (!_disposed &&
                generation == _generation &&
                state.session == runtime) {
              state = AccountState(
                session: runtime,
                revision: state.revision + 1,
              );
            }
          },
        );
        _ownedSession = runtime;
        state = AccountState(session: runtime);
        await runtime.start();
      } catch (error) {
        if (!_disposed && generation == _generation) {
          state = AccountState(
            error: error is ChatFailure
                ? error.message
                : 'Could not open account storage.',
          );
        }
      }
    });
  }

  Future<void> switchAccount() {
    final generation = ++_generation;
    state = const AccountState(loading: true);
    return _enqueue(() async {
      await _retireOwned();
      if (!_disposed && generation == _generation) state = const AccountState();
    });
  }

  void foreground(bool value) {
    unawaited(_ownedSession?.setForeground(value));
  }
}

final roomsProvider = StreamProvider.autoDispose<List<Room>>((ref) {
  final session = ref.watch(accountProvider.select((value) => value.session));
  if (session == null) return Stream.value([]);
  return session.repository.watchQuery(session.repository.rooms);
});
final messagesProvider = StreamProvider.autoDispose
    .family<List<Json>, ({String roomId, int limit})>((ref, key) {
      final session = ref.watch(
        accountProvider.select((value) => value.session),
      );
      if (session == null) return Stream.value([]);
      return session.repository.watchQuery(
        () => session.repository.messages(key.roomId, limit: key.limit),
      );
    });
