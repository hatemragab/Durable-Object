import "reflect-metadata";
import {
  Module,
  type DynamicModule,
  type INestApplication,
  type LoggerService,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { json } from "express";
import { randomUUID } from "node:crypto";
import { isUuid } from "@chat-poc/contracts";
import {
  APP_CONFIG,
  validateMongoUri,
  type AppConfig,
} from "./config/config.js";
import { ApiError, ApiExceptionFilter } from "./common/errors.js";
import {
  USER,
  ROOM,
  MESSAGE,
  ROOM_MEMBER,
  DATASET,
  UserSchema,
  RoomSchema,
  MessageSchema,
  RoomMemberSchema,
  DatasetSchema,
} from "./database/schemas.js";
import { DatabaseService } from "./database/database.service.js";
import { SessionService } from "./dev-session/session.service.js";
import { SessionGuard } from "./dev-session/session.guard.js";
import {
  RoomProjectionDispatcher,
  PublicationProbe,
  RELAY_ENABLED,
} from "./room-sync/dispatcher.service.js";
import { RoomsService } from "./rooms/rooms.service.js";
import { MessagesService, MutationProbe } from "./messages/messages.service.js";
import {
  RealtimeClient,
  WORKER_FETCH,
  type WorkerFetch,
} from "./realtime/realtime.client.js";
import { AppController } from "./app.controller.js";
import { SafeConsoleLogger, requestLogging } from "./common/logging.js";

export interface AppOptions {
  relay?: boolean;
  logger?: LoggerService | false;
  workerFetch?: WorkerFetch;
}
@Module({})
export class AppModule {
  static register(config: AppConfig, options: AppOptions): DynamicModule {
    validateMongoUri(config.mongoUri);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MongooseModule.forRoot(config.mongoUri, {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          socketTimeoutMS: 10000,
          autoIndex: false,
          autoCreate: false,
        }),
        MongooseModule.forFeature([
          { name: USER, schema: UserSchema },
          { name: ROOM, schema: RoomSchema },
          { name: MESSAGE, schema: MessageSchema },
          { name: ROOM_MEMBER, schema: RoomMemberSchema },
          { name: DATASET, schema: DatasetSchema },
        ]),
      ],
      controllers: [AppController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: WORKER_FETCH, useValue: options.workerFetch ?? fetch },
        { provide: RELAY_ENABLED, useValue: options.relay ?? true },
        DatabaseService,
        SessionService,
        SessionGuard,
        RoomProjectionDispatcher,
        PublicationProbe,
        RoomsService,
        MessagesService,
        MutationProbe,
        RealtimeClient,
      ],
    };
  }
}

export async function createApp(
  config: AppConfig,
  options: AppOptions = {},
): Promise<INestApplication> {
  const logger =
    options.logger ??
    new SafeConsoleLogger([
      config.sessionSecret,
      config.ticketSecret,
      config.internalSecret,
      config.mongoUri,
    ]);
  const app = await NestFactory.create(AppModule.register(config, options), {
    logger,
    bodyParser: false,
    abortOnError: false,
  });
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.use(requestLogging(logger));
  // A valid 2,000-scalar text may use 24,000 bytes of JSON Unicode escapes.
  app.use(json({ limit: "32kb", strict: true }));
  const windows = new Map<string, { started: number; count: number }>();
  app.use(
    (
      request: import("express").Request & { requestId?: string },
      response: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      const incoming = request.headers["x-request-id"];
      request.requestId = isUuid(incoming) ? incoming : randomUUID();
      response.setHeader("X-Request-Id", request.requestId);
      response.setHeader("Cache-Control", "no-store");
      const now = Date.now(),
        key = request.ip ?? request.socket.remoteAddress ?? "local";
      let window = windows.get(key);
      if (!window || now - window.started >= 60000) {
        window = { started: now, count: 0 };
        windows.set(key, window);
      }
      if (++window.count > 1200)
        return next(
          new ApiError(
            429,
            "RATE_LIMITED",
            "The development request limit was reached.",
            true,
            60,
          ),
        );
      if (windows.size > 1024)
        for (const [address, entry] of windows)
          if (now - entry.started >= 60000) windows.delete(address);
      next();
    },
  );
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  try {
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
