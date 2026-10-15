import 'dart:async';

import 'package:durable_chat_demo/core/models.dart';
import 'package:durable_chat_demo/features/chat/widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:v_chat_input_ui/v_chat_input_ui.dart';

void main() {
  testWidgets('required bubble and text-only composer compile and render', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TextBubbleScope(
            child: Column(
              children: [
                TextMessageBubble(
                  message: {
                    'local_key': 'test',
                    'text': 'Hello مرحبا 👋',
                    'sender_id': '1',
                    'send_state': 'sent',
                    'local_created_at': '2026-10-15T00:00:00.000Z',
                  },
                  user: '1',
                  group: false,
                  onRetry: () {},
                ),
                TextComposer(onPersist: (_) async {}),
              ],
            ),
          ),
        ),
      ),
    );
    expect(find.byType(VMessageInputWidget), findsOneWidget);
    final widget = tester.widget<VMessageInputWidget>(
      find.byType(VMessageInputWidget),
    );
    expect(widget.enableAttachments, isFalse);
    expect(widget.enableCamera, isFalse);
    expect(widget.enableVoiceRecording, isFalse);
    expect(widget.enableEmojiPicker, isFalse);
    expect(find.byType(EditableText), findsOneWidget);
  });

  testWidgets('submission awaits storage and preserves failure draft', (
    tester,
  ) async {
    final pending = Completer<void>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: TextComposer(onPersist: (_) => pending.future)),
      ),
    );
    await tester.enterText(find.byType(EditableText), 'Keep this draft');
    await tester.pump();
    final widget = tester.widget<VMessageInputWidget>(
      find.byType(VMessageInputWidget),
    );
    // Invoke the same package-owned submit button as the app.
    final buttons = find.bySemanticsLabel('Send message');
    expect(buttons, findsOneWidget);
    await tester.tap(buttons);
    await tester.pump();
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).controller.text,
      'Keep this draft',
    );
    pending.completeError(const ChatFailure('STORAGE_FAILED', 'Disk full.'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).controller.text,
      'Keep this draft',
    );
    expect(find.text('Disk full.'), findsOneWidget);
    expect(widget.enableVoiceRecording, isFalse);
  });

  testWidgets('a newer draft survives an earlier successful persistence', (
    tester,
  ) async {
    final pending = Completer<void>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: TextComposer(onPersist: (_) => pending.future)),
      ),
    );
    await tester.enterText(find.byType(EditableText), 'First draft');
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Send message'));
    await tester.pump();
    await tester.enterText(find.byType(EditableText), 'New draft');
    pending.complete();
    await tester.pumpAndSettle();
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).controller.text,
      'New draft',
    );
  });
  testWidgets(
    'successful persistence clears once and preserves submitted text',
    (tester) async {
      final pending = Completer<void>();
      final submissions = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TextComposer(
              onPersist: (text) {
                submissions.add(text);
                return pending.future;
              },
            ),
          ),
        ),
      );
      const draft = '  مرحبا 👋\nNew line  ';
      await tester.enterText(find.byType(EditableText), draft);
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('Send message'));
      await tester.tap(find.bySemanticsLabel('Send message'));
      await tester.pump();
      expect(submissions, [draft]);
      expect(
        tester.widget<EditableText>(find.byType(EditableText)).controller.text,
        draft,
      );
      pending.complete();
      await tester.pumpAndSettle();
      expect(
        tester.widget<EditableText>(find.byType(EditableText)).controller.text,
        isEmpty,
      );
    },
  );
}
