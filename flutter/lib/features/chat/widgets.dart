import 'package:flutter/material.dart';
import 'package:v_chat_bubbles/v_chat_bubbles.dart';
import 'package:v_chat_input_ui/v_chat_input_ui.dart';

import '../../core/models.dart';

class TextMessageBubble extends StatelessWidget {
  const TextMessageBubble({
    super.key,
    required this.message,
    required this.user,
    required this.group,
    required this.onRetry,
  });
  final Json message;
  final String user;
  final bool group;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    final own = message['sender_id'] == user;
    final state = message['send_state'] as String;
    final date = DateTime.parse(
      (message['server_created_at'] ?? message['local_created_at']) as String,
    ).toLocal();
    return Column(
      crossAxisAlignment: own
          ? CrossAxisAlignment.end
          : CrossAxisAlignment.start,
      children: [
        VTextBubble(
          messageId: message['local_key'] as String,
          isMeSender: own,
          time: TimeOfDay.fromDateTime(date).format(context),
          text: message['text'] as String,
          senderName: group && !own ? 'User ${message['sender_id']}' : null,
          status: state == 'sent'
              ? VMessageStatus.sent
              : state == 'failed'
              ? VMessageStatus.error
              : VMessageStatus.sending,
        ),
        if (own && state != 'sent')
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: state == 'failed'
                ? TextButton(
                    onPressed: onRetry,
                    child: const Text('Failed · Retry'),
                  )
                : Text(
                    state == 'sending' ? 'Sending' : 'Pending',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
          ),
      ],
    );
  }
}

class TextBubbleScope extends StatelessWidget {
  const TextBubbleScope({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return VBubbleScope(
      theme: VBubbleTheme.custom(
        outgoingBubbleColor: colors.primaryContainer,
        incomingBubbleColor: colors.surface,
        outgoingTextColor: colors.onPrimaryContainer,
        incomingTextColor: colors.onSurface,
        accentColor: colors.primary,
        errorColor: colors.error,
        brightness: Theme.of(context).brightness,
      ),
      config: VBubbleConfig(
        avatar: VAvatarConfig.hidden,
        showTails: false,
        animation: MediaQuery.disableAnimationsOf(context)
            ? VAnimationConfig.none
            : VAnimationConfig.standard,
        gestures: const VGestureConfig(
          enableLongPress: false,
          enableSwipeToReply: false,
        ),
      ),
      menuItemsBuilder: (_, _, _) => const [],
      child: child,
    );
  }
}

class TextComposer extends StatefulWidget {
  const TextComposer({super.key, required this.onPersist});
  final Future<void> Function(String text) onPersist;
  @override
  State<TextComposer> createState() => _TextComposerState();
}

class _TextComposerState extends State<TextComposer> {
  String? _error;
  Future<void> _submit(String text) async {
    try {
      validateText(text);
      await widget.onPersist(text);
      if (mounted) setState(() => _error = null);
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is ChatFailure
              ? error.message
              : 'Could not save this message locally. Your text is retained.',
        );
      }
      rethrow; // The patched composer retains its draft on persistence failure.
    }
  }

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surface,
    child: SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            VMessageInputWidget(
              onSubmitText: _submit,
              onSubmitMedia: (_) {},
              onSubmitFiles: (_) {},
              onSubmitLocation: (_) {},
              onSubmitVoice: (_) {},
              onTypingChange: (_) {},
              enableEmojiPicker: false,
              enableAttachments: false,
              enableCamera: false,
              enableVoiceRecording: false,
              showCameraLauncher: false,
            ),
          ],
        ),
      ),
    ),
  );
}
