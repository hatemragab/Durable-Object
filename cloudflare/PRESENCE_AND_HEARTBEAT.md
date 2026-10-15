# Multi-device presence and heartbeat

## Presence definition

Evaluate each current, non-retired, resumed socket for the object. It qualifies only if its transport is open, the 24-hour session authorization has not expired, and its latest application auto-response timestamp is no more than 70 seconds old. Before the first ping, use the valid resume time for that initial lease. Exclude sockets that are closing, awaiting resume, superseded, or lease-expired.

`activeDeviceCount` is the number of distinct qualifying device IDs. `connectionCount` is the number of qualifying sockets. One-current-socket-per-device makes these normally equal. User state is online when activeDeviceCount is positive, otherwise offline. A failed dependency query yields unknown, not offline.

Hibernation may discard in-memory maps while preserving connections, so enumerate the runtime's attached sockets and their attachments. The platform exposes both socket enumeration and the latest auto-response timestamp; a static ping/pong pair can be handled without waking the object for each ping. ([CF-STATE](../SOURCES.md#cf-state))

## Transition handling

Evaluate aggregated presence after valid resume, replacement, close/error, session expiry, and presence sweep. Closing one of two device connections must not produce an offline transition. Persist the current aggregate state and a monotonic presenceRevision when that state changes; capture an observedAt server timestamp with each response.

A source object sends a best-effort `PresenceDto` update through bindings to the other two user objects. Each recipient only forwards it to sockets whose watch set contains that source user. Incoming forwarded updates do not trigger new cross-object fan-out, and do not become durable events.

Use a persisted lastPresenceAttemptRevision to distinguish an unattempted transition from one already broadcast. If an authoritative presence query observes a previously unrecorded lease transition, it may update local metadata and arrange notification work, but it must not synchronously query or notify other objects before returning its own status. The alarm handles pending notification work. A failed notification is repaired by snapshots, not a second durable queue.

## Snapshot reconciliation

After a watch registration and every 30 seconds, the observing object's snapshot handler evaluates its own status locally if requested and calls each other requested object's simple local-status method. No target status method fans out recursively. Return unknown only for failed user queries, without erasing successful results.

The client applies the freshest source observations, rejects obviously older delayed push updates, and treats a new authoritative snapshot as the reconciliation authority. On reconnect clear old live presence revisions and obtain a fresh snapshot; do not replay yesterday's online status from disk. This also prevents a restored object presence counter from permanently suppressing later authoritative snapshots.

All three seeded accounts may observe each other's presence in this test. Do not present this allowlist policy as a production privacy model.

## Timing and mobile lifecycle

A clean close should propagate promptly under normal test conditions. A silent network loss is not instantly observable: with the 70-second lease and roughly 30-second sweep, expect offline detection around or within 100 seconds in an undisturbed test. This is a test target, not an infrastructure SLA; alarms and networks may be delayed. The UI must not claim instantaneous certainty. ([CF-ALARM](../SOURCES.md#cf-alarm))

While the observing app itself lacks a healthy connection, or its latest known presence exceeds the 60-second freshness window, display unknown. The peer is not necessarily offline just because the observer disconnected.

Foreground Flutter sends ping every 20 seconds and refreshes presence every 30 seconds. On paused/hidden/detached lifecycle states, close the current socket best-effort and stop those timers. Resume reconnects and replays. A brief inactive state caused by a permission sheet should not necessarily be treated as a full background transition. No Android/iOS background keepalive or push capability is promised.

## Backend presence API

NestJS calls authenticated Worker `/internal/v1/presence/query`, supplying one to three user IDs. It exposes the mapped response through its authenticated `/api/v1/presence` route. This works even when the target user has no chat screen open; the user object's sessions cover the entire app, not a room subscription.

Do not persist online flags in MongoDB as the authority. Do not skip event delivery because presence says offline, and do not use presence as proof that a message was received/read.

## Cost realism

Auto-pong can avoid per-heartbeat object wakeups, but presence snapshots, peer queries, ACKs, and alarms still consume resources and may wake objects. The design intentionally trades small demo overhead for clear presence behavior. Never describe a connected three-device trial as guaranteed free regardless of other account traffic.
