import 'dart:io';

import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'session_test.dart' show TestApi, TestSocket;
import 'queue_lifecycle_test.dart' show DeferredSendApi;
import 'storage_test.dart' show eventRoom, eventMessage;

void main() {
  test(
    'disposing active account provider never reads disposed Riverpod state',
    () async {
      sqfliteFfiInit();
      final dir = await Directory.systemTemp.createTemp('chat-provider-test-');
      final storage = LocalStorage(
        factory: databaseFactoryFfi,
        directory: dir.path,
      );
      final container = ProviderContainer(
        overrides: [
          storageProvider.overrideWithValue(storage),
          apiFactoryProvider.overrideWithValue((_, _, _) => TestApi()),
          socketFactoryProvider.overrideWithValue((_) => TestSocket()),
        ],
      );
      await container.read(accountProvider.notifier).select('2');
      final session = container.read(accountProvider).session!;
      expect(session.repository.db.isOpen, isTrue);
      container.dispose();
      final end = DateTime.now().add(const Duration(seconds: 3));
      while (session.repository.db.isOpen && DateTime.now().isBefore(end)) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(session.repository.db.isOpen, isFalse);
      await storage.close();
      await dir.delete(recursive: true);
    },
  );
  test('rapid same-account reselection waits for in-flight retirement before reopening SQLite', () async {
    sqfliteFfiInit();
    final dir = await Directory.systemTemp.createTemp('chat-reselection-');
    final storage = LocalStorage(
      factory: databaseFactoryFfi,
      directory: dir.path,
    );
    final delayed = DeferredSendApi();
    var apiCalls = 0;
    final container = ProviderContainer(
      overrides: [
        storageProvider.overrideWithValue(storage),
        apiFactoryProvider.overrideWithValue(
          (_, _, _) => apiCalls++ == 0 ? delayed : TestApi(),
        ),
        socketFactoryProvider.overrideWithValue((_) => TestSocket()),
      ],
    );
    final controller = container.read(accountProvider.notifier);
    await controller.select('1');
    final original = container.read(accountProvider).session!;
    while (await original.repository.syncState() == null) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }
    final room = eventRoom('direct-room-created'),
        message = eventMessage('direct-message-created');
    await original.repository.mergeRest(rooms: [room]);
    await original.repository.enqueue(
      room.id,
      message.text,
      clientId: message.clientId,
    );
    await delayed.started.future;
    final switching = controller.switchAccount();
    final selecting = controller.select('1');
    expect(container.read(accountProvider).loading, isTrue);
    delayed.response.complete({
      'room': eventRoom('direct-message-created').json,
      'message': message.json,
    });
    await switching;
    await selecting;
    final reopened = container.read(accountProvider).session!;
    expect(reopened, same(container.read(accountProvider).session));
    expect(identical(reopened, original), isFalse);
    expect(reopened.repository.db.isOpen, isTrue);
    expect((await reopened.repository.rooms()).single.id, room.id);
    // Both opening and retirement are serialized, including back-to-back calls
    // made before the picker has a chance to rebuild disabled buttons.
    await Future.wait([controller.select('1'), controller.select('1')]);
    expect(
      container.read(accountProvider).session!.repository.db.isOpen,
      isTrue,
    );
    await controller.switchAccount();
    container.dispose();
    await storage.close();
    await dir.delete(recursive: true);
  });
}
