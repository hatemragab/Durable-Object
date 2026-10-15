# Current room-state publication and recovery

The old outbox/event journal has been removed. MongoDB keeps permanent messages and authoritative current memberships; Cloudflare keeps only the latest changed room snapshot per user/room for 48 hours. No Redis or message-event replay queue is used.

Each membership has a current revision and dirty/publication markers. Room creation, sends and own-account read changes update them in the same Mongo transaction as their domain data. After commit, one non-overlapping relay per user scans dirty rows, reads each room+membership from a consistent snapshot, and publishes a version-2 `room.upserted` update. Different users progress independently. Relay work is bounded and retries use exponential jitter.

After durable acceptance, a compare-and-set clears dirty only if the membership still has the published revision. A concurrent mutation keeps the newer state dirty. If acceptance or the publication-mark response is lost, retrying the same room revision is duplicate-safe. If several updates accumulated before publication, publishing the latest current state supersedes the intermediate states. This preserves eventual room state without storing individual events in MongoDB.

At startup and periodically the relay inspects the object's epoch/head. A new epoch or observed rollback marks current room states for republishing. Persisted publishedEpoch/publishedSeq metadata allows restart recovery. Same-epoch expiry alone does not mark clean rows dirty or refresh their 48-hour payload TTL. The object may require a client full sync when its cursor is outside the retained window or too far behind.

Full sync captures a Cloudflare epoch/cursor barrier first, then reads Mongo's room page. The client applies the initial page and the earlier barrier in its local SQLite transaction, then resumes after it. Snapshot/delta duplicates merge by personalized room revision. Capturing the barrier afterward would risk skipping a concurrent change. Room-list pages are live keyset pages; later room movements converge through deltas.

No exact historical event stream can be rebuilt after its expiration, and none is needed for the room list. A replaced/restored object must use a new epoch so old client cursors force a full sync; the relay republishes current states. Message screens recover their latest 30 authoritative messages directly from MongoDB through HTTP.

Own-user diagnostics expose Worker epoch/head, pendingRoomCount, redacted blocked status, last successful append and dependency availability. An integrity/dataset conflict blocks that user's relay for operator review; no automatic reset or data deletion is performed.
