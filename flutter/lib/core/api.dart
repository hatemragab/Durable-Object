import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import 'models.dart';

class AppConfig {
  const AppConfig({
    this.apiBaseUrl = const String.fromEnvironment(
      'API_BASE_URL',
      defaultValue: 'http://127.0.0.1:3000/api/v1',
    ),
    this.dataset = const String.fromEnvironment(
      'EXPECTED_DATASET_ID',
      defaultValue: defaultDataset,
    ),
  });
  final String apiBaseUrl;
  final String dataset;
  void validate() {
    uuid(dataset);
    final uri = Uri.tryParse(apiBaseUrl);
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      invalid('Invalid public API_BASE_URL.');
    }
    // Demo account-selection must never become a release-mode login system.
    if (kReleaseMode) {
      throw const ChatFailure(
        'DEVELOPMENT_ONLY',
        'This demo does not support release/production mode.',
      );
    }
  }
}

class ApiClient {
  ApiClient(this.config, this.user, this.device, {Dio? dio})
    : dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: config.apiBaseUrl,
              connectTimeout: const Duration(seconds: 10),
              receiveTimeout: const Duration(seconds: 15),
            ),
          );
  final AppConfig config;
  final String user;
  final String device;
  final Dio dio;
  final CancelToken cancellation = CancelToken();
  String? _token;
  DateTime? _expires;
  Future<void>? _renewing;
  bool reachable = false;
  bool _disposed = false;

  void _identity(Json data) {
    if (data['datasetId'] != config.dataset) {
      throw const ChatFailure(
        'DATASET_MISMATCH',
        'The API points to another dataset. Pending data is retained.',
      );
    }
  }

  Future<void> session({bool force = false}) async {
    if (_disposed) throw const ChatFailure('CANCELLED', 'Account closed.');
    if (!force &&
        _token != null &&
        _expires!.isAfter(DateTime.now().add(const Duration(minutes: 1)))) {
      return;
    }
    if (_renewing != null) return _renewing;
    final operation = () async {
      final data = await _raw('POST', '/dev/session', {
        'userId': user,
        'deviceId': device,
      });
      _identity(data);
      if (object(data['user'])['id'] != user ||
          data['deviceId'] != device ||
          data['protocolVersion'] != 2) {
        invalid('Session identity mismatch.');
      }
      final token = string(data['sessionToken'], 'sessionToken');
      final expires = DateTime.parse(timestamp(data['expiresAt']));
      if (_disposed) throw const ChatFailure('CANCELLED', 'Account closed.');
      _token = token;
      _expires = expires;
    }();
    _renewing = operation;
    try {
      await operation;
    } finally {
      _renewing = null;
    }
  }

  Future<Json> request(
    String method,
    String path, {
    Json? data,
    Json? query,
  }) async {
    await session();
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final result = await _raw(
          method,
          path,
          data,
          query: query,
          authorized: true,
        );
        _identity(result);
        return result;
      } on ChatFailure catch (error) {
        if (attempt == 0 &&
            ['UNAUTHORIZED', 'SESSION_EXPIRED'].contains(error.code)) {
          await session(force: true);
          continue;
        }
        rethrow;
      }
    }
    throw const ChatFailure(
      'UNAUTHORIZED',
      'Could not renew the development session.',
    );
  }

  Future<Json> _raw(
    String method,
    String path,
    Json? data, {
    Json? query,
    bool authorized = false,
  }) async {
    try {
      final response = await dio.request<dynamic>(
        path,
        data: data,
        queryParameters: query,
        cancelToken: cancellation,
        options: Options(
          method: method,
          headers: {if (authorized) 'Authorization': 'Bearer $_token'},
        ),
      );
      reachable = true;
      return object(response.data);
    } on DioException catch (error) {
      final response = error.response;
      reachable = response != null;
      final body = response?.data;
      if (body is Map && body['error'] is Map) {
        final detail = body['error'] as Map;
        final retryHeader = response?.headers.value('retry-after');
        final retrySeconds = int.tryParse(retryHeader ?? '');
        DateTime? retryDate;
        if (retryHeader != null && retrySeconds == null) {
          try {
            retryDate = HttpDate.parse(retryHeader);
          } on FormatException {
            /* Ignore malformed Retry-After headers. */
          }
        }
        final retryMs = retrySeconds != null
            ? retrySeconds * 1000
            : retryDate?.difference(DateTime.now()).inMilliseconds;
        throw ChatFailure(
          detail['code'] is String
              ? detail['code'] as String
              : 'REQUEST_FAILED',
          detail['message'] is String
              ? detail['message'] as String
              : 'Request failed.',
          retryable: detail['retryable'] == true,
          retryAfterMs: retryMs?.clamp(0, 86400000),
        );
      }
      final status = response?.statusCode;
      if (CancelToken.isCancel(error)) {
        throw const ChatFailure('CANCELLED', 'Request cancelled.');
      }
      throw ChatFailure(
        status == 401
            ? 'UNAUTHORIZED'
            : status == 429
            ? 'RATE_LIMITED'
            : 'DEPENDENCY_UNAVAILABLE',
        status == null
            ? 'The local API is unreachable.'
            : 'The API returned HTTP $status.',
        retryable: status == null || status == 429 || status >= 500,
      );
    }
  }

  void close() {
    _disposed = true;
    cancellation.cancel();
    dio.close(force: true);
    _token = null;
  }
}
