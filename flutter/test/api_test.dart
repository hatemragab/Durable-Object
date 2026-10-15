import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:durable_chat_demo/core/api.dart';
import 'package:durable_chat_demo/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

class HandlerAdapter implements HttpClientAdapter {
  HandlerAdapter(this.handler);
  final Future<ResponseBody> Function(RequestOptions options) handler;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) => handler(options);
  @override
  void close({bool force = false}) {}
}

ResponseBody body(
  Json value, [
  int status = 200,
  Map<String, List<String>> extra = const {},
]) => ResponseBody.fromString(
  jsonEncode(value),
  status,
  headers: {
    Headers.contentTypeHeader: [Headers.jsonContentType],
    ...extra,
  },
);
Json sessionBody() => {
  'datasetId': defaultDataset,
  'user': {'id': '1', 'name': 'User 1'},
  'deviceId': '60000000-0000-4000-8000-000000000001',
  'sessionToken': 'test-only-token',
  'expiresAt': DateTime.now()
      .add(const Duration(hours: 24))
      .toUtc()
      .toIso8601String(),
  'protocolVersion': 2,
};
ApiClient client(Future<ResponseBody> Function(RequestOptions) handler) {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api/v1'))
    ..httpClientAdapter = HandlerAdapter(handler);
  return ApiClient(
    const AppConfig(),
    '1',
    '60000000-0000-4000-8000-000000000001',
    dio: dio,
  );
}

void main() {
  test('session renewal retries once with original idempotency body', () async {
    var sessions = 0, sends = 0;
    final bodies = <Json>[];
    final api = client((request) async {
      if (request.path == '/dev/session') {
        sessions++;
        return body(sessionBody());
      }
      sends++;
      bodies.add(Map<String, dynamic>.from(request.data as Map));
      if (sends == 1) {
        return body({
          'error': {
            'code': 'SESSION_EXPIRED',
            'message': 'Expired',
            'retryable': false,
          },
        }, 401);
      }
      return body({'datasetId': defaultDataset, 'duplicate': true});
    });
    const intent = {
      'clientMessageId': '40000000-0000-4000-8000-000000000001',
      'text': 'Same exact text',
    };
    await api.request('POST', '/rooms/example/messages', data: intent);
    expect(sessions, 2);
    expect(sends, 2);
    expect(bodies, [intent, intent]);
    api.close();
  });
  test('repeated authorization failure stops after one renewal', () async {
    var sessions = 0, sends = 0;
    final api = client((request) async {
      if (request.path == '/dev/session') {
        sessions++;
        return body(sessionBody());
      }
      sends++;
      return body({
        'error': {
          'code': 'UNAUTHORIZED',
          'message': 'Denied',
          'retryable': false,
        },
      }, 401);
    });
    await expectLater(
      api.request('GET', '/rooms'),
      throwsA(
        isA<ChatFailure>().having(
          (error) => error.code,
          'code',
          'UNAUTHORIZED',
        ),
      ),
    );
    expect(sessions, 2);
    expect(sends, 2);
    api.close();
  });
  test(
    'dataset mismatch is surfaced without replacing cached identity',
    () async {
      final api = client(
        (_) async => body({
          ...sessionBody(),
          'datasetId': '90000000-0000-4000-8000-000000000099',
        }),
      );
      await expectLater(
        api.session(),
        throwsA(
          isA<ChatFailure>().having(
            (error) => error.code,
            'code',
            'DATASET_MISMATCH',
          ),
        ),
      );
      api.close();
    },
  );
  test('rate limiting preserves Retry-After seconds', () async {
    final api = client((request) async {
      if (request.path == '/dev/session') return body(sessionBody());
      return body(
        {
          'error': {
            'code': 'RATE_LIMITED',
            'message': 'Wait',
            'retryable': true,
          },
        },
        429,
        {
          'retry-after': ['7'],
        },
      );
    });
    await expectLater(
      api.request('GET', '/rooms'),
      throwsA(
        isA<ChatFailure>()
            .having((error) => error.retryAfterMs, 'retry after', 7000)
            .having((error) => error.retryable, 'retryable', true),
      ),
    );
    api.close();
  });
  test('closed account rejects new requests', () async {
    final api = client((_) async => body(sessionBody()));
    api.close();
    await expectLater(
      api.session(),
      throwsA(
        isA<ChatFailure>().having((error) => error.code, 'code', 'CANCELLED'),
      ),
    );
  });
  test(
    'permanent demo cap remains non-retryable without an automatic retry',
    () async {
      var requests = 0;
      final api = client((request) async {
        if (request.path == '/dev/session') return body(sessionBody());
        requests++;
        return body({
          'error': {
            'code': 'DEMO_LIMIT_REACHED',
            'message': 'Demo safety limit reached.',
            'retryable': false,
          },
        }, 429);
      });
      await expectLater(
        api.request('GET', '/rooms'),
        throwsA(
          isA<ChatFailure>()
              .having((error) => error.code, 'code', 'DEMO_LIMIT_REACHED')
              .having((error) => error.retryable, 'retryable', false),
        ),
      );
      expect(requests, 1);
      api.close();
    },
  );
}
