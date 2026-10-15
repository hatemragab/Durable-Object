import { isUuid } from "@chat-poc/contracts";

export interface AppConfig {
  datasetId: string;
  mongoUri: string;
  sessionSecret: string;
  ticketSecret: string;
  internalSecret: string;
  realtimeBaseUrl: string;
  port: number;
  host: string;
}

export const APP_CONFIG = Symbol("APP_CONFIG");

const RUNTIME_KEYS = [
  "APP_ENV",
  "DATASET_ID",
  "MONGO_URI",
  "DEV_SESSION_SECRET",
  "WS_TICKET_SECRET",
  "REALTIME_INTERNAL_SECRET",
  "REALTIME_BASE_URL",
  "PORT",
  "HOST",
] as const;

/** Read configuration as data without exporting management values into process.env. */
export function runtimeEnvironment(
  fileValues: Record<string, string>,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of RUNTIME_KEYS) {
    const value = inherited[key] ?? fileValues[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  if (env.APP_ENV !== "development") {
    throw new Error(
      "APP_ENV must be development; account selection cannot boot in production.",
    );
  }
  const datasetId = env.DATASET_ID ?? "";
  if (!isUuid(datasetId)) throw new Error("DATASET_ID must be a UUID.");
  const mongoUri = env.MONGO_URI ?? "";
  validateMongoUri(mongoUri);
  const secrets = [
    "DEV_SESSION_SECRET",
    "WS_TICKET_SECRET",
    "REALTIME_INTERNAL_SECRET",
  ].map((name) => {
    const value = env[name] ?? "";
    if (Buffer.byteLength(value, "utf8") < 32)
      throw new Error(`${name} must contain at least 32 bytes.`);
    return value;
  });
  if (new Set(secrets).size !== 3)
    throw new Error("Application secrets must be distinct.");
  let realtime: URL;
  try {
    realtime = new URL(env.REALTIME_BASE_URL ?? "");
  } catch {
    throw new Error("REALTIME_BASE_URL must be an origin.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(realtime.hostname);
  if (
    realtime.username ||
    realtime.password ||
    realtime.pathname !== "/" ||
    realtime.search ||
    realtime.hash ||
    (!local &&
      (realtime.protocol !== "https:" ||
        !realtime.hostname.endsWith(".workers.dev"))) ||
    (local && !["http:", "https:"].includes(realtime.protocol))
  ) {
    throw new Error(
      "REALTIME_BASE_URL must be the development Worker HTTPS origin or a local test origin.",
    );
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT is invalid.");
  const host = env.HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host))
    throw new Error(
      "HOST must be loopback or explicitly 0.0.0.0 for trusted LAN testing.",
    );
  return {
    datasetId,
    mongoUri,
    sessionSecret: secrets[0]!,
    ticketSecret: secrets[1]!,
    internalSecret: secrets[2]!,
    realtimeBaseUrl: realtime.origin,
    port,
    host,
  };
}

/** Match the local database helper's dedicated namespace and replica-set boundary. */
export function validateMongoUri(mongoUri: string): void {
  let mongo: URL;
  try {
    mongo = new URL(mongoUri);
  } catch {
    throw new Error("MONGO_URI must be a local replica-set URI.");
  }
  if (
    mongo.protocol !== "mongodb:" ||
    !["localhost", "127.0.0.1"].includes(mongo.hostname) ||
    !mongo.port ||
    Number(mongo.port) < 1 ||
    Number(mongo.port) > 65535 ||
    mongo.searchParams.get("replicaSet") !== "rs0" ||
    !/^\/chat_poc_[A-Za-z0-9_-]+$/.test(mongo.pathname)
  ) {
    throw new Error(
      "MONGO_URI must name a dedicated chat_poc_* loopback rs0 database and an explicit port.",
    );
  }
}
