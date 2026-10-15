import 'dart:convert';
import 'dart:io';

import 'package:durable_chat_demo/app.dart';
import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/main.dart' as app;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

import 'app_smoke_test.dart' show waitFor;

const restartMarker = String.fromEnvironment('RESTART_TEST_MARKER');
String validateMarker() {
  if (!RegExp(r'^[A-Za-z0-9_-]{1,60}$').hasMatch(restartMarker)) {
    throw StateError(
      'Provide a unique RESTART_TEST_MARKER of 1-60 safe characters.',
    );
  }
  return restartMarker;
}

Future<void> prepareRestart(
  WidgetTester tester,
  IntegrationTestWidgetsFlutterBinding binding,
) async {
  final marker = validateMarker();
  app.main();
  await tester.pump();
  await tester.tap(find.text('User 1'));
  await tester.pump();
  await waitFor(tester, () => find.byType(RoomsPage).evaluate().isNotEmpty);
  final container = ProviderScope.containerOf(
    tester.element(find.byType(RoomsPage)),
  );
  final session = container.read(accountProvider).session!;
  await waitFor(
    tester,
    () => session.state == 'live',
    reason: 'prepare replay live',
  );
  final beforeRoomCursor = await session.repository.cursor();
  final room = await session.createRoom(
    title: 'Restart $marker',
    others: ['2'],
    requestId: const Uuid().v4(),
  );
  Future<bool> roomEcho() async =>
      await session.repository.cursor() > beforeRoomCursor &&
      (await session.repository.rooms()).any((cached) => cached.id == room.id);
  final deadline = DateTime.now().add(const Duration(seconds: 20));
  while (!(await roomEcho()) && DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 100));
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  expect(await roomEcho(), isTrue);
  const killWhileSending = bool.fromEnvironment('KILL_WHILE_SENDING');
  if (!killWhileSending) await session.setForeground(false);
  final text = 'Restart-persisted $marker مرحبا 👋';
  final clientId = await session.repository.enqueue(room.id, text);
  if (killWhileSending) {
    final sendingDeadline = DateTime.now().add(const Duration(seconds: 10));
    var sending = false;
    while (DateTime.now().isBefore(sendingDeadline)) {
      final pending = await session.repository.messages(room.id);
      sending = pending.any(
        (row) =>
            row['client_message_id'] == clientId &&
            row['send_state'] == 'sending',
      );
      if (sending) break;
      await tester.pump(const Duration(milliseconds: 50));
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
    expect(
      sending,
      isTrue,
      reason: 'fault proxy holds an actual persisted sending request',
    );
  }
  final cursor = await session.repository.cursor();
  final rows = await session.repository.messages(room.id);
  expect(rows.single['send_state'], killWhileSending ? 'sending' : 'queued');
  expect(rows.single['client_message_id'], clientId);
  final record = <String, dynamic>{
    'marker': marker,
    'dataset': session.repository.dataset,
    'deviceId': session.api.device,
    'roomId': room.id,
    'clientMessageId': clientId,
    'text': text,
    'cursor': cursor,
    'persistedSendState': rows.single['send_state'],
  };
  final file = File(p.join(await getDatabasesPath(), 'restart-$marker.json'));
  if (await file.exists()) {
    throw StateError(
      'Marker already exists; supply a fresh RESTART_TEST_MARKER.',
    );
  }
  await file.writeAsString(jsonEncode(record), flush: true);
  binding.reportData = {
    'phase': 'prepared',
    'marker': marker,
    'cursor': cursor,
    'persistedSendState': rows.single['send_state'],
    'clientMessageId': clientId,
    'roomId': room.id,
  };
  expect(session.foreground, killWhileSending);
  if (const bool.fromEnvironment('HOLD_FOR_TERMINATION')) {
    debugPrint('RESTART_PREPARED:$marker');
    // Operator-controlled termination; optionally hold a genuine REST send in flight.
    await Future<void>.delayed(const Duration(minutes: 2));
  }
  // The operator terminates this process while queued, or while the test-only
  // proxy holds the actual REST response; recovery uses the same installation.
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'prepare a native persisted outgoing intent before process termination',
    (tester) => prepareRestart(tester, binding),
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
