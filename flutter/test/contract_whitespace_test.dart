import 'dart:convert';
import 'dart:io';

import 'package:durable_chat_demo/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

Json fixture(String name) => object(
  jsonDecode(File('../shared/fixtures/$name.json').readAsStringSync()),
);

void main() {
  final cases = fixture('whitespace-validation');

  test('every canonical whitespace scalar is blank in text and titles', () {
    for (final point in (cases['whitespaceCodePoints'] as List).cast<int>()) {
      final value = String.fromCharCode(point);
      expect(trimContractWhitespace(value), '');
      expect(() => validateText(value), throwsA(isA<ChatFailure>()));
      expect(() => normalizeTitle(value), throwsA(isA<ChatFailure>()));
    }
  });

  test('NEL, BOM and mixed blank durable messages are rejected', () {
    for (final text in (cases['blankTexts'] as List).cast<String>()) {
      expect(() => validateText(text), throwsA(isA<ChatFailure>()));
      final event = fixture('direct-message-created');

      event['data']['room']['lastMessage']['text'] = text;
      expect(
        () => DurableEvent.fromJson(
          event,
          dataset: defaultDataset,
          recipient: '2',
        ),
        throwsA(isA<ChatFailure>()),
      );
    }
  });

  test(
    'nonblank messages retain exact content including boundary whitespace',
    () {
      for (final text in (cases['preservedTexts'] as List).cast<String>()) {
        validateText(text);
        final event = fixture('direct-message-created');

        event['data']['room']['lastMessage']['text'] = text;
        expect(
          DurableEvent.fromJson(
            event,
            dataset: defaultDataset,
            recipient: '2',
          ).room.json['lastMessage']['text'],
          text,
        );
      }
      for (final point
          in (cases['nonWhitespaceCodePoints'] as List).cast<int>()) {
        final text = String.fromCharCode(point);
        expect(trimContractWhitespace(text), text);
        validateText(text);
      }
    },
  );

  test(
    'mixed NEL and BOM title boundaries normalize once before scalar limit',
    () {
      final room = object(fixture('group-room-created')['data']['room']);
      for (final value in cases['titleCases'] as List) {
        final title = object(value);
        final input = title['input'] as String;
        final normalized = title['normalized'] as String;
        expect(normalizeTitle(input), normalized);
        expect(normalizeTitle(normalized), normalized);
        expect(
          () => Room.fromJson({...room, 'title': input}),
          throwsA(isA<ChatFailure>()),
        );
        expect(
          Room.fromJson({...room, 'title': normalized}).json['title'],
          normalized,
        );
      }
      expect(normalizeTitle('\u0085${'x' * 80}\ufeff'), 'x' * 80);
      expect(() => normalizeTitle('\u0085\ufeff'), throwsA(isA<ChatFailure>()));
      expect(() => normalizeTitle('x' * 81), throwsA(isA<ChatFailure>()));
      expect(() => normalizeTitle('\ud800'), throwsA(isA<ChatFailure>()));
    },
  );
}
