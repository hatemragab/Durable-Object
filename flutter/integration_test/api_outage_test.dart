import 'package:durable_chat_demo/app.dart';
import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/features/chat/widgets.dart';
import 'package:durable_chat_demo/main.dart' as app;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'app_smoke_test.dart' show waitFor;

Future<void> boundary(
  WidgetTester tester,
  Future<bool> Function() condition,
  String reason, {
  int seconds = 60,
}) async {
  final deadline = DateTime.now().add(Duration(seconds: seconds));
  while (DateTime.now().isBefore(deadline)) {
    if (await condition()) return;
    await tester.pump(const Duration(milliseconds: 100));
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  fail('Timed out at $reason');
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native persisted outgoing message converges after owned API outage',
    (tester) async {
      app.main();
      await tester.pump();
      await tester.tap(find.text('User 1'));
      await tester.pump();
      await waitFor(tester, () => find.byType(RoomsPage).evaluate().isNotEmpty);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(RoomsPage)),
      );
      final session = container.read(accountProvider).session!;
      await waitFor(tester, () => session.state == 'live');
      final beforeRoomCursor = await session.repository.cursor();
      await tester.tap(find.text('New chat'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Group'));
      await tester.pumpAndSettle();
      final marker = DateTime.now().microsecondsSinceEpoch.toString();
      await tester.enterText(find.byType(TextField), 'API outage $marker');
      await tester.tap(find.text('User 2'));
      await tester.pump();
      await tester.tap(find.text('Open chat'));
      await tester.pump();
      await waitFor(
        tester,
        () => find.byType(MessagePage).evaluate().isNotEmpty,
      );
      final room = tester.widget<MessagePage>(find.byType(MessagePage)).room;
      await boundary(
        tester,
        () async =>
            await session.repository.cursor() > beforeRoomCursor &&
            (await session.repository.rooms()).any(
              (cached) => cached.id == room.id,
            ),
        'room durable echo',
        seconds: 20,
      );
      final connection = session.connectionId;
      final beforeCursor = await session.repository.cursor();
      debugPrint('API_OUTAGE_READY');
      await boundary(tester, () async {
        try {
          await session.api.request('GET', '/rooms');
          return false;
        } on ChatFailure catch (error) {
          if (error.code == 'DEPENDENCY_UNAVAILABLE' && error.retryable) {
            return true;
          }
          rethrow;
        }
      }, 'operator stops only the owned API');
      final text = 'API outage pending $marker مرحبا 👋';
      await tester.enterText(
        find.descendant(
          of: find.byType(TextComposer),
          matching: find.byType(EditableText),
        ),
        text,
      );
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('Send message'));
      await tester.pump();
      var rows = await session.repository.messages(room.id);
      await boundary(
        tester,
        () async {
          rows = await session.repository.messages(room.id);
          return rows.any(
            (row) => row['text'] == text && row['send_state'] == 'queued',
          );
        },
        'outgoing intent queued while API is down',
        seconds: 20,
      );
      final clientId =
          rows.firstWhere((row) => row['text'] == text)['client_message_id']
              as String;
      expect(
        (await session.repository.rooms()).any((value) => value.id == room.id),
        isTrue,
      );
      expect(find.byType(MessagePage), findsOneWidget);
      await waitFor(
        tester,
        () => tester
            .widgetList<TextMessageBubble>(find.byType(TextMessageBubble))
            .any((bubble) => bubble.message['text'] == text),
        reason: 'persisted queued bubble reaches the widget tree',
      );
      expect(
        tester
            .widgetList<TextMessageBubble>(find.byType(TextMessageBubble))
            .any((bubble) => bubble.message['text'] == text),
        isTrue,
      );
      expect(session.state, 'live');
      expect(session.connectionId, connection);
      expect(await session.repository.cursor(), beforeCursor);
      debugPrint('API_OUTAGE_QUEUED');
      await boundary(tester, () async {
        rows = await session.repository.messages(room.id);
        return rows.any(
          (row) =>
              row['client_message_id'] == clientId &&
              row['send_state'] == 'sent',
        );
      }, 'operator restarts API and original intent drains');
      final canonical = rows
          .where((row) => row['client_message_id'] == clientId)
          .single;
      final serverId = canonical['server_id'];
      await boundary(
        tester,
        () async =>
            await session.repository.cursor() > beforeCursor &&
            (await session.repository.rooms()).any(
              (cached) =>
                  cached.id == room.id &&
                  (cached.json['lastMessage'] as Map?)?['messageId'] ==
                      serverId,
            ),
        'recovered exact durable echo',
        seconds: 20,
      );
      final retry = await session.api.request(
        'POST',
        '/rooms/${room.id}/messages',
        data: {'clientMessageId': clientId, 'text': text},
      );
      expect(retry['duplicate'], isTrue);
      expect(object(retry['message'])['id'], serverId);
      expect(
        (await session.repository.messages(room.id))
            .where((row) => row['client_message_id'] == clientId)
            .length,
        1,
      );
      expect((await session.repository.counts())['queued'], 0);
      expect(session.connectionId, connection);
      binding.reportData = {
        'phase': 'API outage recovered',
        'marker': marker,
        'roomId': room.id,
        'clientMessageId': clientId,
        'messageId': serverId,
        'beforeCursor': beforeCursor,
        'afterCursor': await session.repository.cursor(),
        'continuousConnectionId': connection,
      };
      debugPrint('API_OUTAGE_RECOVERED');
      await container.read(accountProvider.notifier).switchAccount();
      await tester.pump();
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
