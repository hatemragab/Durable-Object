import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import type { Connection, Model } from "mongoose";
import { DEFAULTS, parseUserId } from "@chat-poc/contracts";
import type { Response } from "express";
import { APP_CONFIG, type AppConfig } from "./config/config.js";
import { USER, type UserRecord } from "./database/schemas.js";
import { body, integer, userIds, uuid } from "./common/validation.js";
import { invalid, unavailable } from "./common/errors.js";
import { SessionService } from "./dev-session/session.service.js";
import {
  SessionGuard,
  type AuthenticatedRequest,
} from "./dev-session/session.guard.js";
import { RoomsService } from "./rooms/rooms.service.js";
import { MessagesService } from "./messages/messages.service.js";
import { RealtimeClient } from "./realtime/realtime.client.js";
import { RoomProjectionDispatcher } from "./room-sync/dispatcher.service.js";

@Controller()
export class AppController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(USER) private readonly users: Model<UserRecord>,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeClient) private readonly realtime: RealtimeClient,
    @Inject(RoomProjectionDispatcher)
    private readonly dispatcher: RoomProjectionDispatcher,
  ) {}
  @Get("health")
  async health(): Promise<Record<string, unknown>> {
    if (this.connection.readyState !== 1) throw unavailable();
    try {
      await this.connection.db!.admin().command({ ping: 1, maxTimeMS: 1000 });
    } catch {
      throw unavailable();
    }
    return {
      service: "chat-poc-api",
      ready: true,
      development: true,
      protocolVersion: DEFAULTS.protocolVersion,
    };
  }
  @Get("dev/users")
  async devUsers(): Promise<Record<string, unknown>> {
    const users = await this.users
      .find({ datasetId: this.config.datasetId })
      .sort({ _id: 1 })
      .lean();
    return {
      datasetId: this.config.datasetId,
      users: users.map((user) => ({ id: user._id, name: user.name })),
    };
  }
  @Post("dev/session")
  async session(
    @Body() value: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const data = body(value, ["userId", "deviceId"]);
    response.status(200);
    return this.sessions.issue(
      parseUserId(data.userId),
      uuid(data.deviceId, "deviceId"),
    );
  }
  @Post("realtime/ticket")
  @UseGuards(SessionGuard)
  async ticket(
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    body(value ?? {}, []);
    response.status(200);
    return this.sessions.ticket(request.identity);
  }
  @Get("rooms")
  @UseGuards(SessionGuard)
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (
      Object.keys(query).some((key) => !["cursor", "limit"].includes(key)) ||
      (query.cursor !== undefined && typeof query.cursor !== "string")
    )
      throw invalid("Unknown or invalid room-list query field.");
    const limit =
      query.limit === undefined
        ? DEFAULTS.roomsPageSize
        : integer(query.limit, 1, DEFAULTS.maxRoomsPerUser, "limit");
    return {
      datasetId: this.config.datasetId,
      ...(await this.rooms.list(
        request.identity.userId,
        limit,
        query.cursor as string | undefined,
      )),
    };
  }
  @Post("rooms/direct")
  @UseGuards(SessionGuard)
  async direct(
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const data = body(value, ["peerUserId"]);
    const result = await this.rooms.direct(
      request.identity.userId,
      parseUserId(data.peerUserId),
    );
    response.status(result.created ? 201 : 200);
    return { datasetId: this.config.datasetId, ...result };
  }
  @Post("rooms/group")
  @UseGuards(SessionGuard)
  async group(
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const data = body(value, ["title", "memberUserIds", "clientRequestId"]);
    const result = await this.rooms.group(
      request.identity.userId,
      data.title,
      userIds(data.memberUserIds),
      uuid(data.clientRequestId, "clientRequestId"),
    );
    response.status(result.created ? 201 : 200);
    return { datasetId: this.config.datasetId, ...result };
  }
  @Get("rooms/:roomId")
  @UseGuards(SessionGuard)
  async room(
    @Req() request: AuthenticatedRequest,
    @Param("roomId") roomId: string,
  ): Promise<Record<string, unknown>> {
    return {
      datasetId: this.config.datasetId,
      room: await this.rooms.get(
        request.identity.userId,
        uuid(roomId, "roomId"),
      ),
    };
  }
  @Get("rooms/:roomId/messages")
  @UseGuards(SessionGuard)
  async history(
    @Req() request: AuthenticatedRequest,
    @Param("roomId") roomId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (
      Object.keys(query).some(
        (key) => !["beforeRoomSeq", "limit"].includes(key),
      )
    )
      throw invalid("Unknown history query field.");
    const limit =
      query.limit === undefined
        ? DEFAULTS.historyPageSize
        : integer(query.limit, 1, DEFAULTS.maxHistoryPageSize, "limit");
    const before =
      query.beforeRoomSeq === undefined
        ? undefined
        : integer(
            query.beforeRoomSeq,
            1,
            Number.MAX_SAFE_INTEGER,
            "beforeRoomSeq",
          );
    return {
      datasetId: this.config.datasetId,
      ...(await this.messages.history(
        request.identity.userId,
        uuid(roomId, "roomId"),
        limit,
        before,
      )),
    };
  }
  @Post("rooms/:roomId/messages")
  @UseGuards(SessionGuard)
  async send(
    @Req() request: AuthenticatedRequest,
    @Param("roomId") roomId: string,
    @Body() value: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const data = body(value, ["clientMessageId", "text"]);
    const result = await this.messages.send(
      request.identity,
      uuid(roomId, "roomId"),
      uuid(data.clientMessageId, "clientMessageId"),
      data.text,
    );
    response.status(result.duplicate ? 200 : 201);
    return { datasetId: this.config.datasetId, ...result };
  }
  @Post("rooms/:roomId/read")
  @UseGuards(SessionGuard)
  async read(
    @Req() request: AuthenticatedRequest,
    @Param("roomId") roomId: string,
    @Body() value: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const data = body(value, ["throughRoomSeq"]);
    if (typeof data.throughRoomSeq !== "number")
      throw invalid("throughRoomSeq must be a number.");
    const room = await this.messages.read(
      request.identity.userId,
      uuid(roomId, "roomId"),
      data.throughRoomSeq,
    );
    response.status(200);
    return { datasetId: this.config.datasetId, room };
  }
  @Get("presence")
  @UseGuards(SessionGuard)
  async presence(
    @Query() query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (
      Object.keys(query).some((key) => key !== "userIds") ||
      typeof query.userIds !== "string"
    )
      throw invalid("userIds is required.");
    return {
      datasetId: this.config.datasetId,
      items: await this.realtime.presence(userIds(query.userIds.split(","))),
    };
  }
  @Get("dev/diagnostics")
  @UseGuards(SessionGuard)
  async diagnostics(
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return {
      datasetId: this.config.datasetId,
      userId: request.identity.userId,
      deviceId: request.identity.deviceId,
      ...(await this.dispatcher.diagnostics(request.identity.userId)),
    };
  }
}
