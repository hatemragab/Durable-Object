import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:durable_chat_demo/app.dart';
import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/api.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:durable_chat_demo/features/chat/widgets.dart';
import 'package:durable_chat_demo/main.dart' as app;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

Future<void> waitFor(
  WidgetTester tester,
  bool Function() predicate, {
  String reason = 'condition',
}) async {
  final end = DateTime.now().add(const Duration(seconds: 30));
  while (!predicate() && DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 100));
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  expect(predicate(), isTrue, reason: reason);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('native UI, REST/socket convergence and account database restart', (
    tester,
  ) async {
    const requireCloud = bool.fromEnvironment('REQUIRE_CLOUD_REALTIME');
    const expectedOrigin = String.fromEnvironment('EXPECTED_REALTIME_ORIGIN');
    final sessionOrigins = <Uri>[],
        issuedEndpoints = <Uri>[],
        usedEndpoints = <Uri>[];
    var invalidIssuedEndpoint = false;
    Uri publicEndpoint(Uri uri) => Uri(
      scheme: uri.scheme,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
      path: uri.path,
    );
    void recordIssued(Object? value, List<Uri> records) {
      final uri = value is String ? Uri.tryParse(value) : null;
      if (uri == null ||
          uri.userInfo.isNotEmpty ||
          uri.hasQuery ||
          uri.hasFragment) {
        invalidIssuedEndpoint = true;
        return;
      }
      // Retain only public endpoint components; never retain a ticket query.
      records.add(publicEndpoint(uri));
    }

    void verifyCloudEndpoints() {
      expect(invalidIssuedEndpoint, isFalse);
      expect(sessionOrigins, isNotEmpty);
      expect(issuedEndpoints, isNotEmpty);
      expect(usedEndpoints, isNotEmpty);
      for (final origin in sessionOrigins) {
        expect(origin.scheme, 'https');
        expect(origin.origin, expectedOrigin);
        expect(origin.path, anyOf('', '/'));
      }
      final expectedSocket = Uri.parse(expectedOrigin)
          .replace(scheme: 'wss', path: '/v1/ws');
      for (final endpoint in [...issuedEndpoints, ...usedEndpoints]) {
        expect(endpoint.scheme, 'wss');
        expect(endpoint.host.endsWith('.workers.dev'), isTrue);
        expect(endpoint, expectedSocket);
      }
    }

    if (requireCloud) {
      final expected = Uri.tryParse(expectedOrigin);
      expect(expected?.scheme, 'https');
      expect(expected?.host.endsWith('.workers.dev'), isTrue);
      expect(expected?.userInfo, isEmpty);
      expect(expected?.hasQuery, isFalse);
      expect(expected?.hasFragment, isFalse);
      expect(expected?.origin, expectedOrigin);
      runApp(
        ProviderScope(
          overrides: [
            apiFactoryProvider.overrideWithValue((config, user, device) {
              final api = ApiClient(config, user, device);
              api.dio.interceptors.add(
                InterceptorsWrapper(
                  onResponse: (response, handler) {
                    final data = response.data;
                    if (data is Map) {
                      if (response.requestOptions.path == '/dev/session') {
                        recordIssued(data['realtimeBaseUrl'], sessionOrigins);
                      } else if (response.requestOptions.path ==
                          '/realtime/ticket') {
                        recordIssued(data['url'], issuedEndpoints);
                      }
                    }
                    handler.next(response);
                  },
                ),
              );
              return api;
            }),
            socketFactoryProvider.overrideWithValue((uri) {
              // This is the exact URI AccountSession passes to the real
              // transport after obtaining its API ticket. Its query is omitted.
              usedEndpoints.add(publicEndpoint(uri));
              return StandardChatSocket(uri);
            }),
          ],
          child: const ChatDemoApp(),
        ),
      );
    } else {
      app.main();
    }
    await tester.pump();
    expect(find.text('Choose test account'), findsOneWidget);
    await tester.tap(find.text('User 1'));
    await tester.pump();
    await waitFor(
      tester,
      () => find.byType(RoomsPage).evaluate().isNotEmpty,
      reason: 'cached account opens',
    );
    final container = ProviderScope.containerOf(
      tester.element(find.byType(RoomsPage)),
    );
    AccountSession session() => container.read(accountProvider).session!;
    await waitFor(
      tester,
      () => session().state == 'live',
      reason: 'configured API and Worker replay become live',
    );
    if (requireCloud) verifyCloudEndpoints();
    await tester.tap(find.text('New chat'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Group'));
    await tester.pumpAndSettle();
    final title = 'Native smoke ${DateTime.now().microsecondsSinceEpoch}';
    await tester.enterText(find.byType(TextField), title);
    await tester.tap(find.text('User 2'));
    await tester.pump();
    await tester.tap(find.text('Open chat'));
    await tester.pump();
    await waitFor(
      tester,
      () => find.byType(MessagePage).evaluate().isNotEmpty,
      reason: 'group creation and navigation',
    );
    await tester.pumpAndSettle();
    final page = tester.widget<MessagePage>(find.byType(MessagePage));
    final beforeMessageCursor = await session().repository.cursor();
    const text = 'Native SQLite + REST + WebSocket\nمرحبا 👋\nMultiline text';
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
    var rows = await session().repository.messages(page.room.id);
    final acceptedDeadline = DateTime.now().add(const Duration(seconds: 30));
    while (!rows.any(
          (row) => row['text'] == text && row['send_state'] == 'sent',
        ) &&
        DateTime.now().isBefore(acceptedDeadline)) {
      await tester.pump(const Duration(milliseconds: 100));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      rows = await session().repository.messages(page.room.id);
    }
    expect(
      rows.any((row) => row['text'] == text && row['send_state'] == 'sent'),
      isTrue,
    );
    // Message bodies arrive through HTTP; the room stream must also advance.
    final serverId = rows.firstWhere((row) => row['text'] == text)['server_id'];
    Future<bool> hasEcho() async =>
        await session().repository.cursor() > beforeMessageCursor &&
        (await session().repository.rooms()).any(
          (room) =>
              room.id == page.room.id &&
              (room.json['lastMessage'] as Map?)?['messageId'] == serverId,
        );
    final end = DateTime.now().add(const Duration(seconds: 20));
    while (!(await hasEcho()) && DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 100));
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    expect(await hasEcho(), isTrue);
    expect(rows.where((row) => row['text'] == text).length, 1);
    final stableConnection = session().connectionId;
    expect(stableConnection, isNotNull);
    for (var i = 0; i < 5; i++) {
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(RoomsPage), findsOneWidget);
      await tester.tap(find.text(title));
      await tester.pumpAndSettle();
      expect(find.byType(MessagePage), findsOneWidget);
      expect(session().connectionId, stableConnection);
    }
    final originalSession = session();
    final originalPath = originalSession.repository.db.path;
    await originalSession.setForeground(false);
    final pendingId = await originalSession.repository.enqueue(
      page.room.id,
      'Persisted paused draft',
    );
    await container.read(accountProvider.notifier).switchAccount();
    await tester.pumpAndSettle();
    expect(find.text('Choose test account'), findsOneWidget);
    expect(originalSession.repository.db.isOpen, isFalse);
    final stored = await container
        .read(storageProvider)
        .account(originalSession.repository.dataset, '1');
    expect(
      (await stored.messages(page.room.id)).any(
        (row) =>
            row['client_message_id'] == pendingId &&
            row['send_state'] == 'queued',
      ),
      isTrue,
    );
    final committed = await stored.cursor();
    expect(committed, greaterThan(0));
    await stored.close();
    await tester.tap(find.text('User 2'));
    await tester.pump();
    await waitFor(tester, () => find.byType(RoomsPage).evaluate().isNotEmpty);
    expect(session().repository.user, '2');
    expect(session().repository.db.path, isNot(originalPath));
    expect(await session().repository.counts(), {'queued': 0, 'failed': 0});
    await container.read(accountProvider.notifier).switchAccount();
    await tester.pump();
    await tester.tap(find.text('User 3'));
    await tester.pump();
    await waitFor(tester, () => find.byType(RoomsPage).evaluate().isNotEmpty);
    expect(session().repository.user, '3');
    expect(session().repository.db.path, isNot(originalPath));
    expect(
      (await session().repository.rooms()).any(
        (room) => room.id == page.room.id,
      ),
      isFalse,
    );
    expect(await session().repository.counts(), {'queued': 0, 'failed': 0});
    await container.read(accountProvider.notifier).switchAccount();
    await tester.pump();
    await tester.tap(find.text('User 1'));
    await tester.pump();
    await waitFor(tester, () => find.byType(RoomsPage).evaluate().isNotEmpty);
    expect(session().repository.db.path, originalPath);
    expect(
      (await session().repository.rooms()).any(
        (room) => room.id == page.room.id,
      ),
      isTrue,
    );
    expect(
      await session().repository.cursor(),
      greaterThanOrEqualTo(committed),
    );
    if (requireCloud) {
      verifyCloudEndpoints();
      binding.reportData = {
        'scope': 'authorized iOS simulator + configured API + real Cloudflare',
        'realtimeOrigin': expectedOrigin,
        'sessionRealtimeOrigins': sessionOrigins
            .map((uri) => uri.origin)
            .toSet()
            .toList(),
        'issuedSocketEndpoints': issuedEndpoints
            .map((uri) => uri.toString())
            .toSet()
            .toList(),
        'usedSocketEndpoints': usedEndpoints
            .map((uri) => uri.toString())
            .toSet()
            .toList(),
        'datasetId': session().repository.dataset,
        'deviceId': session().api.device,
        'roomId': page.room.id,
        'messageId': serverId,
        'cursorBeforeAccountSwitch': committed,
        'cursorAfterAccountReturn': await session().repository.cursor(),
        'navigationCycles': 5,
        'accountSelections': ['1', '2', '3', '1'],
      };
      debugPrint('CLOUD_SMOKE_EVIDENCE:${jsonEncode(binding.reportData)}');
    }
    // Pending intent persists across closed/reopened native account databases;
    // abrupt process termination and multi-device mobile proof remain separate.
    await container.read(accountProvider.notifier).switchAccount();
    await tester.pump();
  });
}
