import { writeFile } from "node:fs/promises";
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const uuid = { type: "string", format: "uuid" },
  time = { type: "string", format: "date-time" },
  user = { type: "string", enum: ["1", "2", "3"] },
  seq = {
    type: "integer",
    format: "int64",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  };
const object = (
  properties,
  required = Object.keys(properties),
  additionalProperties = false,
) => ({ type: "object", properties, required, additionalProperties });
const list = (items) => ({ type: "array", items });
const whitespaceClass =
  "\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";
const whitespaceDescription =
  "Whitespace is U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.";
const text = {
  type: "string",
  minLength: 1,
  maxLength: 2000,
  pattern: `[^${whitespaceClass}]`,
  description: `Nonblank; at most 2000 Unicode scalar values and 8192 decoded UTF-8 bytes; content preserved exactly. ${whitespaceDescription}`,
};
const schemas = {
  UserSummary: object({ id: user, name: { type: "string" } }),
  Message: object({
    id: uuid,
    roomId: uuid,
    senderId: user,
    originDeviceId: uuid,
    clientMessageId: uuid,
    roomSeq: { ...seq, minimum: 1 },
    type: { const: "text" },
    text,
    createdAt: time,
  }),
  LastMessage: object({
    messageId: uuid,
    senderId: user,
    text,
    roomSeq: { ...seq, minimum: 1 },
    createdAt: time,
  }),
  Room: object({
    id: uuid,
    type: { enum: ["direct", "group"] },
    title: {
      type: ["string", "null"],
      maxLength: 80,
      description: `Group titles are already trimmed with the canonical whitespace class; direct-room title is null. ${whitespaceDescription}`,
    },
    memberIds: { ...list(user), minItems: 2, maxItems: 3, uniqueItems: true },
    createdBy: user,
    createdAt: time,
    updatedAt: time,
    version: { ...seq, minimum: 1 },
    lastMessageSeq: seq,
    lastMessage: { anyOf: [ref("LastMessage"), { type: "null" }] },
  }),
  Presence: object({
    userId: user,
    state: { enum: ["online", "offline", "unknown"] },
    activeDeviceCount: { type: ["integer", "null"], minimum: 0 },
    connectionCount: { type: ["integer", "null"], minimum: 0 },
    revision: { type: ["integer", "null"], minimum: 0 },
    observedAt: { type: ["string", "null"], format: "date-time" },
  }),
  Error: object({
    error: object(
      {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        details: object({ expectedSeq: { ...seq, minimum: 1 } }),
      },
      ["code", "message", "retryable"],
    ),
    requestId: uuid,
  }),
  EventEnvelope: {
    oneOf: ["room.upserted", "message.created"].map((type) =>
      object({
        v: { const: 1 },
        datasetId: uuid,
        userId: user,
        eventId: uuid,
        streamSeq: { ...seq, minimum: 1 },
        type: { const: type },
        occurredAt: time,
        data:
          type === "room.upserted"
            ? object({ room: ref("Room") })
            : object({ room: ref("Room"), message: ref("Message") }),
      }),
    ),
  },
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 503].map((code) => [
    code,
    {
      description: "Canonical error; see contracts/DEFAULTS_AND_ERRORS.md.",
      content: { "application/json": { schema: ref("Error") } },
    },
  ]),
);
const response = (schema, description = "Success") => ({
  description,
  content: { "application/json": { schema } },
});
const scope = (extra) => object({ datasetId: uuid, ...extra });
const body = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});
const roomParam = { name: "roomId", in: "path", required: true, schema: uuid };
function operation(
  id,
  schema,
  {
    request,
    parameters = [],
    publicRoute = false,
    created = false,
    description = "",
    payloadLimitBytes,
  } = {},
) {
  const success = response(schema);
  return {
    operationId: id,
    summary: id.replace(/([a-z])([A-Z])/g, "$1 $2"),
    description,
    security: publicRoute ? [] : [{ session: [] }],
    ...(parameters.length ? { parameters } : {}),
    ...(request ? { requestBody: body(request) } : {}),
    responses: {
      200: success,
      ...(created
        ? {
            201: response(
              schema,
              "Created and committed in MongoDB; this does not claim peer delivery.",
            ),
          }
        : {}),
      ...errors,
      ...(payloadLimitBytes
        ? {
            413: response(
              ref("Error"),
              `JSON request body exceeds ${payloadLimitBytes} UTF-8 bytes; VALIDATION_ERROR, no mutation.`,
            ),
          }
        : {}),
    },
  };
}
const paths = {
  "/api/v1/health": {
    get: operation(
      "getHealth",
      object({
        service: { type: "string" },
        ready: { type: "boolean" },
        development: { const: true },
        protocolVersion: { const: 1 },
      }),
      { publicRoute: true },
    ),
  },
  "/api/v1/dev/users": {
    get: operation(
      "listDevelopmentUsers",
      scope({ users: list(ref("UserSummary")) }),
      { publicRoute: true },
    ),
  },
  "/api/v1/dev/session": {
    post: operation(
      "createDevelopmentSession",
      scope({
        user: ref("UserSummary"),
        deviceId: uuid,
        sessionToken: { type: "string" },
        expiresAt: time,
        realtimeBaseUrl: { type: "string", format: "uri" },
        protocolVersion: { const: 1 },
      }),
      {
        publicRoute: true,
        request: object({ userId: user, deviceId: uuid }),
        description:
          "Development-only account selector; intentionally not real end-user authentication.",
      },
    ),
  },
  "/api/v1/realtime/ticket": {
    post: operation(
      "createRealtimeTicket",
      scope({
        url: { type: "string", format: "uri" },
        ticket: { type: "string" },
        expiresAt: time,
        sessionExpiresAt: time,
      }),
      { request: object({}) },
    ),
  },
  "/api/v1/rooms": {
    get: operation(
      "listRooms",
      scope({ rooms: { ...list(ref("Room")), maxItems: 100 } }),
    ),
  },
  "/api/v1/rooms/direct": {
    post: operation(
      "createDirectRoom",
      scope({ room: ref("Room"), created: { type: "boolean" } }),
      {
        created: true,
        request: object({ peerUserId: user }),
        description: "Unique unordered pair; 201 new or 200 existing.",
      },
    ),
  },
  "/api/v1/rooms/group": {
    post: operation(
      "createGroupRoom",
      scope({ room: ref("Room"), created: { type: "boolean" } }),
      {
        created: true,
        request: object({
          title: {
            type: "string",
            minLength: 1,
            pattern: `[^${whitespaceClass}]`,
            description: `Trimmed once before validation; the normalized title is at most 80 Unicode scalar values. ${whitespaceDescription}`,
          },
          memberUserIds: {
            ...list(user),
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
          },
          clientRequestId: uuid,
        }),
        description:
          "The creator is added by server; reuse clientRequestId on ambiguous retry.",
      },
    ),
  },
  "/api/v1/rooms/{roomId}": {
    get: operation("getRoom", scope({ room: ref("Room") }), {
      parameters: [roomParam],
    }),
  },
  "/api/v1/rooms/{roomId}/messages": {
    get: operation(
      "listRoomMessages",
      scope({
        messages: list(ref("Message")),
        hasMore: { type: "boolean" },
        nextBeforeRoomSeq: { type: ["integer", "null"], minimum: 1 },
      }),
      {
        parameters: [
          roomParam,
          {
            name: "beforeRoomSeq",
            in: "query",
            schema: { ...seq, minimum: 1 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        description:
          "Sequence cursor pagination; selected page returned chronologically. Does not advance replay cursor.",
      },
    ),
    post: operation(
      "createMessage",
      scope({
        message: ref("Message"),
        room: ref("Room"),
        duplicate: { type: "boolean" },
      }),
      {
        created: true,
        parameters: [roomParam],
        request: object({ clientMessageId: uuid, text }),
        payloadLimitBytes: 32_768,
        description:
          "Reuse sender/clientMessageId with exact room/text returns original immutable message. Changed fingerprint is 409. The complete NestJS JSON request body is limited to 32,768 UTF-8 bytes, independently of the decoded text limits. Escaped Unicode JSON is accepted within that transport limit; excess padding is rejected with 413 before mutation.",
      },
    ),
  },
  "/api/v1/presence": {
    get: operation("queryPresence", scope({ items: list(ref("Presence")) }), {
      parameters: [
        {
          name: "userIds",
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^[123](,[123]){0,2}$" },
        },
      ],
    }),
  },
  "/api/v1/dev/diagnostics": {
    get: operation("getDiagnostics", {
      type: "object",
      properties: { datasetId: uuid },
      required: ["datasetId"],
      additionalProperties: true,
    }),
  },
};
const workerServers = [
  {
    url: "https://{worker}.{accountSubdomain}.workers.dev",
    variables: {
      worker: { default: "chat-poc-realtime-development" },
      accountSubdomain: { default: "replace-with-actual-deployment" },
    },
  },
];
const internal = (id, schema, request, parameters = []) => ({
  ...operation(id, schema, {
    request,
    parameters: [
      { name: "X-Dataset-Id", in: "header", required: true, schema: uuid },
      ...parameters,
    ],
  }),
  security: [{ internal: [] }],
});
paths["/health"] = {
  servers: workerServers,
  get: operation(
    "getWorkerHealth",
    { type: "object", additionalProperties: true },
    { publicRoute: true },
  ),
};
paths["/internal/v1/users/{userId}/events"] = {
  servers: workerServers,
  post: internal(
    "appendEvent",
    scope({
      userId: user,
      acceptedSeq: seq,
      headSeq: seq,
      eventId: uuid,
      duplicate: { type: "boolean" },
    }),
    ref("EventEnvelope"),
    [{ name: "userId", in: "path", required: true, schema: user }],
  ),
};
paths["/internal/v1/users/{userId}/stream"] = {
  servers: workerServers,
  get: internal(
    "inspectStream",
    scope({
      userId: user,
      headSeq: seq,
      retainedFromSeq: { const: 1 },
      eventCount: seq,
    }),
    undefined,
    [{ name: "userId", in: "path", required: true, schema: user }],
  ),
};
paths["/internal/v1/presence/query"] = {
  servers: workerServers,
  post: internal(
    "inspectPresence",
    scope({ items: list(ref("Presence")) }),
    object({
      userIds: { ...list(user), minItems: 1, maxItems: 3, uniqueItems: true },
    }),
  ),
};
paths["/v1/ws"] = {
  servers: workerServers,
  get: {
    operationId: "upgradeWebSocket",
    summary: "Ticket-authorized WebSocket upgrade",
    description:
      "Frame protocol is normative in cloudflare/WEBSOCKET_PROTOCOL.md; no message writes are accepted over sockets.",
    security: [{ ticket: [] }],
    responses: {
      101: { description: "Switching protocols; hello then resume required." },
      401: { description: "Invalid upgrade ticket" },
      503: { description: "Worker unavailable" },
    },
  },
};
const spec = {
  openapi: "3.1.0",
  info: {
    title: "Durable chat development POC",
    version: "1.0.0",
    description:
      "Development only. Synthetic three-user chat; canonical Markdown contracts take precedence over abbreviated examples.",
  },
  servers: [{ url: "http://127.0.0.1:3000" }],
  paths,
  components: {
    securitySchemes: {
      session: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      internal: { type: "http", scheme: "bearer" },
      ticket: {
        type: "apiKey",
        in: "query",
        name: "ticket",
        description: "60-second upgrade ticket; redact in logs.",
      },
    },
    schemas,
  },
};
// JSON syntax is a valid self-contained YAML 1.2 document.
await writeFile(
  new URL("../../contracts/openapi.yaml", import.meta.url),
  JSON.stringify(spec, null, 2) + "\n",
);
console.log(
  `Wrote OpenAPI 3.1 document with ${Object.keys(paths).length} paths.`,
);
