import { ConsoleLogger, type LoggerService } from "@nestjs/common";
import type { Request, RequestHandler, Response } from "express";
import { isUuid } from "@chat-poc/contracts";

/** Framework lifecycle logs are useful; raw driver errors and arbitrary objects are not safe. */
export class SafeConsoleLogger extends ConsoleLogger {
  constructor(private readonly secretValues: readonly string[] = []) {
    super("API", { logLevels: ["log", "warn", "error"], timestamp: true });
  }
  private clean(value: unknown): string {
    if (typeof value !== "string") return "[Non-text log omitted]";
    let text = value;
    for (const secret of this.secretValues)
      if (secret) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(
        /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[REDACTED]",
      )
      .replace(
        /(?:mongodb(?:\+srv)?|https?|wss?):\/\/[^\s"'<>]+/gi,
        "[URL omitted]",
      )
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .slice(0, 2000);
  }
  private safeContext(params: unknown[]): string {
    const last = params.at(-1);
    return typeof last === "string" &&
      [
        "API",
        "Bootstrap",
        "NestFactory",
        "InstanceLoader",
        "RoutesResolver",
        "RouterExplorer",
        "NestApplication",
        "MongooseModule",
        "RoomSync",
        "HTTP",
      ].includes(last)
      ? last
      : "API";
  }
  override log(message: unknown, ...params: unknown[]): void {
    super.log(this.clean(message), this.safeContext(params));
  }
  override warn(message: unknown, ...params: unknown[]): void {
    super.warn(this.clean(message), this.safeContext(params));
  }
  override error(_message: unknown, ...params: unknown[]): void {
    // Mongoose/Nest can put credentials, submitted data and stacks into both arguments.
    super.error(
      "Backend operation failed; inspect request status/error codes and dependency health.",
      this.safeContext(params),
    );
  }
  override fatal(_message: unknown, ...params: unknown[]): void {
    this.error(undefined, ...params);
  }
  override debug(message: unknown, ...params: unknown[]): void {
    super.debug(this.clean(message), this.safeContext(params));
  }
  override verbose(message: unknown, ...params: unknown[]): void {
    super.verbose(this.clean(message), this.safeContext(params));
  }
}

export function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : "INTERNAL_ERROR";
}

/** Log no input values. Room-list classification reads only cursor presence, never its value. */
export function requestLogging(logger: LoggerService | false): RequestHandler {
  return (
    request: Request & { requestId?: string },
    response: Response,
    next,
  ) => {
    if (!logger) return next();
    const started = performance.now();
    let logged = false;
    const complete = (aborted: boolean) => {
      if (logged) return;
      logged = true;
      // Only Express's matched route definition is safe; unknown URLs use a fixed label.
      const path: unknown = request.route?.path;
      const route =
        typeof path === "string" && /^\/[A-Za-z0-9_/:.-]*$/.test(path)
          ? path
          : "unmatched";
      const method = [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
      ].includes(request.method)
        ? request.method
        : "OTHER";
      const operation =
        method === "GET" && route === "/api/v1/rooms"
          ? Object.hasOwn(request.query, "cursor")
            ? " operation=ROOMS_PAGE"
            : " operation=ROOMS_FULL_SNAPSHOT"
          : "";
      const id: unknown = response.locals.logRequestId ?? request.requestId;
      const requestId = isUuid(id) ? id : "unassigned";
      const code: unknown = response.locals.logErrorCode;
      const duration = Math.max(0, performance.now() - started).toFixed(1);
      logger.log(
        `${method} ${route}${operation} status=${response.statusCode} durationMs=${duration} requestId=${requestId}${code ? ` code=${safeErrorCode(code)}` : ""}${aborted ? " aborted=true" : ""}`,
        "HTTP",
      );
    };
    response.once("finish", () => complete(false));
    response.once("close", () => complete(!response.writableFinished));
    next();
  };
}
