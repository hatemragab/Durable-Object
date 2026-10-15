import 'dart:async';
import 'dart:math';

import 'package:durable_chat_demo/app.dart';
import 'package:durable_chat_demo/application.dart';
import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/core/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'session_test.dart' show TestApi, TestRepository;
import 'storage_test.dart' show eventRoom;

class HistoryApi extends TestApi {
  final boundaries = <int?>[];
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    if (path.endsWith('/messages')) {
      boundaries.add(query?['beforeRoomSeq'] as int?);
      return {
        'messages': <Json>[],
        'window': {'fromRoomSeq': 0, 'throughRoomSeq': 0},
        'hasMore': boundaries.length == 1,
        'nextBeforeRoomSeq': boundaries.length == 1 ? 71 : null,
      };
    }
    return super.request(method, path, data: data, query: query);
  }
}

class HistoryRepository extends TestRepository {
  @override
  Future<List<Json>> messages(String roomId, {int limit = 50}) async => [
    for (var seq = 101 - limit; seq <= 100; seq++)
      {
        'local_key': 'message-$seq',
        'sender_id': '1',
        'text': 'Message $seq',
        'send_state': 'sent',
        'local_created_at': '2026-10-15T00:00:00.000Z',
      },
  ];
  @override
  Stream<T> watchQuery<T>(Future<T> Function() query) => Stream.fromFuture(
    Future<void>.delayed(const Duration(milliseconds: 50)).then((_) => query()),
  );
}

class FixedAccount extends AccountController {
  FixedAccount(this.session);
  final AccountSession session;
  @override
  AccountState build() => AccountState(session: session);
  void changed() =>
      state = AccountState(session: session, revision: state.revision + 1);
}

class GrowingHistoryApi extends TestApi {
  int head = 29;
  final boundaries = <int?>[];
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    if (path.endsWith('/messages')) {
      final before = query?['beforeRoomSeq'] as int?;
      boundaries.add(before);
      return {
        'messages': <Json>[],
        'hasMore': before == null && head > 30,
        'nextBeforeRoomSeq': before == null && head > 30 ? head - 29 : null,
        'window': {
          'fromRoomSeq': before == null ? max(1, head - 29) : 1,
          'throughRoomSeq': before == null ? head : before - 1,
        },
      };
    }
    return super.request(method, path, data: data, query: query);
  }
}

class GrowingHistoryRepository extends HistoryRepository {
  int head = 29;
  @override
  Future<Json?> messageWindow(String roomId) async => {
    'from_seq': 1,
    'through_seq': 29,
  };
  @override
  Future<List<Json>> messages(String roomId, {int limit = 50}) async => [
    for (var seq = max(1, head - limit + 1); seq <= head; seq++)
      {
        'local_key': 'growing-$seq',
        'sender_id': '1',
        'text': 'Message $seq',
        'send_state': 'sent',
        'local_created_at': '2026-10-15T00:00:00.000Z',
      },
  ];
}

void main() {
  testWidgets('live growth from29 to31 restores older-message pagination', (
    tester,
  ) async {
    final api = GrowingHistoryApi(), repository = GrowingHistoryRepository();
    FixedAccount? account;
    final session = AccountSession(
      repository: repository,
      api: api,
      onChanged: () => account?.changed(),
    );
    final room = eventRoom('direct-room-created');
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          accountProvider.overrideWith(() => account = FixedAccount(session)),
        ],
        child: MaterialApp(home: MessagePage(room: room)),
      ),
    );
    await tester.pumpAndSettle();
    expect(session.latestHistory(room.id)!['hasMore'], false);
    expect(find.text('Load older messages'), findsNothing);
    api.head = 31;
    repository.head = 31;
    await session.refreshActiveRoom();
    await tester.pumpAndSettle();
    final list = find.byType(ListView);
    final scroll = tester.widget<ListView>(list).controller!;
    for (
      var i = 0;
      i < 8 &&
          find.text('Load older messages').hitTestable().evaluate().isEmpty;
      i++
    ) {
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pumpAndSettle();
    }
    expect(find.text('Load older messages').hitTestable(), findsOneWidget);
    await tester.tap(find.text('Load older messages'));
    await tester.pumpAndSettle();
    expect(api.boundaries.last, 2);
    expect(tester.widget<ListView>(list).semanticChildCount, 32);
    await tester.pumpWidget(const SizedBox());
    await session.dispose();
  });
  testWidgets(
    'older page expands visible window without losing scroll offset',
    (tester) async {
      final api = HistoryApi(), repository = HistoryRepository();
      final session = AccountSession(
        repository: repository,
        api: api,
        onChanged: () {},
      );
      final room = eventRoom('direct-room-created');
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            accountProvider.overrideWith(() => FixedAccount(session)),
          ],
          child: MaterialApp(home: MessagePage(room: room)),
        ),
      );
      await tester.pumpAndSettle();
      final list = find.byType(ListView);
      final scroll = tester.widget<ListView>(list).controller!;
      expect(tester.widget<ListView>(list).semanticChildCount, 31);
      for (var i = 0; i < 8; i++) {
        scroll.jumpTo(scroll.position.maxScrollExtent);
        await tester.pumpAndSettle();
        if (find
            .text('Load older messages')
            .hitTestable()
            .evaluate()
            .isNotEmpty) {
          break;
        }
      }
      final before = scroll.offset;
      expect(before, greaterThan(0));
      await tester.tap(find.text('Load older messages'));
      await tester.pumpAndSettle();
      expect(api.boundaries, [null, 71]);
      expect(tester.widget<ListView>(list).semanticChildCount, 61);
      expect(scroll.offset, closeTo(before, 2));
      await tester.pumpWidget(const SizedBox());
      await session.dispose();
    },
  );
}
