# Minimal UI specification

Use a single clear Material theme, readable spacing, and accessible text/icon labels. No branding exercise, animations, mock attachments, or decorative dashboards. The following are functional screens, not a production messenger redesign.

## Account picker

Title: Choose test account. Three large rows: User 1, User 2, User 3. Optional subtitle explains that these are development accounts. Show an API-offline notice without hiding previously cached account access. Selecting an account immediately opens its chat list and initiates the account lifecycle. There is no password input, login button, or registration flow.

## Chat list

App bar shows the selected account and a compact connection-state indicator. Actions: New chat and Switch account. A small connection banner distinguishes connecting, synchronizing, API unavailable, and realtime unavailable without removing cached content.

Each row shows direct peer name or group title, last message preview, time, and a presence affordance. Use distinct dot/icon and text semantics for online, offline, and unknown. Direct chat uses the peer's aggregate state. A group can show `1 of 2 others online`; if an observation is unknown, show `Presence updating` or an explicit partial count rather than a false zero.

Empty state: No chats yet, with the create-chat action. No unread badge is required. Tap opens the room. A diagnostics action may live in a simple overflow menu.

## New chat flow

Offer Direct and Group tabs or a compact selector. Direct: select exactly one of the other users, then open/create. Group: title plus checkboxes for one or both other users; creator is implicitly included. Show a progress state to prevent duplicate taps. Keep a group's clientRequestId across timeout/retry for that intent. Disable room creation while the API is unavailable and explain why.

## Message page

App bar shows room name, direct presence or group online-other count, and back navigation. Main body is a lazily built chronological list with older-page loading at the top, plus a fixed safe-area composer. Preserve scroll position when loading older pages. Auto-scroll on the user's own send and on incoming content only when already near the bottom; otherwise show a small new-messages affordance.

Own text appears on the right; peer text on the left. Group messages display the sender's name. Show timestamps and the local queued/sending/sent/failed state. Avoid duplicate bubbles when the REST response and socket echo arrive in either order. Arabic, English, emoji, and multiline text should render naturally.

## Required package adapters

Use `VBubbleScope` and `VTextBubble` through an app-owned TextMessageBubble adapter. Their documented text and sender/time fields cover this screen. Use a simple existing style and disable unsupported action menus. Do not map domain/database models directly to package internals. ([PKG-BUBBLES](../SOURCES.md#pkg-bubbles))

Map queued/sending to the package's sending visual with an optional Pending label, confirmed server acceptance to sent, and permanent failure to error with a retry affordance. The documented VMessageStatus enum also includes delivered/read, but those must not be used because this POC does not implement those receipts. ([PKG-BUBBLE-STATUS](../SOURCES.md#pkg-bubble-status))

Use `VMessageInputWidget` through a TextComposer adapter and route text submission to local enqueue, not directly to a network call. Disable attachments, camera, voice recording, and the optional emoji panel for the smallest UI; ordinary emoji text remains valid. The official package exposes independent action switches and local submission callbacks. Any required non-text callbacks must remain unreachable and must never upload anything. ([PKG-INPUT](../SOURCES.md#pkg-input))

Build a small widget compile test against the resolved dependency versions before implementing the full page. If native transitive dependencies need build setup, document it; do not request microphone/camera/location permissions for a text-only demo.

## Error behavior

A local SQLite write failure keeps text in the input. A temporary send failure leaves a pending bubble. A permanent send failure shows Failed with retry/diagnostic, not a false sent tick. An unsupported event leaves the app visibly blocked for synchronization, not silently caught up. Switching accounts must instantly remove the previous account's room/message screen from the navigation stack.

## Development details sheet

Show selected user, shortened device ID, dataset ID, API endpoint, API status, socket state, lastAppliedSeq, last known remote head, and queued/failed send counts. Never show raw tokens or secrets. A Retry connection action is acceptable; a destructive reset action must not be hidden behind a casual refresh gesture.
