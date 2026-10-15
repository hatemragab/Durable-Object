import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseEvent,
  parseBatch,
  parsePresence,
  parseRoomUpdate,
  parseMessage,
  validateText,
  normalizeTitle,
  trimContractWhitespace,
  parseRoom,
  safeInteger,
  DEFAULTS,
} from "../dist/index.js";
const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
test("golden room deltas preserve distinct room and delivery sequence domains", async () => {
  for (const name of [
    "direct-room-created",
    "direct-message-created",
    "group-room-created",
    "group-message-created",
  ])
    parseEvent(await fixture(name));
  const event = await fixture("group-message-created");
  assert.equal(event.streamSeq, 4);
  assert.equal(event.data.room.lastMessageSeq, 1);
  assert.equal(event.type, "room.upserted");
  assert.equal(event.data.message, undefined);
  parseMessage(await fixture("group-message"));
});
test("complete, duplicate, overlapping and gap fixtures have valid wire batches", async () => {
  for (const name of [
    "replay-batch-1-4",
    "duplicate-batch-1-4",
    "overlapping-batch-3-6",
    "gap-batch",
  ])
    parseBatch(await fixture(name));
  const b = await fixture("replay-batch-1-4");
  assert.equal(b.events.length, 2);
  b.events[1].streamSeq = 8;
  assert.throws(() => parseBatch(b), /Unordered/);
});
test("invalid event identity, type, integers and personalized unread state are rejected", async () => {
  const e = await fixture("direct-message-created");
  for (const invalid of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"])
    assert.throws(() => parseEvent({ ...e, streamSeq: invalid }));
  assert.throws(() => parseEvent({ ...e, userId: "3" }), /recipient/);
  assert.throws(() => parseEvent({ ...e, type: "unknown" }), /Unsupported/);
  e.data.room.lastReadSeq = 2;
  assert.throws(() => parseEvent(e), /Read cursor/);
  assert.throws(() => safeInteger(-1));
});
test("batch and event byte/count ceilings apply to serialized wire object", async () => {
  const b = await fixture("replay-batch-1-4");
  b.toSeq = 51;
  b.events = Array(51).fill(b.events[0]);
  assert.throws(() => parseBatch(b));
  const e = await fixture("direct-room-created");
  e.data.room.padding = "x".repeat(DEFAULTS.maxEventBytes);
  assert.throws(() => parseEvent(e), /too large/);
});
test("Unicode text retains exact bytes and whitespace and enforces scalars", async () => {
  const { text } = await fixture("unicode-text");
  assert.equal(validateText(text), text);
  assert.equal(validateText("  x\n "), "  x\n ");
  assert.equal(validateText("😀".repeat(2000)).length, 4000);
  for (const invalid of ["  \n", "x".repeat(2001), "\uD800", "\uDC00"])
    assert.throws(() => validateText(invalid));
  assert.equal(normalizeTitle("  Group  "), "Group");
  assert.throws(() => normalizeTitle("x".repeat(81)));
});
test("presence validates unknown observations and aggregate counts", async () => {
  parsePresence(await fixture("presence-online-two-devices"));
  parsePresence(await fixture("presence-unknown"));
  const unknown = await fixture("presence-unknown");
  assert.throws(() => parsePresence({ ...unknown, activeDeviceCount: 0 }));
});
test("explicit whitespace fixtures reject blank text and preserve message bytes", async () => {
  const cases = await fixture("whitespace-validation");
  for (const point of cases.whitespaceCodePoints) {
    const text = String.fromCodePoint(point);
    assert.equal(trimContractWhitespace(text), "");
    assert.throws(() => validateText(text));
    assert.throws(() => normalizeTitle(text));
  }
  for (const text of cases.blankTexts) {
    assert.throws(() => validateText(text));
    const event = await fixture("direct-message-created");

    event.data.room.lastMessage.text = text;
    assert.throws(() => parseEvent(event));
  }
  for (const text of cases.preservedTexts) {
    assert.equal(validateText(text), text);
    const event = await fixture("direct-message-created");

    event.data.room.lastMessage.text = text;
    assert.equal(parseEvent(event).data.room.lastMessage.text, text);
  }
  for (const point of cases.nonWhitespaceCodePoints) {
    const text = String.fromCodePoint(point);
    assert.equal(trimContractWhitespace(text), text);
    assert.equal(validateText(text), text);
  }
});
test("group titles normalize the explicit whitespace class once, including NEL and BOM", async () => {
  const cases = await fixture("whitespace-validation");
  const room = (await fixture("group-room-created")).data.room;
  for (const { input, normalized } of cases.titleCases) {
    assert.equal(normalizeTitle(input), normalized);
    assert.equal(normalizeTitle(normalized), normalized);
    assert.throws(() => parseRoom({ ...room, title: input }));
    assert.equal(parseRoom({ ...room, title: normalized }).title, normalized);
  }
  assert.equal(normalizeTitle(`\u0085${"x".repeat(80)}\ufeff`), "x".repeat(80));
  assert.throws(() => normalizeTitle("\u0085\ufeff"));
});

test("compaction is sparse coverage, including an empty advancing batch", async () => {
  const batch = await fixture("replay-batch-1-4");
  assert.deepEqual(
    parseBatch(batch).events.map((e) => e.streamSeq),
    [2, 4],
  );
  assert.equal(parseBatch({ ...batch, events: [] }).toSeq, 4);
  assert.throws(() => parseBatch({ ...batch, toSeq: 0 }));
  const duplicate = structuredClone(batch.events[0]);
  duplicate.streamSeq = 3;
  assert.throws(
    () => parseBatch({ ...batch, events: [batch.events[0], duplicate] }),
    /duplicate-room/,
  );
  const update = structuredClone(batch.events[0]);
  delete update.streamSeq;
  parseRoomUpdate(update);
  assert.throws(
    () => parseRoomUpdate({ ...update, data: { ...update.data, message: {} } }),
    /Unknown/,
  );
  assert.throws(() => parseEvent({ ...batch.events[0], v: 1 }), /version/);
});
