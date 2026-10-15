import 'dart:convert';

typedef Json = Map<String, dynamic>;

const demoUsers = ['1', '2', '3'];
const defaultDataset = '90000000-0000-4000-8000-000000000001';

class ChatFailure implements Exception {
  const ChatFailure(
    this.code,
    this.message, {
    this.retryable = false,
    this.retryAfterMs,
  });
  final String code;
  final String message;
  final bool retryable;
  final int? retryAfterMs;
  @override
  String toString() => '$code: $message';
}

Never invalid(String message) => throw ChatFailure('VALIDATION_ERROR', message);

Json object(dynamic value) {
  if (value is! Map<String, dynamic>) invalid('Expected a JSON object.');
  return value;
}

String string(dynamic value, String field) {
  if (value is! String) invalid('Invalid $field.');
  return value;
}

int sequence(dynamic value, {bool positive = false}) {
  if (value is! int || value < (positive ? 1 : 0) || value > 9007199254740991) {
    invalid('Invalid sequence.');
  }
  return value;
}

final _uuid = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
);
String uuid(dynamic value) {
  final result = string(value, 'UUID');
  if (!_uuid.hasMatch(result)) invalid('Invalid UUID.');
  return result;
}

String userId(dynamic value) {
  if (!demoUsers.contains(value)) invalid('Unknown user.');
  return value as String;
}

String timestamp(dynamic value) {
  final result = string(value, 'timestamp');
  if (!result.endsWith('Z') || DateTime.tryParse(result) == null) {
    invalid('Invalid UTC timestamp.');
  }
  return result;
}

bool _isContractWhitespace(int unit) =>
    (unit >= 0x0009 && unit <= 0x000d) ||
    unit == 0x0020 ||
    unit == 0x0085 ||
    unit == 0x00a0 ||
    unit == 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) ||
    unit == 0x2028 ||
    unit == 0x2029 ||
    unit == 0x202f ||
    unit == 0x205f ||
    unit == 0x3000 ||
    unit == 0xfeff;

/// Explicit wire semantics, mirrored in TypeScript; native trim sets may differ.
String trimContractWhitespace(String value) {
  var start = 0;
  var end = value.length;
  while (start < end && _isContractWhitespace(value.codeUnitAt(start))) {
    start++;
  }
  while (end > start && _isContractWhitespace(value.codeUnitAt(end - 1))) {
    end--;
  }
  return value.substring(start, end);
}

void _validateScalars(String text) {
  final units = text.codeUnits;
  for (var i = 0; i < units.length; i++) {
    final unit = units[i];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++i >= units.length || units[i] < 0xdc00 || units[i] > 0xdfff) {
        invalid('Invalid Unicode scalar value.');
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid('Invalid Unicode scalar value.');
    }
  }
}

void validateText(String text) {
  _validateScalars(text);
  if (trimContractWhitespace(text).isEmpty ||
      text.runes.length > 2000 ||
      utf8.encode(text).length > 8192) {
    invalid('Use 1–2,000 Unicode characters and at most 8,192 UTF-8 bytes.');
  }
}

String normalizeTitle(String value) {
  final title = trimContractWhitespace(value);
  _validateScalars(title);
  if (title.isEmpty || title.runes.length > 80) {
    invalid('Invalid group title.');
  }
  return title;
}

dynamic _canonical(dynamic value) {
  if (value is Map) {
    return {
      for (final key in value.keys.map((e) => e as String).toList()..sort())
        key: _canonical(value[key]),
    };
  }
  if (value is List) return value.map(_canonical).toList();
  return value;
}

String fingerprint(dynamic value) => jsonEncode(_canonical(value));

class Room {
  Room.fromJson(Json value) : json = Map.unmodifiable(value) {
    uuid(value['id']);
    if (!['direct', 'group'].contains(value['type'])) {
      invalid('Invalid room type.');
    }
    final members = value['memberIds'];
    if (members is! List || members.length < 2 || members.length > 3) {
      invalid('Invalid members.');
    }
    members.forEach(userId);
    if (members.toSet().length != members.length ||
        fingerprint(members.toList()..sort()) != fingerprint(members)) {
      invalid('Members must be distinct and sorted.');
    }
    if (!members.contains(userId(value['createdBy']))) {
      invalid('Creator is not a member.');
    }
    if (value['type'] == 'direct') {
      if (members.length != 2 || value['title'] != null) {
        invalid('Invalid direct room.');
      }
    } else {
      final title = string(value['title'], 'title');
      if (normalizeTitle(title) != title) {
        invalid('Group title must already be normalized.');
      }
    }
    timestamp(value['createdAt']);
    timestamp(value['updatedAt']);
    sequence(value['version'], positive: true);
    sequence(value['revision'], positive: true);
    sequence(value['unreadCount']);
    final read = sequence(value['lastReadSeq']);
    final last = sequence(value['lastMessageSeq']);
    if (read > last || sequence(value['unreadCount']) > last - read) {
      invalid('Invalid room unread/read state.');
    }
    if (last == 0) {
      if (value['lastMessage'] != null) invalid('Unexpected preview.');
    } else {
      final preview = object(value['lastMessage']);
      uuid(preview['messageId']);
      userId(preview['senderId']);
      validateText(string(preview['text'], 'text'));
      timestamp(preview['createdAt']);
      if (sequence(preview['roomSeq'], positive: true) != last) {
        invalid('Preview sequence mismatch.');
      }
    }
  }
  final Json json;
  String get id => json['id'] as String;
  int get version => json['version'] as int;
  int get revision => json['revision'] as int;
  int get unreadCount => json['unreadCount'] as int;
  List<String> get members => (json['memberIds'] as List).cast<String>();
  bool get isGroup => json['type'] == 'group';
  String name(String viewer) => isGroup
      ? json['title'] as String
      : 'User ${members.firstWhere((id) => id != viewer)}';
}

class Message {
  Message.fromJson(Json value) : json = Map.unmodifiable(value) {
    uuid(value['id']);
    uuid(value['roomId']);
    uuid(value['originDeviceId']);
    uuid(value['clientMessageId']);
    userId(value['senderId']);
    sequence(value['roomSeq'], positive: true);
    if (value['type'] != 'text') invalid('Only text messages are supported.');
    validateText(string(value['text'], 'text'));
    timestamp(value['createdAt']);
  }
  final Json json;
  String get id => json['id'] as String;
  String get roomId => json['roomId'] as String;
  String get senderId => json['senderId'] as String;
  String get clientId => json['clientMessageId'] as String;
  String get text => json['text'] as String;
  int get roomSeq => json['roomSeq'] as int;
}

class DurableEvent {
  DurableEvent.fromJson(
    this.json, {
    required String dataset,
    required String recipient,
  }) {
    if (json['v'] != 2 ||
        json['datasetId'] != dataset ||
        json['userId'] != recipient) {
      invalid('Event identity/protocol mismatch.');
    }
    sequence(json['streamSeq'], positive: true);
    if (json['type'] != 'room.upserted') {
      throw const ChatFailure('UNSUPPORTED_EVENT', 'Unsupported room delta.');
    }
    if (json.containsKey('eventId') ||
        json.containsKey('occurredAt') ||
        utf8.encode(jsonEncode(json)).length > 32768) {
      invalid('Invalid room delta.');
    }
    final data = object(json['data']);
    if (data.keys.any((key) => key != 'room')) {
      invalid('Unexpected delta data.');
    }
    room = Room.fromJson(object(data['room']));
    if (!room.members.contains(recipient)) {
      invalid('Room excludes this recipient.');
    }
  }
  final Json json;
  late final Room room;
  int get seq => json['streamSeq'] as int;
}

class Presence {
  Presence.fromJson(Json value) {
    id = userId(value['userId']);
    state = string(value['state'], 'presence state');
    if (!['online', 'offline', 'unknown'].contains(state)) {
      invalid('Invalid presence.');
    }
    if (state == 'unknown') {
      if ([
        'activeDeviceCount',
        'connectionCount',
        'revision',
        'observedAt',
      ].any((key) => value[key] != null)) {
        invalid('Unknown presence has no observations.');
      }
    } else {
      final devices = sequence(value['activeDeviceCount']);
      final connections = sequence(value['connectionCount']);
      revision = sequence(value['revision']);
      observedAt = DateTime.parse(timestamp(value['observedAt']));
      if ((state == 'online' && (devices == 0 || connections < devices)) ||
          (state == 'offline' && (devices != 0 || connections != 0))) {
        invalid('Invalid presence counts.');
      }
    }
  }
  late final String id;
  late final String state;
  int? revision;
  DateTime? observedAt;
  DateTime receivedAt = DateTime.now();
  String freshState(DateTime now, {required bool connected}) =>
      connected &&
          observedAt != null &&
          now.difference(receivedAt).inSeconds < 60 &&
          now.difference(observedAt!).inSeconds < 60
      ? state
      : 'unknown';
}
