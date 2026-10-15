import 'package:flutter/material.dart';
import 'package:v_chat_input_ui/v_chat_input_ui.dart';

import '../../core/models.dart';

ThemeData chatTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final colors = ColorScheme.fromSeed(
    seedColor: const Color(0xFF176B5B),
    brightness: brightness,
    surface: dark ? const Color(0xFF121B19) : const Color(0xFFFAFCFB),
  );
  final base = ThemeData(useMaterial3: true, colorScheme: colors);
  final inputTheme = dark ? VInputTheme.dark() : VInputTheme.light();
  return base.copyWith(
    extensions: [
      inputTheme.copyWith(
        containerDecoration: BoxDecoration(
          color: colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(24),
        ),
        textFieldDecoration: const InputDecoration(
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          filled: false,
          contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        ),
        textFieldTextStyle: TextStyle(
          fontSize: 16,
          height: 1.4,
          color: colors.onSurface,
        ),
        sendBtn: Container(
          decoration: BoxDecoration(
            color: colors.primary,
            shape: BoxShape.circle,
          ),
          child: Icon(Icons.arrow_upward_rounded, color: colors.onPrimary),
        ),
      ),
    ],
    scaffoldBackgroundColor: colors.surface,
    appBarTheme: AppBarTheme(
      backgroundColor: colors.surface,
      foregroundColor: colors.onSurface,
      surfaceTintColor: Colors.transparent,
      centerTitle: false,
      titleTextStyle: base.textTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w700,
        color: colors.onSurface,
      ),
    ),
    dividerTheme: DividerThemeData(
      color: colors.outlineVariant.withValues(alpha: .5),
      thickness: .5,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: colors.surfaceContainerLow,
      contentPadding: const EdgeInsets.all(18),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: BorderSide(color: colors.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: BorderSide(color: colors.primary, width: 2),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 52),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: colors.primary,
      foregroundColor: colors.onPrimary,
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: colors.surface,
      showDragHandle: true,
    ),
  );
}

/// A common readable column for phones, landscape and tablets.
class ChatWidth extends StatelessWidget {
  const ChatWidth({super.key, required this.child, this.maxWidth = 760});
  final Widget child;
  final double maxWidth;
  @override
  Widget build(BuildContext context) => SafeArea(
    top: false,
    bottom: false,
    child: Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: child,
      ),
    ),
  );
}

class ChatAvatar extends StatelessWidget {
  const ChatAvatar({
    super.key,
    required this.identity,
    required this.label,
    this.group = false,
    this.online = false,
    this.size = 54,
  });
  final String identity, label;
  final bool group, online;
  final double size;
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final index = identity.codeUnits.fold(0, (a, b) => a + b) % 3;
    final backgrounds = [
      colors.primaryContainer,
      colors.secondaryContainer,
      colors.tertiaryContainer,
    ];
    final foregrounds = [
      colors.onPrimaryContainer,
      colors.onSecondaryContainer,
      colors.onTertiaryContainer,
    ];
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: backgrounds[index],
                  borderRadius: BorderRadius.circular(
                    group ? size * .32 : size,
                  ),
                ),
                child: Center(
                  child: group
                      ? Icon(
                          Icons.group_rounded,
                          color: foregrounds[index],
                          size: size * .46,
                        )
                      : Text(
                          label,
                          style: TextStyle(
                            fontSize: size * .33,
                            fontWeight: FontWeight.w700,
                            color: foregrounds[index],
                          ),
                          textScaler: TextScaler.noScaling,
                        ),
                ),
              ),
            ),
            if (online)
              Positioned.directional(
                textDirection: Directionality.of(context),
                end: 0,
                bottom: 0,
                child: Container(
                  width: 14,
                  height: 14,
                  decoration: BoxDecoration(
                    color: colors.primary,
                    shape: BoxShape.circle,
                    border: Border.all(color: colors.surface, width: 2.5),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Calendar dates, rather than elapsed hours, keep midnight/DST labels correct.
String roomTimeLabel(BuildContext context, DateTime date, {DateTime? now}) {
  final local = date.toLocal();
  final today = (now ?? DateTime.now()).toLocal();
  final day = DateUtils.dateOnly(local), todayDay = DateUtils.dateOnly(today);
  final localization = MaterialLocalizations.of(context);
  if (day == todayDay) {
    return localization.formatTimeOfDay(
      TimeOfDay.fromDateTime(local),
      alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
    );
  }
  if (day == DateTime(today.year, today.month, today.day - 1)) {
    return 'Yesterday';
  }
  return local.year == today.year
      ? localization.formatShortMonthDay(local)
      : localization.formatCompactDate(local);
}

class RoomTile extends StatelessWidget {
  const RoomTile({
    super.key,
    required this.room,
    required this.viewer,
    required this.presence,
    required this.online,
    required this.onTap,
    this.pending,
  });
  final Room room;
  final String viewer, presence;
  final bool online;
  final Json? pending;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context), colors = theme.colorScheme;
    final unread = room.unreadCount > 0;
    final last = room.json['lastMessage'] as Map?;
    final failed = pending?['send_state'] == 'failed';
    final prefix = pending != null
        ? (failed ? 'Failed: ' : 'Pending: ')
        : last == null
        ? ''
        : last['senderId'] == viewer
        ? 'You: '
        : room.isGroup
        ? 'User ${last['senderId']}: '
        : '';
    final preview =
        '$prefix${pending?['text'] ?? last?['text'] ?? 'Start a conversation'}';
    final name = room.name(viewer);
    final peer = room.members.where((id) => id != viewer).first;
    final timestamp = roomTimeLabel(
      context,
      DateTime.parse(
        (pending?['local_created_at'] ??
                last?['createdAt'] ??
                room.json['updatedAt'])
            as String,
      ),
    );
    final time = Text(
      timestamp,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: theme.textTheme.labelMedium?.copyWith(
        color: unread ? colors.primary : colors.onSurfaceVariant,
        fontWeight: unread ? FontWeight.w700 : FontWeight.w400,
      ),
    );
    return Semantics(
      button: true,
      child: Material(
        color: colors.surface,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(20, 16, 20, 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: ChatAvatar(
                    identity: room.isGroup ? room.id : peer,
                    label: peer,
                    group: room.isGroup,
                    online: online,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final stacked =
                          constraints.maxWidth < 180 ||
                          MediaQuery.textScalerOf(context).scale(14) > 22;
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: Text(
                                  name,
                                  maxLines: stacked ? 2 : 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.titleMedium?.copyWith(
                                    fontWeight: unread
                                        ? FontWeight.w800
                                        : FontWeight.w600,
                                    height: 1.25,
                                  ),
                                ),
                              ),
                              if (!stacked) ...[
                                const SizedBox(width: 12),
                                ConstrainedBox(
                                  constraints: BoxConstraints(
                                    maxWidth: constraints.maxWidth * .42,
                                  ),
                                  child: time,
                                ),
                              ],
                            ],
                          ),
                          const SizedBox(height: 5),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (pending != null) ...[
                                Padding(
                                  padding: const EdgeInsets.only(top: 2),
                                  child: Icon(
                                    failed
                                        ? Icons.error_outline_rounded
                                        : Icons.schedule_rounded,
                                    size: 16,
                                    color: failed
                                        ? colors.error
                                        : colors.onSurfaceVariant,
                                  ),
                                ),
                                const SizedBox(width: 5),
                              ],
                              Expanded(
                                child: Text(
                                  preview,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    height: 1.4,
                                    color: failed
                                        ? colors.error
                                        : unread
                                        ? colors.onSurface
                                        : colors.onSurfaceVariant,
                                  ),
                                ),
                              ),
                              if (unread) ...[
                                const SizedBox(width: 10),
                                Semantics(
                                  label: '${room.unreadCount} unread messages',
                                  child: ExcludeSemantics(
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 3,
                                      ),
                                      decoration: BoxDecoration(
                                        color: colors.primary,
                                        borderRadius: BorderRadius.circular(20),
                                      ),
                                      child: Text(
                                        room.unreadCount > 99
                                            ? '99+'
                                            : '${room.unreadCount}',
                                        style: theme.textTheme.labelSmall
                                            ?.copyWith(
                                              color: colors.onPrimary,
                                              fontWeight: FontWeight.w700,
                                            ),
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            ],
                          ),
                          const SizedBox(height: 5),
                          Text(
                            presence,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                          if (stacked) ...[const SizedBox(height: 4), time],
                        ],
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ChatEmptyState extends StatelessWidget {
  const ChatEmptyState({
    super.key,
    required this.title,
    required this.description,
    this.icon = Icons.forum_outlined,
  });
  final String title, description;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 48),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: theme.colorScheme.primaryContainer,
              borderRadius: BorderRadius.circular(30),
            ),
            child: Icon(
              icon,
              size: 40,
              color: theme.colorScheme.onPrimaryContainer,
            ),
          ),
          const SizedBox(height: 24),
          Text(
            title,
            textAlign: TextAlign.center,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            description,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }
}
