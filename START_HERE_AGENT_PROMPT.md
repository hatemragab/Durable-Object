# Handoff prompt for the implementing AI agent

> Protocol v2 supersedes the original immutable-event/outbox/no-retention requirements below. Current approved sync/unread scope and guarantees are in [Room sync v2](contracts/ROOM_SYNC_V2.md). Original milestone/native results are historical, not evidence for v2.

Implement the proof of concept specified in this repository's Markdown documents. Read root AGENTS.md, REQUIREMENTS.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, the canonical contracts, and the AGENTS.md in each component before editing.

Create the actual NestJS, Cloudflare Worker/Durable Object, and Flutter projects in the documented folders. The documents are specifications, not an existing implementation. Work through the milestone tasks and test gates in order, updating a progress report with evidence. Use open-source packages where they reduce work, including Riverpod, sqflite, web_socket_channel, v_chat_bubbles, and v_chat_input_ui. Do not substitute Socket.IO or a full hosted chat SDK.

The approved setup is a local NestJS server and local MongoDB replica set, Android/iOS Flutter development clients with the requested Flutter 3.47+ baseline, and a real development-only Cloudflare Worker on the Free plan with SQLite-backed Durable Objects. The user will provide configuration in nestjs/.env. Build a safe helper that reads that file and maps only the appropriate values to Wrangler and Worker secrets. Do not print secrets or put management credentials in the app.

Implement exactly three seeded accounts with account selection, direct/group room creation, text messages, local cache and persistent send queue, per-device ordered replay and ACKs, heartbeat/reconnect, and aggregated online/offline presence. Respect the retained-journal design, atomic Mongo message/outbox writes, and transactional Flutter cursor updates.

Keep the UI small and functional. No production deployment, paid upgrade, login/registration flow, push notifications, media, typing, receipts, or new business features. Continue through unblocked tasks without asking already-settled product questions. Report genuine environment/credential blockers and continue other work. Never erase existing data as a convenience.

Finish with actual run commands, configuration instructions, automated and manual test results, remaining limitations, and the real test Worker URL only if deployment was completed. Distinguish implemented, locally tested, remotely tested, and not tested. Do not claim success for a test you did not run.
