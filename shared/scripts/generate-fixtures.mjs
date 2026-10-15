import { mkdir, writeFile } from "node:fs/promises";
const directory = new URL("../fixtures/", import.meta.url);
await mkdir(directory, { recursive: true });
const id = (prefix, n) =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const datasetId = id("9", 1),
  deviceId = id("6", 1),
  createdAt = "2026-10-15T00:00:00.000Z";
const direct = {
  id: id("2", 1),
  type: "direct",
  title: null,
  memberIds: ["1", "2"],
  createdBy: "1",
  createdAt,
  updatedAt: createdAt,
  version: 1,
  lastMessageSeq: 0,
  lastMessage: null,
};
const group = {
  ...direct,
  id: id("2", 2),
  type: "group",
  title: "Demo group",
  memberIds: ["1", "2", "3"],
};
const envelope = (streamSeq, room, message) => ({
  v: 1,
  datasetId,
  userId: "2",
  eventId: id("5", streamSeq),
  streamSeq,
  type: message ? "message.created" : "room.upserted",
  occurredAt: createdAt,
  data: message ? { room, message } : { room },
});
const createMessage = (room, n, roomSeq, text) => {
  const message = {
    id: id("3", n),
    roomId: room.id,
    senderId: "1",
    originDeviceId: deviceId,
    clientMessageId: id("4", n),
    roomSeq,
    type: "text",
    text,
    createdAt,
  };
  return {
    message,
    room: {
      ...room,
      version: roomSeq + 1,
      lastMessageSeq: roomSeq,
      lastMessage: {
        messageId: message.id,
        senderId: message.senderId,
        text,
        roomSeq,
        createdAt,
      },
    },
  };
};
const d1 = createMessage(direct, 1, 1, "Hello User 2");
const g1 = createMessage(group, 2, 1, "Hello group");
const g2 = createMessage(group, 3, 2, "Second group message");
const g3 = createMessage(group, 4, 3, "Third group message");
const events = [
  envelope(1, direct),
  envelope(2, d1.room, d1.message),
  envelope(3, group),
  envelope(4, g1.room, g1.message),
  envelope(5, g2.room, g2.message),
  envelope(6, g3.room, g3.message),
];
const batch = (list, n) => ({
  v: 1,
  type: "events.batch",
  batchId: id("8", n),
  fromSeq: list[0].streamSeq,
  toSeq: list.at(-1).streamSeq,
  events: list,
});
const conflict = structuredClone(events[1]);
conflict.data.message.text = "Changed text";
conflict.data.room.lastMessage.text = "Changed text";
const whitespaceCodePoints = [
  ...Array.from({ length: 5 }, (_, i) => 0x0009 + i),
  0x0020,
  0x0085,
  0x00a0,
  0x1680,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
];
const allWhitespace = String.fromCodePoint(...whitespaceCodePoints);
const fixtures = {
  "direct-room-created": events[0],
  "direct-message-created": events[1],
  "group-room-created": events[2],
  "group-message-created": events[3],
  "replay-batch-1-4": batch(events.slice(0, 4), 1),
  "duplicate-batch-1-4": batch(events.slice(0, 4), 1),
  "overlapping-batch-3-6": batch(events.slice(2), 2),
  "gap-batch": batch([events[5]], 3),
  "wrong-recipient": { ...events[0], userId: "1" },
  "conflicting-idempotency": conflict,
  "stale-room-rest": { datasetId, room: d1.room },
  "optimistic-confirmation": {
    pending: {
      clientMessageId: d1.message.clientMessageId,
      roomId: direct.id,
      senderId: "1",
      text: d1.message.text,
    },
    event: events[1],
  },
  "unsupported-event": { ...events[0], type: "message.deleted" },
  "unicode-text": { text: "مرحبا World 👋🏽\nA second line." },
  "whitespace-validation": {
    whitespaceCodePoints,
    blankTexts: ["", "\u0085", "\ufeff", allWhitespace],
    preservedTexts: [
      "\u0085مرحبا 😀\ufeff",
      " \t\u0085message\n\ufeff ",
      "\u180e",
      "\u200b",
      "\u2060",
    ],
    titleCases: [
      {
        input: "\u0085\ufeff \tGroup\u0085Inside\u2000\ufeff",
        normalized: "Group\u0085Inside",
      },
      { input: "\ufeffGroup\ufeff", normalized: "Group" },
      { input: `${allWhitespace}Group${allWhitespace}`, normalized: "Group" },
    ],
    nonWhitespaceCodePoints: [0x180e, 0x200b, 0x2060],
  },
  "presence-online-two-devices": {
    userId: "2",
    state: "online",
    activeDeviceCount: 2,
    connectionCount: 2,
    revision: 4,
    observedAt: createdAt,
  },
  "presence-unknown": {
    userId: "3",
    state: "unknown",
    activeDeviceCount: null,
    connectionCount: null,
    revision: null,
    observedAt: null,
  },
  "hello-and-resume": {
    hello: {
      v: 1,
      type: "hello",
      datasetId,
      userId: "2",
      deviceId,
      connectionId: id("7", 1),
      headSeq: 6,
      retainedFromSeq: 1,
      heartbeatIntervalMs: 20000,
      heartbeatTimeoutMs: 10000,
      sessionExpiresAt: "2026-10-16T00:00:00.000Z",
    },
    resume: { v: 1, type: "resume", afterSeq: 4 },
  },
};
for (const [name, value] of Object.entries(fixtures))
  await writeFile(
    new URL(`${name}.json`, directory),
    `${JSON.stringify(value, null, 2)}\n`,
  );
console.log(
  `Wrote ${Object.keys(fixtures).length} deterministic contract fixtures.`,
);
