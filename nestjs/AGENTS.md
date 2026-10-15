# Agent instructions: NestJS

Read root [AGENTS.md](../AGENTS.md), [contracts/DOMAIN_AND_EVENTS.md](../contracts/DOMAIN_AND_EVENTS.md), and all component specifications here.

This is a small local API, not a rewrite of an existing production backend. Seed exactly three string-ID users without resetting their counters on every startup. Use a local MongoDB replica set and real transactions. A message transaction must commit its message, room summary and per-user current membership state together.

Keep no event payloads or event history in MongoDB. room_members is authoritative current state with unread/read positions and dirty/publication metadata. Publish only after transaction commit; recover crashes by rescanning dirty current state. Cloudflare retains compact room-list updates for 48 hours; full sync and HTTP message reconciliation recover larger gaps. One dispatcher per user; one NestJS instance is the approved deployment model.

Do not give the client a Cloudflare management API token, an internal integration secret, or a JWT signing secret. Keep the account-selector API explicitly development-only. An online/offline query must not affect message persistence or fan-out.

Use the API and domain documents as the source of truth for names. Return the same MessageDto and RoomDto from writes, reads, and event envelopes. Tests must prove behavior under retries and crash boundaries, not just happy-path controller responses.
