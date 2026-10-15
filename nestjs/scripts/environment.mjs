import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const envFile = resolve(root, "nestjs/.env");
export const runtimeKeys = ["WS_TICKET_SECRET", "REALTIME_INTERNAL_SECRET"];
export async function readEnvironment(file = envFile) {
  try {
    return parseEnv(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
export async function appendMissing(values, file = envFile) {
  const existing = await readEnvironment(file);
  const additions = Object.entries(values).filter(([key]) => !existing[key]);
  if (!additions.length) return existing;
  let source = "";
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Fill blank example placeholders in place so a later operator edit cannot be
  // shadowed by a second generated assignment. Preserve populated values/comments.
  const appended = [];
  for (const [key, value] of additions) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
      throw new Error("Invalid configuration variable name.");
    const placeholder = new RegExp(
      `^([ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*)(?:""|'')?([ \\t]*(?:#.*)?)$`,
      "m",
    );
    if (placeholder.test(source))
      source = source.replace(
        placeholder,
        (_match, prefix, suffix) =>
          `${prefix}${JSON.stringify(String(value))}${suffix}`,
      );
    else appended.push(`${key}=${JSON.stringify(String(value))}`);
  }
  const suffix = appended.join("\n");
  await writeFile(
    file,
    `${source}${source.endsWith("\n") ? "" : "\n"}${suffix}${suffix ? "\n" : ""}`,
    { mode: 0o600 },
  );
  await chmod(file, 0o600);
  console.log(
    `Initialized missing configuration names: ${additions.map(([key]) => key).join(", ")}.`,
  );
  return readEnvironment(file);
}
export async function initializeEnvironment() {
  const existing = await readEnvironment();
  const defaults = {
    APP_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "3000",
    MONGO_URI:
      "mongodb://127.0.0.1:27028/chat_poc_development?replicaSet=rs0&directConnection=true",
    DATASET_ID: randomUUID(),
    CLOUDFLARE_WORKER_NAME: "chat-poc-realtime-development",
    CLOUDFLARE_ENVIRONMENT: "development",
    FLUTTER_API_BASE_URL: "http://127.0.0.1:3000/api/v1",
  };
  for (const key of ["DEV_SESSION_SECRET", ...runtimeKeys])
    if (!existing[key]) defaults[key] = randomBytes(48).toString("base64url");
  return appendMissing(defaults);
}
export function validateTarget(env) {
  if (
    env.APP_ENV !== "development" ||
    env.CLOUDFLARE_ENVIRONMENT !== "development"
  )
    throw new Error("Only the development environment is supported.");
  if (
    !/^[a-z][a-z0-9-]{2,62}$/.test(env.CLOUDFLARE_WORKER_NAME ?? "") ||
    !/(?:dev|development|test)/.test(env.CLOUDFLARE_WORKER_NAME)
  )
    throw new Error(
      "Worker name must explicitly identify a development/test target.",
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      env.DATASET_ID ?? "",
    )
  )
    throw new Error("DATASET_ID must be a UUID.");
  const secrets = ["DEV_SESSION_SECRET", ...runtimeKeys].map((key) => env[key]);
  if (
    secrets.some((value) => !value || Buffer.byteLength(value) < 32) ||
    new Set(secrets).size !== 3
  )
    throw new Error(
      "Application secrets must be distinct and at least 32 bytes.",
    );
  if (
    env.CLOUDFLARE_ACCOUNT_ID &&
    !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)
  )
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID must be a valid account identifier.",
    );
  validateFlutterEndpoint(env.FLUTTER_API_BASE_URL);
}
export function validateFlutterEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FLUTTER_API_BASE_URL must be a local backend URL.");
  }
  const hostname = url.hostname;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  const parts = hostname.split(".").map(Number);
  const privateV4 =
    parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (!local && !privateV4) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/v1"
  )
    throw new Error(
      "FLUTTER_API_BASE_URL must target /api/v1 on loopback or a trusted private-LAN address, without credentials/query/fragment.",
    );
}
export function deploymentEnvironment(env) {
  // Do not export the .env wholesale. Management values are child-process inputs only.
  const result = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
  };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    if (env[key]) result[key] = env[key];
  return result;
}
export async function writeFlutterConfig(env) {
  validateFlutterEndpoint(env.FLUTTER_API_BASE_URL);
  await mkdir(resolve(root, "flutter"), { recursive: true });
  await writeFile(
    resolve(root, "flutter/config.local.json"),
    `${JSON.stringify({ API_BASE_URL: env.FLUTTER_API_BASE_URL, EXPECTED_DATASET_ID: env.DATASET_ID }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
