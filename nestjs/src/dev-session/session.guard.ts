import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Inject,
} from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "./session.service.js";
import type { Identity } from "../messages/messages.service.js";

export type AuthenticatedRequest = Request & {
  identity: Identity;
  requestId: string;
};
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.identity = await this.sessions.verify(
      request.headers.authorization,
    );
    return true;
  }
}
