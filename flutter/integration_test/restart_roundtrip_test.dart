import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import 'restart_prepare_test.dart' show prepareRestart, validateMarker;
import 'restart_recover_test.dart' show recoverRestart;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'same installed binary preserves pending intent across abrupt termination',
    (tester) async {
      final marker = validateMarker();
      final directory = await getDatabasesPath();
      final prepared = File(p.join(directory, 'restart-$marker.json'));
      try {
        if (await prepared.exists()) {
          await recoverRestart(tester, binding);
        } else {
          await prepareRestart(tester, binding);
        }
      } catch (error) {
        await File(p.join(directory, 'restart-failed-$marker.json'))
            .writeAsString(
              jsonEncode({'marker': marker, 'error': error.toString()}),
              flush: true,
            );
        debugPrint('RESTART_FAILED:$marker');
        rethrow;
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
