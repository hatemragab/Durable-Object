import { Inject, Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify, errors } from "jose";
import { randomUUID } from "node:crypto";
import { DEFAULTS, parseUserId, type UserId } from "@chat-poc/contracts";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ApiError } from "../common/errors.js";
import { uuid } from "../common/validation.js";
import type { Identity } from "../messages/messages.service.js";

@Injectable()
export class SessionService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  async issue(
    userId: UserId,
    deviceId: string,
  ): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000),
      expires = now + DEFAULTS.sessionValiditySeconds;
    const sessionToken = await new SignJWT({
      deviceId,
      datasetId: this.config.datasetId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("chat-poc-nestjs")
      .setAudience("chat-poc-api")
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(expires)
      .setJti(randomUUID())
      .sign(new TextEncoder().encode(this.config.sessionSecret));
    return {
      datasetId: this.config.datasetId,
      user: { id: userId, name: `User ${userId}` },
      deviceId,
      sessionToken,
      expiresAt: new Date(expires * 1000).toISOString(),
      realtimeBaseUrl: this.config.realtimeBaseUrl,
      protocolVersion: DEFAULTS.protocolVersion,
    };
  }
  async verify(authorization: string | undefined): Promise<Identity> {
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization))
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "A valid development session is required.",
      );
    try {
      const { payload } = await jwtVerify(
        authorization.slice(7),
        new TextEncoder().encode(this.config.sessionSecret),
        {
          algorithms: ["HS256"],
          issuer: "chat-poc-nestjs",
          audience: "chat-poc-api",
          requiredClaims: ["sub", "deviceId", "datasetId", "iat", "exp", "jti"],
          clockTolerance: 0,
        },
      );
      if (
        payload.datasetId !== this.config.datasetId ||
        typeof payload.iat !== "number" ||
        payload.iat > Math.floor(Date.now() / 1000) ||
        typeof payload.exp !== "number"
      )
        throw new Error("Invalid session claims");
      uuid(payload.jti, "jti");
      return {
        userId: parseUserId(payload.sub),
        deviceId: uuid(payload.deviceId, "deviceId"),
        sessionExp: payload.exp,
      };
    } catch (error) {
      if (error instanceof errors.JWTExpired)
        throw new ApiError(
          401,
          "SESSION_EXPIRED",
          "The development session has expired.",
        );
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "A valid development session is required.",
      );
    }
  }
  async ticket(identity: Identity): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000);
    if (identity.sessionExp <= now)
      throw new ApiError(
        401,
        "SESSION_EXPIRED",
        "The development session has expired.",
      );
    const expires = Math.min(
      now + DEFAULTS.ticketValiditySeconds,
      identity.sessionExp,
    );
    const ticket = await new SignJWT({
      deviceId: identity.deviceId,
      datasetId: this.config.datasetId,
      sessionExp: identity.sessionExp,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("chat-poc-nestjs")
      .setAudience("chat-poc-realtime")
      .setSubject(identity.userId)
      .setIssuedAt(now)
      .setExpirationTime(expires)
      .setJti(randomUUID())
      .sign(new TextEncoder().encode(this.config.ticketSecret));
    const url = new URL("/v1/ws", this.config.realtimeBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return {
      datasetId: this.config.datasetId,
      url: url.toString(),
      ticket,
      expiresAt: new Date(expires * 1000).toISOString(),
      sessionExpiresAt: new Date(identity.sessionExp * 1000).toISOString(),
    };
  }
}
