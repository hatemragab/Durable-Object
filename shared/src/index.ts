/** Protocol v2. Keep contracts/ and the Dart fixture consumers in sync. */
export const USER_IDS = ["1", "2", "3"] as const;
export type UserId = (typeof USER_IDS)[number];
export const DEFAULTS = Object.freeze({
  protocolVersion: 2,
  maxBatchEvents: 50,
  maxBatchBytes: 65_536,
  maxEventBytes: 32_768,
  maxControlBytes: 4_096,
  historyPageSize: 30,
  roomsPageSize: 20,
  eventRetentionMs: 48 * 60 * 60 * 1000,
  maxDeltaGap: 1_000,
  maxHistoryPageSize: 100,
  maxRoomsPerUser: 100,
  maxEventsPerUser: 10_000,
  maxPendingMessages: 1_000,
  maxTextScalars: 2_000,
  maxTextBytes: 8_192,
  maxTitleScalars: 80,
  resumeTimeoutMs: 10_000,
  heartbeatIntervalMs: 20_000,
  heartbeatTimeoutMs: 10_000,
  livenessLeaseMs: 70_000,
  presenceRefreshMs: 30_000,
  presenceFreshnessMs: 60_000,
  presenceSweepMs: 30_000,
  ackTimeoutMs: 15_000,
  maxBatchRetransmissions: 3,
  reconnectBaseMs: 1_000,
  reconnectCapMs: 30_000,
  stableConnectionMs: 30_000,
  projectionPollMs: 1_000,
  // Dirty projections are still relayed every second; this is only the idle
  // remote epoch/head repair check. Startup and explicit repair bypass it.
  reconcileIntervalMs: 300_000,
  workerTimeoutMs: 10_000,
  sessionValiditySeconds: 86_400,
  ticketValiditySeconds: 60,
  clockSkewSeconds: 5,
});
export interface UserSummary {
  id: UserId;
  name: string;
}
export interface MessageDto {
  id: string;
  roomId: string;
  senderId: UserId;
  originDeviceId: string;
  clientMessageId: string;
  roomSeq: number;
  type: "text";
  text: string;
  createdAt: string;
}
export interface LastMessageDto {
  messageId: string;
  senderId: UserId;
  text: string;
  roomSeq: number;
  createdAt: string;
}
export interface RoomDto {
  id: string;
  type: "direct" | "group";
  title: string | null;
  memberIds: UserId[];
  createdBy: UserId;
  createdAt: string;
  updatedAt: string;
  version: number;
  lastMessageSeq: number;
  lastMessage: LastMessageDto | null;
  /** Per-user room state revision; changes for unread state independently of version. */
  revision: number;
  unreadCount: number;
  lastReadSeq: number;
}
export interface PresenceDto {
  userId: UserId;
  state: "online" | "offline" | "unknown";
  activeDeviceCount: number | null;
  connectionCount: number | null;
  revision: number | null;
  observedAt: string | null;
}
/** Current authoritative user-room projection sent to Cloudflare, never journaled in MongoDB. */
export interface RoomUpdate {
  v: 2;
  datasetId: string;
  userId: UserId;
  type: "room.upserted";
  data: { room: RoomDto };
}
export type EventEnvelope = RoomUpdate & { streamSeq: number };
/** Coverage is inclusive fromSeq..toSeq, while retained room rows may be sparse. */
export interface EventBatch {
  v: 2;
  type: "events.batch";
  epoch: string;
  batchId: string;
  fromSeq: number;
  toSeq: number;
  events: EventEnvelope[];
}
export interface SyncCursor {
  epoch: string;
  throughSeq: number;
  syncedAt: string;
}
export interface RoomsPage {
  datasetId: string;
  rooms: RoomDto[];
  nextCursor: string | null;
  sync: SyncCursor;
}
export class ContractError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}
export function assertContract(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new ContractError(message);
}
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
export function parseUserId(value: unknown): UserId {
  assertContract(
    typeof value === "string" && USER_IDS.includes(value as UserId),
    "Unknown user ID.",
  );
  return value as UserId;
}
export function safeInteger(value: unknown, min = 0): number {
  assertContract(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min,
    "Invalid sequence or integer.",
  );
  return value;
}
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function validScalars(value: string): boolean {
  // Reject unpaired UTF-16 surrogates: they are not Unicode scalar values.
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
}
function isContractWhitespace(unit: number): boolean {
  return (
    (unit >= 0x0009 && unit <= 0x000d) ||
    unit === 0x0020 ||
    unit === 0x0085 ||
    unit === 0x00a0 ||
    unit === 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) ||
    unit === 0x2028 ||
    unit === 0x2029 ||
    unit === 0x202f ||
    unit === 0x205f ||
    unit === 0x3000 ||
    unit === 0xfeff
  );
}
/** Explicit wire semantics, mirrored in Dart; native trim sets may differ. */
export function trimContractWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isContractWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isContractWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}
export function validateText(value: unknown): string {
  assertContract(
    typeof value === "string" && trimContractWhitespace(value).length > 0,
    "Text must be nonblank.",
  );
  assertContract(
    validScalars(value) &&
      [...value].length <= DEFAULTS.maxTextScalars &&
      utf8Bytes(value) <= DEFAULTS.maxTextBytes,
    "Text exceeds Unicode or byte limits.",
  );
  return value;
}
export function normalizeTitle(value: unknown): string {
  assertContract(typeof value === "string", "Title must be a string.");
  const title = trimContractWhitespace(value);
  assertContract(
    title.length > 0 &&
      validScalars(title) &&
      [...title].length <= DEFAULTS.maxTitleScalars,
    "Invalid group title.",
  );
  return title;
}
export function object(value: unknown): Record<string, unknown> {
  assertContract(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected a JSON object.",
  );
  return value as Record<string, unknown>;
}
export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  assertContract(
    Object.keys(value).every((key) => keys.includes(key)),
    "Unknown object field.",
  );
}
function uuid(value: unknown): string {
  assertContract(isUuid(value), "Invalid UUID.");
  return value;
}
function timestamp(value: unknown): string {
  assertContract(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "Invalid UTC timestamp.",
  );
  return value;
}
export function parseMessage(value: unknown): MessageDto {
  const m = object(value);
  uuid(m.id);
  uuid(m.roomId);
  parseUserId(m.senderId);
  uuid(m.originDeviceId);
  uuid(m.clientMessageId);
  safeInteger(m.roomSeq, 1);
  assertContract(m.type === "text", "Unsupported message type.");
  validateText(m.text);
  timestamp(m.createdAt);
  return m as unknown as MessageDto;
}
export function parseRoom(value: unknown): RoomDto {
  const r = object(value);
  uuid(r.id);
  assertContract(
    r.type === "direct" || r.type === "group",
    "Invalid room type.",
  );
  assertContract(
    Array.isArray(r.memberIds) &&
      r.memberIds.length >= 2 &&
      r.memberIds.length <= 3,
    "Invalid room members.",
  );
  const members = r.memberIds.map(parseUserId);
  assertContract(
    new Set(members).size === members.length &&
      [...members].sort().join(",") === members.join(","),
    "Members must be sorted and distinct.",
  );
  assertContract(
    members.includes(parseUserId(r.createdBy)),
    "Creator must be a member.",
  );
  if (r.type === "direct")
    assertContract(
      members.length === 2 && r.title === null,
      "Invalid direct room.",
    );
  else
    assertContract(
      normalizeTitle(r.title) === r.title,
      "Group title must be normalized.",
    );
  timestamp(r.createdAt);
  timestamp(r.updatedAt);
  safeInteger(r.version, 1);
  safeInteger(r.lastMessageSeq);
  safeInteger(r.revision, 1);
  safeInteger(r.unreadCount);
  safeInteger(r.lastReadSeq);
  assertContract(
    safeInteger(r.lastReadSeq) <= safeInteger(r.lastMessageSeq),
    "Read cursor exceeds room head.",
  );
  assertContract(
    safeInteger(r.unreadCount) <=
      safeInteger(r.lastMessageSeq) - safeInteger(r.lastReadSeq),
    "Unread count exceeds unread range.",
  );
  if (r.lastMessageSeq === 0)
    assertContract(
      r.lastMessage === null,
      "Empty room cannot have last message.",
    );
  else {
    const last = object(r.lastMessage);
    uuid(last.messageId);
    assertContract(
      members.includes(parseUserId(last.senderId)),
      "Last sender must be a member.",
    );
    validateText(last.text);
    safeInteger(last.roomSeq, 1);
    timestamp(last.createdAt);
    assertContract(
      last.roomSeq === r.lastMessageSeq,
      "Last-message sequence mismatch.",
    );
  }
  return r as unknown as RoomDto;
}
export function parsePresence(value: unknown): PresenceDto {
  const p = object(value);
  parseUserId(p.userId);
  assertContract(
    ["online", "offline", "unknown"].includes(String(p.state)),
    "Invalid presence state.",
  );
  if (p.state === "unknown") {
    for (const key of [
      "activeDeviceCount",
      "connectionCount",
      "revision",
      "observedAt",
    ])
      assertContract(
        p[key] === null,
        "Unknown presence must have null observations.",
      );
  } else {
    const devices = safeInteger(p.activeDeviceCount),
      connections = safeInteger(p.connectionCount);
    safeInteger(p.revision);
    timestamp(p.observedAt);
    assertContract(
      p.state === "online"
        ? devices > 0 && connections >= devices
        : devices === 0 && connections === 0,
      "Presence counts contradict state.",
    );
  }
  return p as unknown as PresenceDto;
}
export function parseRoomUpdate(value: unknown): RoomUpdate {
  const e = object(value);
  exactKeys(e, ["v", "datasetId", "userId", "type", "data", "streamSeq"]);
  assertContract(e.v === 2, "Unsupported protocol version.");
  uuid(e.datasetId);
  parseUserId(e.userId);
  assertContract(e.type === "room.upserted", "Unsupported durable event type.");
  const data = object(e.data);
  exactKeys(data, ["room"]);
  const room = parseRoom(data.room);
  assertContract(
    room.memberIds.includes(e.userId as UserId),
    "Event recipient is not a room member.",
  );
  assertContract(
    utf8Bytes(JSON.stringify(e)) <= DEFAULTS.maxEventBytes,
    "Durable event too large.",
  );
  return e as unknown as RoomUpdate;
}
export function parseEvent(value: unknown): EventEnvelope {
  const e = object(value);
  parseRoomUpdate(e);
  safeInteger(e.streamSeq, 1);
  return e as unknown as EventEnvelope;
}
export function parseBatch(value: unknown): EventBatch {
  const b = object(value);
  exactKeys(b, ["v", "type", "epoch", "batchId", "fromSeq", "toSeq", "events"]);
  assertContract(
    b.v === 2 && b.type === "events.batch",
    "Invalid batch frame.",
  );
  uuid(b.batchId);
  uuid(b.epoch);
  const from = safeInteger(b.fromSeq, 1),
    to = safeInteger(b.toSeq, 1);
  assertContract(
    to >= from &&
      Array.isArray(b.events) &&
      b.events.length <= DEFAULTS.maxBatchEvents,
    "Invalid event batch range.",
  );
  const events = b.events.map(parseEvent);
  const roomIds = new Set<string>();
  let prior = from - 1;
  for (const event of events) {
    assertContract(
      event.streamSeq > prior &&
        event.streamSeq <= to &&
        event.datasetId === events[0].datasetId &&
        event.userId === events[0].userId &&
        !roomIds.has(event.data.room.id),
      "Unordered, duplicate-room or mixed-identity batch.",
    );
    prior = event.streamSeq;
    roomIds.add(event.data.room.id);
  }
  assertContract(
    utf8Bytes(JSON.stringify(b)) <= DEFAULTS.maxBatchBytes,
    "Event batch too large.",
  );
  return b as unknown as EventBatch;
}
export function unknownPresence(userId: UserId): PresenceDto {
  return {
    userId,
    state: "unknown",
    activeDeviceCount: null,
    connectionCount: null,
    revision: null,
    observedAt: null,
  };
}
