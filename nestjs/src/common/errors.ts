import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { ContractError } from "@chat-poc/contracts";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { safeErrorCode } from "./logging.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export const invalid = (message: string) =>
  new ApiError(400, "VALIDATION_ERROR", message);
export const unavailable = () =>
  new ApiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "A required dependency is unavailable.",
    true,
  );

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host
      .switchToHttp()
      .getRequest<Request & { requestId?: string }>();
    let error: ApiError;
    if (exception instanceof ApiError) error = exception;
    else if (exception instanceof ContractError)
      error = invalid(exception.message);
    else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      error = new ApiError(
        status,
        status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR",
        status === 404 ? "No such endpoint." : "The request is invalid.",
      );
    } else if (
      exception &&
      typeof exception === "object" &&
      "type" in exception &&
      (exception.type === "entity.parse.failed" ||
        exception.type === "entity.too.large")
    ) {
      error = new ApiError(
        exception.type === "entity.too.large" ? 413 : 400,
        "VALIDATION_ERROR",
        "The request body is invalid or too large.",
      );
    } else {
      // Driver/network exceptions may carry credentials or submitted text. Never echo them.
      error = unavailable();
    }
    if (error.retryAfter !== undefined)
      response.setHeader("Retry-After", error.retryAfter);
    const requestId = request.requestId ?? randomUUID();
    response.locals.logRequestId = requestId;
    response.locals.logErrorCode = safeErrorCode(error.code);
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
      requestId,
    });
  }
}
