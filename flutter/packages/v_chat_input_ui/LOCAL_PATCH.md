# Local patch provenance

Source: official pub.dev v_chat_input_ui 3.4.2 (https://pub.dev/packages/v_chat_input_ui/versions/3.4.2), retrieved through `flutter pub add` on 2026-10-15. Original MIT license retained in LICENSE. Library files were copied without global cache changes.

Only `lib/src/input/message_input_widget.dart` differs: asynchronous text submission is awaited before clearing; failures retain the text; another submit while pending is ignored; an edited/new draft is not cleared by an older completed save. `pubspec.yaml` additionally omits publishing-only screenshot references because their images are not vendored. No dependency/API behavior beyond this callback was intentionally changed. Root application widget tests cover the patch through the real composer button. This fork is needed because upstream exposes a synchronous callback and private text controller.
