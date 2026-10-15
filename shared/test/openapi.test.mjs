import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const specification = JSON.parse(
  await readFile(
    new URL("../../contracts/openapi.yaml", import.meta.url),
    "utf8",
  ),
);
const safeSequence = {
  type: "integer",
  format: "int64",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};

test("strict append response schema describes every actual response field", () => {
  const schema =
    specification.paths["/internal/v1/users/{userId}/events"].post
      .responses[200].content["application/json"].schema;
  const response = {
    datasetId: "90000000-0000-4000-8000-000000000001",
    userId: "2",
    acceptedSeq: 7,
    epoch: "91000000-0000-4000-8000-000000000001",
    duplicate: true,
    headSeq: 9,
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    Object.keys(response).sort(),
  );
  assert.deepEqual([...schema.required].sort(), Object.keys(response).sort());
  assert.deepEqual(schema.properties.headSeq, safeSequence);
  assert.deepEqual(schema.properties.acceptedSeq, safeSequence);
});

test("strict error schema allows canonical SEQ_GAP details without requiring details elsewhere", () => {
  const schema = specification.components.schemas.Error;
  const error = schema.properties.error;
  assert.equal(schema.additionalProperties, false);
  assert.equal(error.additionalProperties, false);
  assert.deepEqual([...error.required].sort(), [
    "code",
    "message",
    "retryable",
  ]);
  const response = {
    code: "SEQ_GAP",
    message: "Next contiguous event required.",
    retryable: false,
    details: { expectedSeq: 8 },
  };
  assert.deepEqual(
    Object.keys(error.properties).sort(),
    Object.keys(response).sort(),
  );
  assert.equal(error.properties.details.additionalProperties, false);
  assert.deepEqual(error.properties.details.required, ["expectedSeq"]);
  assert.deepEqual(error.properties.details.properties.expectedSeq, {
    ...safeSequence,
    minimum: 1,
  });
});

test("message schema distinguishes explicit blankness, decoded text limits and JSON transport cap", () => {
  const operation = specification.paths["/api/v1/rooms/{roomId}/messages"].post;
  const schema =
    operation.requestBody.content["application/json"].schema.properties.text;
  const pattern = new RegExp(schema.pattern, "u");
  for (const blank of ["", "\u0085", "\ufeff", " \t\u0085\ufeff\n"])
    assert.equal(pattern.test(blank), false);
  for (const text of ["\u0085hello\ufeff", "\u200b", "😀".repeat(2000)])
    assert.equal(pattern.test(text), true);
  assert.equal(schema.maxLength, 2000);
  assert.match(schema.description, /8192 decoded UTF-8 bytes/);
  assert.match(operation.description, /32,768 UTF-8 bytes/);
  assert.deepEqual(
    operation.responses[413].content["application/json"].schema,
    {
      $ref: "#/components/schemas/Error",
    },
  );
  assert.match(operation.responses[413].description, /32768 UTF-8 bytes/);
});

test("v2 API defines snapshot fencing, personalized state and bounded message reconciliation", () => {
  const schemas = specification.components.schemas;
  for (const key of ["revision", "unreadCount", "lastReadSeq"])
    assert.ok(schemas.Room.required.includes(key));
  assert.equal(
    specification.paths["/api/v1/rooms"].get.parameters.find(
      (p) => p.name === "limit",
    ).schema.default,
    20,
  );
  assert.equal(
    specification.paths["/api/v1/rooms/{roomId}/messages"].get.parameters.find(
      (p) => p.name === "limit",
    ).schema.default,
    30,
  );
  assert.ok(
    specification.paths[
      "/api/v1/rooms/{roomId}/messages"
    ].get.responses[200].content["application/json"].schema.required.includes(
      "window",
    ),
  );
  assert.ok(
    specification.paths["/api/v1/rooms/{roomId}/read"].post.security.length,
  );
  assert.equal(schemas.RoomUpdate.properties.type.const, "room.upserted");
  assert.equal(schemas.RoomUpdate.properties.streamSeq, undefined);
  assert.equal(
    schemas.RoomUpdate.properties.data.properties.message,
    undefined,
  );
});
