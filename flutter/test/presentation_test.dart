import 'dart:async';

import 'package:durable_chat_demo/app.dart';
import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:durable_chat_demo/features/chat/presentation.dart';
import 'package:durable_chat_demo/features/chat/widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'history_widget_test.dart'
    show FixedAccount, HistoryApi, HistoryRepository;
import 'session_test.dart' show TestApi, TestRepository;
import 'storage_test.dart' show eventRoom;

Room previewRoom({
  bool group = false,
  int unread = 4,
  String? title,
  String sender = '1',
}) => Room.fromJson({
  ...eventRoom(group ? 'group-room-created' : 'direct-room-created').json,
  'title': ?title,
  'lastMessageSeq': 150,
  'unreadCount': unread,
  'lastMessage': {
    'messageId': '30000000-0000-4000-8000-000000000001',
    'roomSeq': 150,
    'senderId': sender,
    'text': group
        ? 'The new design is ready to try.'
        : 'See you in a few minutes!',
    'createdAt': '2026-10-15T10:30:00.000Z',
  },
});

class PreviewApi extends TestApi {
  int snapshots = 0;
  @override
  Future<Json> request(String method, String path, {Json? data, Json? query}) {
    if (path == '/rooms') snapshots++;
    return super.request(method, path, data: data, query: query);
  }
}

class PreviewSession extends AccountSession {
  PreviewSession({
    required super.repository,
    required super.api,
    required super.onChanged,
  });
  @override
  Future<void> connect({bool manual = false}) async {}
}

class PreviewRepository extends TestRepository {
  @override
  Future<Json?> latestPending(String room) async => null;
}

void main() {
  testWidgets(
    'room previews distinguish sender, unread semantics and failed local intent',
    (tester) async {
      var taps = 0;
      final semantics = tester.ensureSemantics();

      Future<void> tile({Json? pending}) => tester.pumpWidget(
        MaterialApp(
          theme: chatTheme(Brightness.light),
          home: Scaffold(
            body: RoomTile(
              room: previewRoom(unread: 150, sender: '2'),
              viewer: '2',
              presence: 'Presence updating',
              online: false,
              pending: pending,
              onTap: () => taps++,
            ),
          ),
        ),
      );
      await tile();
      expect(find.text('You: See you in a few minutes!'), findsOneWidget);
      expect(find.text('99+'), findsOneWidget);
      expect(
        find.bySemanticsLabel(RegExp('150 unread messages')),
        findsOneWidget,
      );
      expect(tester.widget<ChatAvatar>(find.byType(ChatAvatar)).online, false);
      await tester.tap(find.byType(RoomTile));
      expect(taps, 1);
      await tile(pending: {'send_state': 'failed', 'text': 'Please retry me'});
      expect(find.text('Failed: Please retry me'), findsOneWidget);
      expect(find.text('You: See you in a few minutes!'), findsNothing);
      expect(find.byIcon(Icons.error_outline_rounded), findsOneWidget);
      semantics.dispose();
    },
  );

  for (final scenario in [
    (
      size: const Size(375, 812),
      scale: 1.0,
      dark: false,
      rtl: false,
      name: 'rooms-light',
    ),
    (
      size: const Size(375, 812),
      scale: 1.0,
      dark: true,
      rtl: false,
      name: 'rooms-dark',
    ),
    (
      size: const Size(320, 740),
      scale: 2.0,
      dark: false,
      rtl: true,
      name: 'rooms-large-text-rtl',
    ),
    (
      size: const Size(844, 390),
      scale: 1.0,
      dark: false,
      rtl: false,
      name: 'rooms-landscape',
    ),
    (
      size: const Size(1024, 768),
      scale: 1.0,
      dark: false,
      rtl: false,
      name: 'rooms-tablet',
    ),
  ]) {
    testWidgets('inbox remains usable at ${scenario.name}', (tester) async {
      tester.view.reset();
      tester.view.physicalSize = scenario.size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      if (scenario.size.width > scenario.size.height) {
        tester.view.padding = const FakeViewPadding(left: 44, right: 44);
        addTearDown(tester.view.resetPadding);
      }
      final session = AccountSession(
        repository: PreviewRepository(),
        api: TestApi(),
        onChanged: () {},
      );
      final rooms = [
        previewRoom(
          group: true,
          title: scenario.rtl
              ? 'فريق التصميم والتطوير عنوان طويل للمحادثة'
              : 'Design & development',
        ),
        previewRoom(unread: 0, sender: '2'),
      ];
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            accountProvider.overrideWith(() => FixedAccount(session)),
            roomsProvider.overrideWith((_) => Stream.value(rooms)),
          ],
          child: MaterialApp(
            theme: chatTheme(
              scenario.dark ? Brightness.dark : Brightness.light,
            ),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scenario.scale)),
              child: Directionality(
                textDirection: scenario.rtl
                    ? TextDirection.rtl
                    : TextDirection.ltr,
                child: child!,
              ),
            ),
            home: RepaintBoundary(
              key: const ValueKey('preview'),
              child: const RoomsPage(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('New chat'), findsOneWidget);
      expect(
        find.text('User 1: The new design is ready to try.'),
        findsOneWidget,
      );
      expect(
        tester.getSize(find.byType(RoomTile).first).width,
        lessThanOrEqualTo(760),
      );
      await tester.pumpWidget(const SizedBox());
      await session.dispose();
    });
  }

  testWidgets('empty inbox can still be pulled to refresh', (tester) async {
    final api = PreviewApi();
    final session = PreviewSession(
      repository: PreviewRepository(),
      api: api,
      onChanged: () {},
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          accountProvider.overrideWith(() => FixedAccount(session)),
          roomsProvider.overrideWith((_) => Stream.value(<Room>[])),
        ],
        child: MaterialApp(
          theme: chatTheme(Brightness.light),
          home: const RoomsPage(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Your next conversation starts here'), findsOneWidget);
    expect(
      tester.widget<ListView>(find.byType(ListView)).physics,
      isA<AlwaysScrollableScrollPhysics>(),
    );
    await tester.drag(find.byType(ListView), const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(api.snapshots, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await session.dispose();
  });

  testWidgets(
    'account, creation and conversation pages support large text and a keyboard',
    (tester) async {
      tester.view.physicalSize = const Size(320, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetViewInsets);
      final session = AccountSession(
        repository: HistoryRepository(),
        api: HistoryApi(),
        onChanged: () {},
      );
      Future<void> page(Widget child) async {
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              accountProvider.overrideWith(() => FixedAccount(session)),
            ],
            child: MaterialApp(
              theme: chatTheme(Brightness.dark),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: const TextScaler.linear(2)),
                child: child!,
              ),
              home: child,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      }

      await page(const AccountPicker());
      await page(const NewChatPage());
      await tester.tap(find.text('Group'));
      await tester.pumpAndSettle();
      await tester.showKeyboard(find.byType(TextField));
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      tester.view.resetViewInsets();
      await page(MessagePage(room: eventRoom('direct-room-created')));
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await session.dispose();
    },
  );

  for (final brightness in Brightness.values) {
    testWidgets(
      'themed composer retains draft until persistence in $brightness',
      (tester) async {
        final pending = Completer<void>();
        await tester.pumpWidget(
          MaterialApp(
            theme: chatTheme(brightness),
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: TextComposer(onPersist: (_) => pending.future),
              ),
            ),
          ),
        );
        await tester.enterText(find.byType(EditableText), 'Hello مرحبا 👋');
        await tester.pumpAndSettle();
        await tester.tap(find.bySemanticsLabel('Send message'));
        await tester.pump();
        expect(
          tester
              .widget<EditableText>(find.byType(EditableText))
              .controller
              .text,
          'Hello مرحبا 👋',
        );
        pending.complete();
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<EditableText>(find.byType(EditableText))
              .controller
              .text,
          isEmpty,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('timestamps use calendar dates and include older years', (
    tester,
  ) async {
    late BuildContext context;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (value) {
            context = value;
            return const SizedBox();
          },
        ),
      ),
    );
    final now = DateTime(2026, 10, 15, 0, 5);
    expect(
      roomTimeLabel(context, DateTime(2026, 10, 14, 23, 59), now: now),
      'Yesterday',
    );
    expect(
      roomTimeLabel(context, DateTime(2026, 10, 15, 0, 1), now: now),
      isNot('Yesterday'),
    );
    expect(
      roomTimeLabel(context, DateTime(2025, 10, 15), now: now),
      contains('2025'),
    );
  });
}
