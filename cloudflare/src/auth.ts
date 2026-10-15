import { jwtVerify } from "jose";
import {
  DEFAULTS,
  isUuid,
  parseUserId,
  type UserId,
} from "@chat-poc/contracts";
import { AppError, type Env } from "./env";

export interface SocketIdentity {
  userId: UserId;
  deviceId: string;
  datasetId: string;
  sessionExpiresAt: number;
}

export async function verifyTicket(
  ticket: string,
  env: Env,
): Promise<SocketIdentity> {
  try {
    const { payload } = await jwtVerify(
      ticket,
      new TextEncoder().encode(env.WS_TICKET_SECRET),
      {
        algorithms: ["HS256"],
        issuer: "chat-poc-nestjs",
        audience: "chat-poc-realtime",
        clockTolerance: DEFAULTS.clockSkewSeconds,
        requiredClaims: [
          "sub",
          "deviceId",
          "datasetId",
          "iat",
          "exp",
          "jti",
          "sessionExp",
        ],
      },
    );
    const userId = parseUserId(payload.sub);
    const now = Math.floor(Date.now() / 1000);
    if (
      !isUuid(payload.deviceId) ||
      !isUuid(payload.jti) ||
      payload.datasetId !== env.DATASET_ID ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.sessionExp) ||
      (payload.iat as number) > now + DEFAULTS.clockSkewSeconds ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) >
        DEFAULTS.ticketValiditySeconds ||
      (payload.sessionExp as number) <= now ||
      (payload.exp as number) > (payload.sessionExp as number)
    )
      throw new Error("Invalid claims");
    return {
      userId,
      deviceId: payload.deviceId as string,
      datasetId: env.DATASET_ID,
      sessionExpiresAt: (payload.sessionExp as number) * 1000,
    };
  } catch {
    throw new AppError(
      "UNAUTHORIZED",
      "Invalid or expired upgrade ticket.",
      401,
    );
  }
}

export async function verifyInternal(
  request: Request,
  env: Env,
): Promise<void> {
  const actual = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.REALTIME_INTERNAL_SECRET}`;
  // Fixed-size digests keep bearer comparison independent of matching prefixes.
  const [left, right] = await Promise.all(
    [actual, expected].map((value) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
  const a = new Uint8Array(left!);
  const b = new Uint8Array(right!);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  if (!env.REALTIME_INTERNAL_SECRET || difference !== 0)
    throw new AppError(
      "UNAUTHORIZED",
      "Integration credentials required.",
      401,
    );
  if (request.headers.get("x-dataset-id") !== env.DATASET_ID)
    throw new AppError("DATASET_MISMATCH", "Dataset does not match.", 409);
}
