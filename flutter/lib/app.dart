import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import 'application.dart';
import 'core/models.dart';
import 'core/session.dart';
import 'features/chat/widgets.dart';
import 'features/chat/presentation.dart';

class ChatDemoApp extends ConsumerStatefulWidget {
  const ChatDemoApp({super.key});
  @override
  ConsumerState<ChatDemoApp> createState() => _ChatDemoAppState();
}

class _ChatDemoAppState extends ConsumerState<ChatDemoApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(accountProvider.notifier).foreground(true);
    }
    if ([
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.detached,
    ].contains(state)) {
      ref.read(accountProvider.notifier).foreground(false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final account = ref.watch(accountProvider);
    return MaterialApp(
      title: 'Durable Chat Demo',
      debugShowCheckedModeBanner: false,
      theme: chatTheme(Brightness.light),
      darkTheme: chatTheme(Brightness.dark),
      home: account.session == null
          ? const AccountPicker()
          : Navigator(
              key: ValueKey(account.session),
              onGenerateRoute: (_) =>
                  MaterialPageRoute<void>(builder: (_) => const RoomsPage()),
            ),
    );
  }
}

class AccountPicker extends ConsumerWidget {
  const AccountPicker({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(accountProvider);
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Choose test account')),
      body: ChatWidth(
        maxWidth: 520,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
          children: [
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: Container(
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primary,
                  borderRadius: BorderRadius.circular(24),
                ),
                child: Icon(
                  Icons.forum_rounded,
                  size: 34,
                  color: theme.colorScheme.onPrimary,
                ),
              ),
            ),
            const SizedBox(height: 28),
            Text(
              'Pick up the conversation.',
              style: theme.textTheme.headlineLarge?.copyWith(
                fontWeight: FontWeight.w700,
                letterSpacing: -1,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'Choose a development account to get started. Your cached chats are always close at hand.',
              style: theme.textTheme.bodyLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 32),
            if (state.error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(
                  state.error!,
                  style: TextStyle(color: theme.colorScheme.error),
                ),
              ),
            for (final user in demoUsers)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Card.filled(
                  margin: EdgeInsets.zero,
                  color: theme.colorScheme.surfaceContainerLow,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20),
                    side: BorderSide(color: theme.colorScheme.outlineVariant),
                  ),
                  child: ListTile(
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 10,
                    ),
                    enabled: !state.loading,
                    leading: ChatAvatar(identity: user, label: user, size: 48),
                    title: Text(
                      'User $user',
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    subtitle: const Text('Development account'),
                    trailing: const Icon(Icons.arrow_forward_rounded, size: 20),
                    onTap: () =>
                        ref.read(accountProvider.notifier).select(user),
                  ),
                ),
              ),
            if (state.loading)
              const LinearProgressIndicator(semanticsLabel: 'Opening account'),
            const SizedBox(height: 12),
            Text(
              'Development environment',
              textAlign: TextAlign.center,
              style: theme.textTheme.labelMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ConnectionBanner extends StatelessWidget {
  const ConnectionBanner({super.key, required this.session});
  final AccountSession session;
  @override
  Widget build(BuildContext context) {
    final status = session.state;
    final ready = status == 'live' && session.api.reachable;
    final retry = status == 'blocked' || status == 'retryWaiting';
    final text = switch (status) {
      'live' =>
        session.api.reachable
            ? 'Chats are up to date'
            : 'Live updates connected · API unavailable',
      'replaying' || 'resuming' => 'Syncing your chats…',
      'blocked' => 'Chat sync needs attention',
      'backgroundPaused' => 'Updates paused in background',
      'retryWaiting' => 'Reconnecting · cached chats available',
      _ =>
        session.api.reachable
            ? 'Connecting to live updates…'
            : 'Connecting · API unavailable',
    };
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: ready ? colors.surfaceContainerLow : colors.secondaryContainer,
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 20, vertical: retry ? 0 : 10),
        child: Row(
          children: [
            Icon(
              ready
                  ? Icons.check_circle_outline_rounded
                  : retry
                  ? Icons.cloud_off_outlined
                  : Icons.sync_rounded,
              size: 16,
              color: ready ? colors.primary : colors.onSecondaryContainer,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                text,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: ready
                      ? colors.onSurfaceVariant
                      : colors.onSecondaryContainer,
                ),
              ),
            ),
            if (retry)
              TextButton(
                onPressed: () => session.connect(manual: true),
                child: const Text('Retry'),
              ),
          ],
        ),
      ),
    );
  }
}

String presenceLabel(AccountSession session, Room room) {
  final others = room.members
      .where((id) => id != session.repository.user)
      .toList();
  final states = others.map(session.presenceFor).toList();
  if (!room.isGroup) {
    return switch (states.single) {
      'online' => 'Online',
      'offline' => 'Offline',
      _ => 'Presence updating',
    };
  }
  final online = states.where((value) => value == 'online').length;
  return states.contains('unknown')
      ? '$online online · Presence updating'
      : '$online of ${others.length} others online';
}

class RoomsPage extends ConsumerWidget {
  const RoomsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(accountProvider).session!;
    final rooms = ref.watch(roomsProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Chats'),
        toolbarHeight: (MediaQuery.textScalerOf(context).scale(22) + 16)
            .clamp(56.0, 140.0)
            .toDouble(),
        bottom: PreferredSize(
          preferredSize: Size.fromHeight(
            MediaQuery.textScalerOf(context).scale(14) * 1.5 + 12,
          ),
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(20, 0, 20, 12),
              child: Text(
                'User ${session.repository.user} · Your conversations',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
        ),
        actions: [
          IconButton(
            tooltip: 'Diagnostics',
            icon: const Icon(Icons.info_outline),
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              builder: (_) => const DiagnosticsSheet(),
            ),
          ),
          IconButton(
            tooltip: 'Switch account',
            icon: const Icon(Icons.switch_account_outlined),
            onPressed: () => ref.read(accountProvider.notifier).switchAccount(),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => Navigator.of(context)
            .push(MaterialPageRoute<void>(builder: (_) => const NewChatPage())),
        icon: const Icon(Icons.add),
        label: const Text('New chat'),
      ),
      body: ChatWidth(
        child: Column(
          children: [
            ConnectionBanner(session: session),
            Expanded(
              child: rooms.when(
                loading: () => const Center(
                  child: CircularProgressIndicator(
                    semanticsLabel: 'Loading cached chats',
                  ),
                ),
                error: (_, _) => ListView(
                  children: const [
                    ChatEmptyState(
                      icon: Icons.error_outline_rounded,
                      title: 'Could not read cached chats.',
                      description:
                          'Switch accounts and try opening this account again.',
                    ),
                  ],
                ),
                data: (items) => RefreshIndicator(
                  onRefresh: session.refreshRooms,
                  child: ListView.separated(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.only(top: 8, bottom: 100),
                    itemCount: items.isEmpty ? 1 : items.length + 1,
                    separatorBuilder: (_, _) => const Padding(
                      padding: EdgeInsetsDirectional.only(start: 88, end: 20),
                      child: Divider(height: 1),
                    ),
                    itemBuilder: (context, index) {
                      if (items.isEmpty) {
                        return const ChatEmptyState(
                          title: 'Your next conversation starts here',
                          description: 'Tap New chat to say hello. Pull down any time to refresh your chats.',
                        );
                      }
                      if (index == items.length) {
                        return session.roomsNextCursor == null
                            ? const SizedBox.shrink()
                            : Padding(
                                padding: const EdgeInsets.all(12),
                                child: Center(
                                  child: TextButton.icon(
                                    onPressed: session.loadingRooms
                                        ? null
                                        : session.loadMoreRooms,
                                    icon: const Icon(
                                      Icons.history_rounded,
                                      size: 18,
                                    ),
                                    label: Text(
                                      session.loadingRooms
                                          ? 'Loading…'
                                          : 'Load older chats',
                                    ),
                                  ),
                                ),
                              );
                      }
                      final room = items[index];
                      final others = room.members.where(
                        (id) => id != session.repository.user,
                      );
                      return FutureBuilder<Json?>(
                        key: ValueKey(room.id),
                        future: session.repository.latestPending(room.id),
                        builder: (_, snapshot) => RoomTile(
                          room: room,
                          viewer: session.repository.user,
                          presence: presenceLabel(session, room),
                          online:
                              !room.isGroup &&
                              session.presenceFor(others.single) == 'online',
                          pending: snapshot.data,
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => MessagePage(room: room),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class NewChatPage extends ConsumerStatefulWidget {
  const NewChatPage({super.key});
  @override
  ConsumerState<NewChatPage> createState() => _NewChatPageState();
}

class _NewChatPageState extends ConsumerState<NewChatPage> {
  bool _group = false, _busy = false;
  String? _peer, _error;
  final _members = <String>{};
  final _title = TextEditingController();
  String? _requestId, _intent;
  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    if (_busy) return;
    final session = ref.read(accountProvider).session!;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_group) {
        final title = trimContractWhitespace(_title.text);
        if (title.isEmpty || title.runes.length > 80 || _members.isEmpty) {
          invalid('Choose members and a title of at most 80 characters.');
        }
        final intent = fingerprint({
          'title': title,
          'members': _members.toList()..sort(),
        });
        if (_intent != null && intent != _intent) {
          throw const ChatFailure(
            'PENDING_CREATION',
            'Resolve the existing creation or choose Start new intent before changing it.',
          );
        }
        _intent = intent;
        _requestId ??= const Uuid().v4();
      } else if (_peer == null) {
        invalid('Choose another user.');
      }
      final room = await session.createRoom(
        peer: _group ? null : _peer,
        title: _title.text,
        others: _members.toList(),
        requestId: _requestId,
      );
      if (!mounted || ref.read(accountProvider).session != session) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => MessagePage(room: room)),
      );
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is ChatFailure
              ? error.message
              : 'Room creation failed. Retry the same intent.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(accountProvider).session!;
    return Scaffold(
      appBar: AppBar(title: const Text('New chat')),
      body: ChatWidth(
        maxWidth: 560,
        child: ListView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              'Make a connection',
              style: Theme.of(context).textTheme.headlineSmall
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            Text(
              'Choose who you’d like to talk to.',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, label: Text('Direct')),
                ButtonSegment(value: true, label: Text('Group')),
              ],
              selected: {_group},
              onSelectionChanged: _busy || _intent != null
                  ? null
                  : (value) => setState(() => _group = value.single),
            ),
            const SizedBox(height: 24),
            if (_group)
              TextField(
                controller: _title,
                enabled: !_busy && _intent == null,
                decoration: const InputDecoration(labelText: 'Group title'),
              ),
            const SizedBox(height: 20),
            Text(
              _group ? 'GROUP MEMBERS' : 'START A CONVERSATION WITH',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                letterSpacing: 1,
              ),
            ),
            const SizedBox(height: 12),
            for (final user in demoUsers.where(
              (user) => user != session.repository.user,
            ))
              _group
                  ? CheckboxListTile(
                      secondary: ChatAvatar(
                        identity: user,
                        label: user,
                        size: 44,
                      ),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                      title: Text('User $user'),
                      value: _members.contains(user),
                      onChanged: _busy || _intent != null
                          ? null
                          : (value) => setState(() {
                              if (value!) {
                                _members.add(user);
                              } else {
                                _members.remove(user);
                              }
                            }),
                    )
                  : ListTile(
                      title: Text('User $user'),
                      leading: ChatAvatar(
                        identity: user,
                        label: user,
                        size: 44,
                      ),
                      selected: _peer == user,
                      selectedTileColor: Theme.of(context)
                          .colorScheme
                          .primaryContainer
                          .withValues(alpha: .5),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 10,
                      ),
                      trailing: Icon(
                        _peer == user
                            ? Icons.check_circle_rounded
                            : Icons.circle_outlined,
                      ),
                      onTap: _busy ? null : () => setState(() => _peer = user),
                    ),
            if (!session.api.reachable)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  'The API is unavailable. Use Retry connection before creating a chat.',
                ),
              ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            const SizedBox(height: 28),
            FilledButton(
              onPressed: _busy || !session.api.reachable ? null : _create,
              child: Text(_busy ? 'Creating…' : 'Open chat'),
            ),
            if (_intent != null)
              TextButton(
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _intent = null;
                        _requestId = null;
                        _error = null;
                      }),
                child: const Text('Start new intent'),
              ),
          ],
        ),
      ),
    );
  }
}

class MessagePage extends ConsumerStatefulWidget {
  const MessagePage({super.key, required this.room});
  final Room room;
  @override
  ConsumerState<MessagePage> createState() => _MessagePageState();
}

class _MessagePageState extends ConsumerState<MessagePage> {
  final _scroll = ScrollController();
  int _limit = 30;
  AccountSession? _ownedSession;
  int _historyRevision = 0;
  final Map<int, BuildContext> _messageContexts = {};
  bool _readCheckScheduled = false;
  bool _loading = false, _hasMore = true, _newMessages = false;
  int? _before;
  String? _error, _latest;
  @override
  void initState() {
    super.initState();
    _scroll.addListener(_scheduleReadCheck);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _ownedSession = ref.read(accountProvider).session!;
        _ownedSession!.openRoom(widget.room.id);
        unawaited(_load(initial: true));
      }
    });
  }

  @override
  void dispose() {
    _ownedSession?.closeRoom(widget.room.id);
    _scroll.removeListener(_scheduleReadCheck);
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load({bool initial = false}) async {
    if (_loading || (!initial && !_hasMore)) return;
    final session = ref.read(accountProvider).session!;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await session.history(
        widget.room.id,
        before: initial ? null : _before,
      );
      if (!mounted) return;
      setState(() {
        _hasMore = result['hasMore'] == true;
        _before = result['nextBeforeRoomSeq'] as int?;
        if (!initial) _limit += 30;
      });
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is ChatFailure
              ? error.message
              : 'Could not load older messages.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _scheduleReadCheck() {
    if (_readCheckScheduled) return;
    _readCheckScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _readCheckScheduled = false;
      if (!mounted) return;
      var through = 0;
      _messageContexts.removeWhere((_, context) => !context.mounted);
      for (final entry in _messageContexts.entries) {
        final box = entry.value.findRenderObject();
        final viewport = Scrollable.maybeOf(entry.value)?.context
            .findRenderObject();
        if (box is! RenderBox ||
            viewport is! RenderBox ||
            !box.attached ||
            !box.hasSize ||
            !viewport.hasSize) {
          continue;
        }
        final bounds = box.localToGlobal(Offset.zero) & box.size;
        final visible = viewport.localToGlobal(Offset.zero) & viewport.size;
        if (bounds.overlaps(visible) && entry.key > through) {
          through = entry.key;
        }
      }
      final session = _ownedSession;
      if (session != null && through > 0) {
        unawaited(session.markRead(widget.room.id, through));
      }
    });
  }

  void _bottom() {
    _newMessages = false;
    if (_scroll.hasClients) {
      if (MediaQuery.disableAnimationsOf(context)) {
        _scroll.jumpTo(0);
        return;
      }
      unawaited(
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(accountProvider).session!;
    final latestHistory = session.latestHistory(widget.room.id);
    if (latestHistory != null &&
        latestHistory['revision'] != _historyRevision) {
      _historyRevision = latestHistory['revision'] as int;
      final incomingBefore = latestHistory['nextBeforeRoomSeq'] as int?;
      if (latestHistory['reset'] == true) {
        _limit = 30;
        _before = incomingBefore;
      } else if (incomingBefore != null &&
          (_before == null || incomingBefore < _before!)) {
        _before = incomingBefore;
      }
      _hasMore = latestHistory['hasMore'] == true;
      if (!_hasMore) _before = null;
    }
    final key = (roomId: widget.room.id, limit: _limit);
    final messages = ref.watch(messagesProvider(key));
    ref.listen(messagesProvider(key), (_, next) {
      final rows = next.asData?.value;
      if (rows == null || rows.isEmpty) return;
      _scheduleReadCheck();
      final latest = rows.last['local_key'] as String;
      if (_latest != null && _latest != latest) {
        if (!_scroll.hasClients || _scroll.offset < 100) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) _bottom();
          });
        } else {
          setState(() => _newMessages = true);
        }
      }
      _latest = latest;
    });
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surfaceContainerLow,
      appBar: AppBar(
        toolbarHeight: MediaQuery.textScalerOf(context).scale(14) > 22
            ? 112
            : 76,
        title: Row(
          children: [
            ChatAvatar(
              identity: widget.room.isGroup
                  ? widget.room.id
                  : widget.room.members.firstWhere(
                      (id) => id != session.repository.user,
                    ),
              label: widget.room.members.firstWhere(
                (id) => id != session.repository.user,
              ),
              group: widget.room.isGroup,
              size: 42,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.room.name(session.repository.user),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    presenceLabel(session, widget.room),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      body: ChatWidth(
        child: Column(
          children: [
            ConnectionBanner(session: session),
            if (_error != null)
              Padding(padding: const EdgeInsets.all(8), child: Text(_error!)),
            Expanded(
              child: messages.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (_, _) => const Center(
                  child: Text('Could not read cached messages.'),
                ),
                data: (rows) => TextBubbleScope(
                  child: ListView.builder(
                    key: PageStorageKey((
                      dataset: session.repository.dataset,
                      user: session.repository.user,
                      room: widget.room.id,
                    )),
                    controller: _scroll,
                    reverse: true,
                    padding: const EdgeInsets.only(bottom: 12),
                    itemCount: rows.length + 1,
                    itemBuilder: (context, index) {
                      if (index == rows.length) {
                        return Center(
                          child: _loading
                              ? const Padding(
                                  padding: EdgeInsets.all(12),
                                  child: CircularProgressIndicator(),
                                )
                              : _hasMore
                              ? TextButton(
                                  onPressed: _load,
                                  child: const Text('Load older messages'),
                                )
                              : const Padding(
                                  padding: EdgeInsets.all(12),
                                  child: Text('Beginning of chat'),
                                ),
                        );
                      }
                      final row = rows[rows.length - 1 - index];
                      return Builder(
                        key: ValueKey(row['local_key']),
                        builder: (rowContext) {
                          final seq = row['room_seq'] as int?;
                          if (seq != null) _messageContexts[seq] = rowContext;
                          _scheduleReadCheck();
                          return TextMessageBubble(
                            message: row,
                            user: session.repository.user,
                            group: widget.room.isGroup,
                            onRetry: () async {
                              await session.repository.outgoingState(
                                row['client_message_id'] as String,
                                'queued',
                              );
                              unawaited(session.drain());
                            },
                          );
                        },
                      );
                    },
                  ),
                ),
              ),
            ),
            if (_newMessages)
              TextButton(
                onPressed: () => setState(_bottom),
                child: const Text('New messages ↓'),
              ),
            TextComposer(
              onPersist: (text) async {
                await session.repository.enqueue(widget.room.id, text);
                if (mounted) setState(_bottom);
              },
            ),
          ],
        ),
      ),
    );
  }
}

class DiagnosticsSheet extends ConsumerWidget {
  const DiagnosticsSheet({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(accountProvider).session;
    if (session == null) return const SizedBox.shrink();
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        child: FutureBuilder<List<dynamic>>(
          future: Future.wait([
            session.repository.cursor(),
            session.repository.counts(),
          ]),
          builder: (context, snapshot) {
            final data = snapshot.data;
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Development details',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                SelectableText(
                  'User: ${session.repository.user}\nDevice: ${session.api.device.substring(0, 8)}…\nDataset: ${session.repository.dataset}\nAPI: ${session.api.config.apiBaseUrl}\nAPI status: ${session.api.reachable ? 'reachable' : 'unavailable'}\nSocket: ${session.state}\nCommitted cursor: ${data?[0] ?? '…'}\nRemote head: ${session.remoteHead ?? 'unknown'}\nQueued / failed: ${data?[1] ?? '…'}',
                ),
                if (session.diagnostic != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(session.diagnostic!),
                  ),
                TextButton(
                  onPressed: () => session.connect(manual: true),
                  child: const Text('Retry connection'),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
