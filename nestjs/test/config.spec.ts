import { describe, expect, test } from "@jest/globals";
import { readConfig, runtimeEnvironment } from "../src/config/config.js";
import { randomUUID } from "node:crypto";

const valid = () => ({
  APP_ENV: "development",
  DATASET_ID: randomUUID(),
  MONGO_URI: "mongodb://127.0.0.1:27028/chat_poc_config_fixture?replicaSet=rs0",
  DEV_SESSION_SECRET: `session-${randomUUID()}`,
  WS_TICKET_SECRET: `ticket-${randomUUID()}`,
  REALTIME_INTERNAL_SECRET: `internal-${randomUUID()}`,
  REALTIME_BASE_URL: "http://127.0.0.1:8787",
});

describe("safe runtime configuration", () => {
  test("allowlists application fields and preserves inherited overrides without mutating inputs", () => {
    const file = {
      ...valid(),
      CLOUDFLARE_API_TOKEN: "management-must-not-be-copied",
      CLOUDFLARE_ACCOUNT_ID: "private-account",
      PORT: "3000",
    };
    const inherited = {
      PORT: "3001",
      CLOUDFLARE_API_TOKEN: "inherited-management",
    };
    const result = runtimeEnvironment(file, inherited);
    expect(result.PORT).toBe("3001");
    expect(result.DATASET_ID).toBe(file.DATASET_ID);
    expect(result).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(result).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");
    expect(file.PORT).toBe("3000");
    expect(inherited).toEqual({
      PORT: "3001",
      CLOUDFLARE_API_TOKEN: "inherited-management",
    });
  });
  test.each([
    { APP_ENV: "production" },
    { MONGO_URI: "mongodb://remote.invalid/demo?replicaSet=rs0" },
    { MONGO_URI: "mongodb://localhost/admin?replicaSet=rs0" },
    { MONGO_URI: "mongodb://localhost/chat_poc" },
    {
      MONGO_URI:
        "mongodb://127.0.0.1:27028/unrelated_existing_database?replicaSet=rs0",
    },
    { MONGO_URI: "mongodb://127.0.0.1/chat_poc_fixture?replicaSet=rs0" },
    {
      MONGO_URI: "mongodb://127.0.0.1:27028/chat_poc_fixture?replicaSet=other",
    },
    { MONGO_URI: "mongodb://127.0.0.1:0/chat_poc_fixture?replicaSet=rs0" },
    { REALTIME_BASE_URL: "https://production.example.com" },
    { REALTIME_BASE_URL: "https://test.workers.dev/path" },
    { PORT: "0" },
    { HOST: "untrusted.example.com" },
  ])("rejects unsupported runtime target %p", (override) => {
    expect(() => readConfig({ ...valid(), ...override })).toThrow();
  });
  test("rejects reused signing/integration secrets", () => {
    const env = valid();
    expect(() =>
      readConfig({ ...env, WS_TICKET_SECRET: env.DEV_SESSION_SECRET }),
    ).toThrow("distinct");
  });
});
