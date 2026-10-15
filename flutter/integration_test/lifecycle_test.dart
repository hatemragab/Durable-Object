import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:durable_chat_demo/app.dart';
import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/api.dart';
import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:durable_chat_demo/features/chat/widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

import 'api_outage_test.dart' show boundary;
import 'app_smoke_test.dart' show waitFor;

class NativeLifecycleObserver extends WidgetsBindingObserver {
  NativeLifecycleObserver(this.onState);
  final void Function(AppLifecycleState) onState;
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => onState(state);
}

class RecordingSocket implements ChatSocket {
  RecordingSocket(this.inner, this.replayTargets);
  final ChatSocket inner;
  final List<int> replayTargets;
  @override
  Stream<dynamic> get stream => inner.stream.map((raw) {
    if (raw is String && raw.startsWith('{')) {
      final frame = object(jsonDecode(raw));
      if (frame['type'] == 'sync.started') {
        replayTargets.add(frame['targetSeq'] as int);
      }
    }
    return raw;
  });
  @override
  Future<void> get ready => inner.ready;
  @override
  int? get closeCode => inner.closeCode;
  @override
  void send(String data) => inner.send(data);
  @override
  Future<void> close() => inner.close();
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'actual OS background preserves queue and foreground reconnects/replays/drains',
    (tester) async {
      const marker = String.fromEnvironment('LIFECYCLE_TEST_MARKER');
      expect(RegExp(r'^[A-Za-z0-9_-]{1,60}$').hasMatch(marker), isTrue);
      final directory = await getDatabasesPath();
      final failedFile = File(
        p.join(directory, 'lifecycle-failed-$marker.json'),
      );
      final backgroundFile = File(
        p.join(directory, 'lifecycle-background-$marker.json'),
      );
      final tickets =
          <String>[]; // Memory only; raw tickets never enter reports/logs.
      final history = <Json>[], lifecycle = <Json>[];
      final resumed = Completer<void>();
      Future<void>? backgroundCapture;
      Json? paused;
      String? backgroundFailure;
      var sawPaused = false;
      NativeLifecycleObserver? observer;
      final replayTargets = <int>[];
      try {
        runApp(
          ProviderScope(
            overrides: [
              socketFactoryProvider.overrideWithValue(
                (uri) =>
                    RecordingSocket(StandardChatSocket(uri), replayTargets),
              ),
              apiFactoryProvider.overrideWithValue((config, user, device) {
                final api = ApiClient(config, user, device);
                api.dio.interceptors.add(
                  InterceptorsWrapper(
                    onResponse: (response, handler) {
                      if (response.requestOptions.path == '/realtime/ticket') {
                        tickets.add(object(response.data)['ticket'] as String);
                      }
                      if (response.requestOptions.method == 'GET' &&
                          response.requestOptions.path.endsWith('/messages')) {
                        history.add({
                          'before': response
                              .requestOptions
                              .queryParameters['beforeRoomSeq'],
                          'hasMore': object(response.data)['hasMore'],
                          'next': object(response.data)['nextBeforeRoomSeq'],
                        });
                      }
                      handler.next(response);
                    },
                  ),
                );
                return api;
              }),
            ],
            child: const ChatDemoApp(),
          ),
        );
        await tester.pump();
        await tester.tap(find.text('User 1'));
        await tester.pump();
        await waitFor(
          tester,
          () => find.byType(RoomsPage).evaluate().isNotEmpty,
        );
        final container = ProviderScope.containerOf(
          tester.element(find.byType(RoomsPage)),
        );
        final session = container.read(accountProvider).session!;
        await waitFor(tester, () => session.state == 'live');
        final room = await session.createRoom(
          title: 'Lifecycle $marker',
          others: ['2'],
          requestId: const Uuid().v4(),
        );
        final expectedIds = <String>[];
        if (const bool.fromEnvironment(
          'INCLUDE_HISTORY_PAGINATION',
          defaultValue: true,
        )) {
          for (var i = 1; i <= 120; i++) {
            final sent = await session.api.request(
              'POST',
              '/rooms/${room.id}/messages',
              data: {
                'clientMessageId': const Uuid().v4(),
                'text': 'History ${i.toString().padLeft(3, '0')} $marker',
              },
            );
            expectedIds.add(object(sent['message'])['id'] as String);
          }
          await boundary(
            tester,
            () async => (await session.repository.rooms()).any(
              (cached) =>
                  cached.id == room.id && cached.json['lastMessageSeq'] == 120,
            ),
            'room preview reaches 120 without caching message bodies',
            seconds: 30,
          );
          expect(
            await session.repository.messages(room.id, limit: 200),
            isEmpty,
          );
        }
        await tester.pump();
        await waitFor(
          tester,
          () => find.text('Lifecycle $marker').evaluate().isNotEmpty,
        );
        await tester.tap(find.text('Lifecycle $marker'));
        await tester.pump();
        await waitFor(
          tester,
          () => find.byType(MessagePage).evaluate().isNotEmpty,
        );
        if (expectedIds.isNotEmpty) {
          await waitFor(tester, () => history.isNotEmpty);
          for (var page = 0; page < 3; page++) {
            final list = find.descendant(
              of: find.byType(MessagePage),
              matching: find.byType(ListView),
            );
            await waitFor(
              tester,
              () =>
                  list.evaluate().isNotEmpty &&
                  tester.widget<ListView>(list).controller!.hasClients,
            );
            expect(
              tester.widget<ListView>(list).semanticChildCount,
              (page + 1) * 30 + 1,
            );
            final controller = tester.widget<ListView>(list).controller!;
            for (
              var attempt = 0;
              attempt < 8 &&
                  find
                      .text('Load older messages')
                      .hitTestable()
                      .evaluate()
                      .isEmpty;
              attempt++
            ) {
              controller.jumpTo(controller.position.maxScrollExtent);
              await tester.pumpAndSettle();
            }
            expect(
              find.text('Load older messages').hitTestable(),
              findsOneWidget,
            );
            final offset = controller.offset;
            await tester.tap(find.text('Load older messages'));
            await tester.pump();
            await waitFor(
              tester,
              () =>
                  history.length >= page + 2 &&
                  list.evaluate().isNotEmpty &&
                  tester.widget<ListView>(list).controller!.hasClients,
            );
            await tester.pumpAndSettle();
            expect(
              tester.widget<ListView>(list).semanticChildCount,
              (page + 2) * 30 + 1,
            );
            expect(
              controller.offset,
              closeTo(offset, 2),
              reason: 'older-page load retains current scroll position',
            );
          }
          final olderPages = history
              .where((page) => page['before'] != null)
              .take(3)
              .toList();
          expect(olderPages.map((page) => page['before']).toList(), [
            91,
            61,
            31,
          ]);
          expect(olderPages.map((page) => page['hasMore']).toList(), [
            true,
            true,
            false,
          ]);
          expect(olderPages.last['next'], isNull);
          expect(
            (await session.repository.messages(
              room.id,
              limit: 200,
            )).map((row) => row['server_id']).toList(),
            expectedIds,
          );
          final list = find.descendant(
            of: find.byType(MessagePage),
            matching: find.byType(ListView),
          );
          final scroll = tester.widget<ListView>(list).controller!;
          for (var attempt = 0; attempt < 8; attempt++) {
            scroll.jumpTo(scroll.position.maxScrollExtent);
            await tester.pumpAndSettle();
            if (find
                .text('Beginning of chat')
                .hitTestable()
                .evaluate()
                .isNotEmpty) {
              break;
            }
          }
          expect(find.text('Beginning of chat').hitTestable(), findsOneWidget);
          expect(
            find
                .byWidgetPredicate(
                  (widget) =>
                      widget is TextMessageBubble &&
                      widget.message['server_id'] == expectedIds.first,
                )
                .hitTestable(),
            findsOneWidget,
          );
          tester.widget<ListView>(list).controller!.jumpTo(0);
          await tester.pumpAndSettle();
        }
        final beforeConnection = session.connectionId,
            beforeTickets = tickets.length;
        expect(beforeConnection, isNotNull);
        expect(beforeTickets, greaterThan(0));
        debugPrint('LIFECYCLE_STOP_API');
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
        }, 'owned API stops');
        final pendingText = 'Lifecycle queued $marker مرحبا 👋';
        await tester.enterText(
          find.descendant(
            of: find.byType(TextComposer),
            matching: find.byType(EditableText),
          ),
          pendingText,
        );
        await tester.pump();
        await tester.tap(find.bySemanticsLabel('Send message'));
        await tester.pump();
        var rows = await session.repository.messages(room.id, limit: 200);
        await boundary(
          tester,
          () async {
            rows = await session.repository.messages(room.id, limit: 200);
            return rows.any(
              (row) =>
                  row['text'] == pendingText && row['send_state'] == 'queued',
            );
          },
          'offline intent queued',
          seconds: 20,
        );
        final clientId =
            rows.firstWhere(
                  (row) => row['text'] == pendingText,
                )['client_message_id']
                as String;
        final beforeCursor = await session.repository.cursor(),
            cachedCount = rows.length;
        replayTargets.clear();
        observer = NativeLifecycleObserver((state) {
          lifecycle.add({
            'state': state.name,
            'at': DateTime.now().toUtc().toIso8601String(),
          });
          if (state == AppLifecycleState.paused && !sawPaused) {
            sawPaused = true;
            backgroundCapture =
                () async {
                  var pending = (await session.repository.messages(
                    room.id,
                    limit: 200,
                  )).firstWhere((row) => row['client_message_id'] == clientId);
                  final settle = DateTime.now().add(const Duration(seconds: 2));
                  while (pending['send_state'] == 'sending' &&
                      DateTime.now().isBefore(settle)) {
                    await Future<void>.delayed(
                      const Duration(milliseconds: 10),
                    );
                    pending =
                        (await session.repository.messages(
                          room.id,
                          limit: 200,
                        )).firstWhere(
                          (row) => row['client_message_id'] == clientId,
                        );
                  }
                  paused = {
                    'marker': marker,
                    'dataset': session.repository.dataset,
                    'deviceId': session.api.device,
                    'roomId': room.id,
                    'clientMessageId': clientId,
                    'cursor': await session.repository.cursor(),
                    'cachedCount': cachedCount,
                    'lifecycle': lifecycle,
                    'foreground': session.foreground,
                    'state': session.state,
                    'connectionId': session.connectionId,
                    'sendState': pending['send_state'],
                  };
                  await backgroundFile.writeAsString(
                    jsonEncode(paused),
                    flush: true,
                  );
                  debugPrint('LIFECYCLE_PAUSED');
                }().catchError((Object error) async {
                  backgroundFailure = error.toString();
                  await failedFile.writeAsString(
                    jsonEncode({'marker': marker, 'error': backgroundFailure}),
                    flush: true,
                  );
                });
          }
          if (state == AppLifecycleState.resumed &&
              sawPaused &&
              !resumed.isCompleted) {
            resumed.complete();
          }
        });
        WidgetsBinding.instance.addObserver(observer);
        debugPrint('LIFECYCLE_READY');
        await resumed.future.timeout(const Duration(seconds: 90));
        await backgroundCapture;
        expect(backgroundFailure, isNull);
        expect(paused!['foreground'], isFalse);
        expect(paused!['state'], 'backgroundPaused');
        expect(paused!['connectionId'], isNull);
        expect(paused!['sendState'], 'queued');
        expect(paused!['cursor'], beforeCursor);
        await tester.pump();
        await waitFor(
          tester,
          () => session.state == 'live',
          reason: 'foreground connection resumes',
        );
        expect(session.foreground, isTrue);
        expect(session.connectionId, isNot(beforeConnection));
        expect(tickets.length, greaterThan(beforeTickets));
        expect(
          tickets.last == tickets.first,
          isFalse,
          reason: 'fresh reconnect ticket',
        );
        final peer = object(
          jsonDecode(
            await File(p.join(directory, 'lifecycle-peer-$marker.json'))
                .readAsString(),
          ),
        );
        expect(
          replayTargets.any((target) => target >= (peer['workerHead'] as int)),
          isTrue,
          reason: 'foreground sync.started covers peer event published while paused',
        );
        await boundary(tester, () async {
          rows = await session.repository.messages(room.id, limit: 200);
          return rows.any(
                (row) =>
                    row['client_message_id'] == clientId &&
                    row['send_state'] == 'sent',
              ) &&
              rows.any((row) => row['server_id'] == peer['messageId']);
        }, 'replay and original outgoing intent converge');
        final canonical = rows
            .where((row) => row['client_message_id'] == clientId)
            .single;
        expect(
          rows.where((row) => row['server_id'] == peer['messageId']).length,
          1,
        );
        await boundary(tester, () async {
          return (await session.repository.rooms()).any(
            (cached) =>
                cached.id == room.id &&
                (cached.json['lastMessage'] as Map?)?['messageId'] ==
                    canonical['server_id'],
          );
        }, 'original outgoing canonical durable echo committed');
        expect((await session.repository.counts())['queued'], 0);
        binding.reportData = {
          'status': 'passed',
          'marker': marker,
          'deviceId': session.api.device,
          'clientMessageId': clientId,
          'messageId': canonical['server_id'],
          'peerMessageId': peer['messageId'],
          'beforeCursor': beforeCursor,
          'afterCursor': await session.repository.cursor(),
          'beforeConnection': beforeConnection,
          'afterConnection': session.connectionId,
          'freshTicket': true,
          'replayTargets': replayTargets,
          'historyPages': history,
          'lifecycle': lifecycle,
        };
        await File(p.join(directory, 'lifecycle-completed-$marker.json'))
            .writeAsString(jsonEncode(binding.reportData), flush: true);
        debugPrint('LIFECYCLE_RECOVERED');
        WidgetsBinding.instance.removeObserver(observer);
        observer = null;
        await container.read(accountProvider.notifier).switchAccount();
        await tester.pump();
      } catch (error, stack) {
        await failedFile.writeAsString(
          jsonEncode({
            'marker': marker,
            'error': error.toString(),
            'stack': stack.toString(),
            'replayTargets': replayTargets,
            'lifecycle': lifecycle,
          }),
          flush: true,
        );
        rethrow;
      } finally {
        if (observer != null) WidgetsBinding.instance.removeObserver(observer);
      }
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
