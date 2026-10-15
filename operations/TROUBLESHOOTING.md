# Troubleshooting by symptom

> Current protocol: [Room sync v2](../contracts/ROOM_SYNC_V2.md). Outbox, immutable message-event replay and indefinite retention instructions below belong to the original v1 plan. Use the root README migration/run commands and v2 verification status; no Redis is used.

| Symptom | Check in order |
|---|---|
| Account picker cannot connect | Correct platform API URL; host binding; same LAN/firewall; API health; debug network policy |
| Mongo transaction error | Replica set initialized/PRIMARY; URI points to it; host can resolve advertised member; every operation uses same session |
| Worker deploy rejects class config | Installed Wrangler versus documented exports syntax; SQLite storage declaration; named-environment binding; no mixed migration flow |
| Cloudflare credentials appear ignored | Setup helper actually parsed nestjs/.env; correct allowlisted child-process env; runtime integration does not use the management token |
| WebSocket 401/1008 | Fresh ticket; same WS_TICKET_SECRET; issuer/audience/algorithm; clocks; dataset/user/device validation |
| Socket closes after about a minute | Distinguish 60-second upgrade ticket expiry from the 24-hour socket session expiry; check ping/pong and ACK deadlines |
| Socket connects but no messages | Hello/resume completed; correct user object; remote head versus local cursor; outbox backlog; valid watch/event parser separation |
| Message saved but peer never receives | Recipient journal includes peer; ordered dispatcher not blocked on earlier seq; Worker append accepted; peer's device-specific ACK/pump |
| Two identical bubbles | Local sender/client ID uniqueness; common REST/event merge path; outgoing echo reconciliation |
| Reconnect skips messages | Cursor advanced before SQLite commit, from REST, or from another device's max ACK; inspect applied-event continuity |
| Reconnect loops forever after cache loss | Client must resume zero even if server diagnostic max_ack_seq is higher; don't restore cursor from server |
| Cursor greater than remote head | Dataset mismatch or missing DO log; keep local cursor; run non-destructive journal-head repair |
| Chat preview moves backward | Room-version merge guard missing on REST/history/event paths |
| User shown offline after one device disconnects | Count distinct qualifying remaining devices; delayed old-close callback must not clear replacement connection |
| Peer stays online after Wi-Fi disappears | Lease timestamp from auto-response; sweep alarm scheduling; observer snapshot freshness; allow documented detection delay |
| Everyone offline when observer disconnects | Wrong semantics: observer unavailable should display unknown |
| Presence notifications cycle | Target local-status methods or incoming notification handlers are recursively fanning out; remove that cycle |
| Idle DO never reinitializes | Standard ws.accept instead of Hibernation API, permanent interval, unresolved I/O/promise, or continuous test traffic |
| Account B briefly shows A's data | Shared DB/cursor or late async generation callback; isolate account repositories and navigation |
| Pending queue lost on restart | Not persisted before clearing input, startup migration reset data, or sending rows not requeued |
| Native package build fails despite text-only UI | Required widget package's transitive native dependencies still need compatible build tooling; verify resolved platform requirements |
| Free-tier writes fail | Detailed dashboard quotas and storage use; pause demo traffic; preserve data; don't silently upgrade |

## Diagnostics to collect

Task/test ID, actual runtime versions, datasetId, userId/deviceId, connectionId, requestId, clientMessageId/messageId/eventId, streamSeq/roomSeq, local cursor, remote/Mongo heads, close code, and redacted error code. Never attach .env files, raw tickets, bearer headers, or full chat content to logs by default.

## Honest result classification

`Implemented` means code exists. `Locally verified` means the recorded local test ran. `Real-cloud verified` means the actual development Worker was exercised. `Mobile verified` names the real simulator/device and OS. Missing credentials, unavailable Xcode, unobserved hibernation, and quota failures must be recorded as limitations, not converted to passed tests.
