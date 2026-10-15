import 'dart:convert';
import 'dart:io';

import 'package:durable_chat_demo/app.dart';
import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/api.dart';
import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/storage.dart';
import 'package:durable_chat_demo/main.dart' as app;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/foundation.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import 'app_smoke_test.dart' show waitFor;
import 'restart_prepare_test.dart' show validateMarker;

Future<void> recoverRestart(
  WidgetTester tester,
  IntegrationTestWidgetsFlutterBinding binding,
) async {
  final marker = validateMarker();
  final file = File(p.join(await getDatabasesPath(), 'restart-$marker.json'));
  expect(
    await file.exists(),
    isTrue,
    reason: 'same installation retains prepare record',
  );
  final record = object(jsonDecode(await file.readAsString()));
  const config = AppConfig();
  config.validate();
  expect(record['dataset'], config.dataset);
  final local = LocalStorage();
  expect(await local.deviceId(), record['deviceId']);
  final saved = await local.account(config.dataset, '1');
  // Read native SQLite before creating the app/session/dispatcher.
  expect(await saved.cursor(), record['cursor']);
  final pending = (await saved.messages(record['roomId'] as String))
      .where((row) => row['client_message_id'] == record['clientMessageId'])
      .single;
  expect(pending['send_state'], 'queued');
  expect(pending['text'], record['text']);
  expect(pending['server_id'], isNull);
  await saved.close();
  await local.close();
  app.main();
  await tester.pump();
  await tester.tap(find.text('User 1'));
  await tester.pump();
  await waitFor(tester, () => find.byType(RoomsPage).evaluate().isNotEmpty);
  final container = ProviderScope.containerOf(
    tester.element(find.byType(RoomsPage)),
  );
  final session = container.read(accountProvider).session!;
  var rows = await session.repository.messages(record['roomId'] as String);
  final deadline = DateTime.now().add(const Duration(seconds: 30));
  bool accepted() => rows.any(
    (row) =>
        row['client_message_id'] == record['clientMessageId'] &&
        row['send_state'] == 'sent',
  );
  while (!accepted() && DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 100));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    rows = await session.repository.messages(record['roomId'] as String);
  }
  expect(accepted(), isTrue);
  final canonical = rows
      .where((row) => row['client_message_id'] == record['clientMessageId'])
      .single;
  final serverId = canonical['server_id'];
  expect(serverId, isNotNull);
  Future<bool> hasEcho() async =>
      await session.repository.cursor() > (record['cursor'] as int) &&
      (await session.repository.rooms()).any(
        (room) =>
            room.id == record['roomId'] &&
            (room.json['lastMessage'] as Map?)?['messageId'] == serverId,
      );
  final echoDeadline = DateTime.now().add(const Duration(seconds: 20));
  while (!(await hasEcho()) && DateTime.now().isBefore(echoDeadline)) {
    await tester.pump(const Duration(milliseconds: 100));
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  expect(await hasEcho(), isTrue);
  final retry = await session.api.request(
    'POST',
    '/rooms/${record['roomId']}/messages',
    data: {
      'clientMessageId': record['clientMessageId'],
      'text': record['text'],
    },
  );
  expect(retry['duplicate'], isTrue);
  expect(object(retry['message'])['id'], serverId);
  expect(
    (await session.repository.messages(record['roomId'] as String))
        .where((row) => row['client_message_id'] == record['clientMessageId'])
        .length,
    1,
  );
  final cursor = await session.repository.cursor();
  expect(cursor, greaterThan(record['cursor'] as int));
  binding.reportData = {
    'phase': 'recovered',
    'marker': marker,
    'dataset': record['dataset'],
    'deviceId': record['deviceId'],
    'beforeCursor': record['cursor'],
    'persistedSendState': record['persistedSendState'],
    'recoveredSendStateBeforeDrain': pending['send_state'],
    'afterCursor': cursor,
    'clientMessageId': record['clientMessageId'],
    'messageId': serverId,
  };
  await File(p.join(await getDatabasesPath(), 'restart-completed-$marker.json'))
      .writeAsString(jsonEncode(binding.reportData), flush: true);
  debugPrint('RESTART_RECOVERED:$marker');
  await container.read(accountProvider.notifier).switchAccount();
  await tester.pump();
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'recover exact persisted intent after external process relaunch',
    (tester) => recoverRestart(tester, binding),
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
