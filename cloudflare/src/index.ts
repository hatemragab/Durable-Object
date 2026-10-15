import {
  ContractError,
  isUuid,
  parseUserId,
  unknownPresence,
} from "@chat-poc/contracts";
import { verifyInternal, verifyTicket } from "./auth";
import { AppError, errorResponse, LIMITS, objectName, type Env } from "./env";
export { UserRealtime } from "./user-realtime";

async function readBody(request: Request, maxBytes: number): Promise<string> {
  if (!request.body)
    throw new AppError("VALIDATION_ERROR", "JSON body required.");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      count += result.value.byteLength;
      if (count > maxBytes) {
        await reader.cancel();
        throw new AppError(
          "VALIDATION_ERROR",
          "Request exceeds byte limit.",
          413,
        );
      }
      parts.push(result.value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new AppError(
        "VALIDATION_ERROR",
        "Body must contain valid UTF-8 JSON.",
      );
    }
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (env.APP_ENV !== "development" || !isUuid(env.DATASET_ID))
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          "Development configuration required.",
          503,
        );
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({
          service: "chat-poc-realtime",
          protocolVersion: 2,
          development: true,
        });
      if (
        !env.WS_TICKET_SECRET ||
        env.WS_TICKET_SECRET.length < 32 ||
        !env.REALTIME_INTERNAL_SECRET ||
        env.REALTIME_INTERNAL_SECRET.length < 32 ||
        env.WS_TICKET_SECRET === env.REALTIME_INTERNAL_SECRET
      )
        throw new AppError(
          "DEPENDENCY_UNAVAILABLE",
          "Realtime secrets are not configured.",
          503,
        );
      if (request.method === "GET" && url.pathname === "/v1/ws") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return new Response(null, { status: 426 });
        const ticket = url.searchParams.get("ticket");
        if (!ticket || ticket.length > 4_096)
          throw new AppError("UNAUTHORIZED", "Upgrade ticket required.", 401);
        const identity = await verifyTicket(ticket, env);
        const headers = new Headers({
          upgrade: "websocket",
          "x-poc-user": identity.userId,
          "x-poc-device": identity.deviceId,
          "x-poc-dataset": identity.datasetId,
          "x-poc-expiry": String(identity.sessionExpiresAt),
        });
        return env.USER_REALTIME.getByName(
          objectName(env.DATASET_ID, identity.userId),
        ).fetch(new Request("https://user/ws", { headers }));
      }
      if (!url.pathname.startsWith("/internal/v1/"))
        return new Response(null, { status: 404 });
      await verifyInternal(request, env);
      const match = /^\/internal\/v1\/users\/([123])\/(events|stream)$/.exec(
        url.pathname,
      );
      if (match) {
        const userId = parseUserId(match[1]);
        const stub = env.USER_REALTIME.getByName(
          objectName(env.DATASET_ID, userId),
        );
        if (request.method === "POST" && match[2] === "events") {
          if (
            !request.headers
              .get("content-type")
              ?.toLowerCase()
              .startsWith("application/json")
          )
            throw new AppError(
              "VALIDATION_ERROR",
              "application/json required.",
            );
          const result = await stub.append(
            await readBody(request, LIMITS.eventBytes),
            userId,
          );
          return result.ok
            ? Response.json(result.value)
            : Response.json(
                { error: result.error, requestId: crypto.randomUUID() },
                { status: result.status },
              );
        }
        if (request.method === "GET" && match[2] === "stream") {
          const result = await stub.inspect(userId);
          return result.ok
            ? Response.json(result.value)
            : Response.json(
                { error: result.error, requestId: crypto.randomUUID() },
                { status: result.status },
              );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/v1/presence/query"
      ) {
        const value = JSON.parse(
          await readBody(request, LIMITS.controlBytes),
        ) as { userIds?: unknown };
        if (
          !value ||
          Object.keys(value).some((key) => key !== "userIds") ||
          !Array.isArray(value.userIds) ||
          value.userIds.length < 1 ||
          value.userIds.length > 3 ||
          new Set(value.userIds).size !== value.userIds.length
        )
          throw new AppError(
            "VALIDATION_ERROR",
            "One to three distinct user IDs required.",
          );
        const ids = value.userIds.map(parseUserId);
        const items = await Promise.all(
          ids.map(async (userId) => {
            try {
              return await env.USER_REALTIME.getByName(
                objectName(env.DATASET_ID, userId),
              ).localPresence(userId);
            } catch {
              return unknownPresence(userId);
            }
          }),
        );
        return Response.json({ datasetId: env.DATASET_ID, items });
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      return errorResponse(
        error instanceof ContractError || error instanceof SyntaxError
          ? new AppError(
              "VALIDATION_ERROR",
              "Invalid request body or identity.",
            )
          : error,
      );
    }
  },
} satisfies ExportedHandler<Env>;
