import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMissing,
  readEnvironment,
  deploymentEnvironment,
  validateTarget,
  validateFlutterEndpoint,
} from "../nestjs/scripts/environment.mjs";
test("configuration initialization preserves supplied values and treats shell text as data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-poc-env-test-"));
  try {
    const file = join(dir, ".env");
    const original =
      '# User notes\nEXISTING="user supplied value"\nEMPTY=\nSHELL="$(should_never_run) `also_data`"\n';
    await writeFile(file, original);
    await appendMissing(
      { EXISTING: "replacement", EMPTY: "filled", NEW: "value" },
      file,
    );
    const env = await readEnvironment(file);
    assert.equal(env.EXISTING, "user supplied value");
    assert.equal(env.EMPTY, "filled");
    assert.equal(env.SHELL, "$(should_never_run) `also_data`");
    const written = await readFile(file, "utf8");
    assert.ok(written.includes('# User notes\nEXISTING="user supplied value"'));
    assert.equal(
      written.match(/^EMPTY=/gm).length,
      1,
      "blank example entry is filled without shadowing duplicates",
    );
    await writeFile(
      file,
      written.replace('EMPTY="filled"', 'EMPTY="operator edit"'),
    );
    await appendMissing({ EMPTY: "must not replace" }, file);
    assert.equal((await readEnvironment(file)).EMPTY, "operator edit");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Wrangler child receives only allowed management inputs and no runtime/source secrets", () => {
  const result = deploymentEnvironment({
    CLOUDFLARE_API_TOKEN: "management",
    CLOUDFLARE_ACCOUNT_ID: "account",
    WS_TICKET_SECRET: "ticket",
    REALTIME_INTERNAL_SECRET: "internal",
    MONGO_URI: "private",
    DEV_SESSION_SECRET: "session",
    NODE_OPTIONS: "malicious",
  });
  assert.equal(result.CLOUDFLARE_API_TOKEN, "management");
  for (const name of [
    "WS_TICKET_SECRET",
    "REALTIME_INTERNAL_SECRET",
    "MONGO_URI",
    "DEV_SESSION_SECRET",
    "NODE_OPTIONS",
  ])
    assert.equal(result[name], undefined);
});
test("setup rejects nondevelopment, unrelated Worker names, bad dataset and shared secrets", () => {
  const env = {
    APP_ENV: "development",
    CLOUDFLARE_ENVIRONMENT: "development",
    CLOUDFLARE_WORKER_NAME: "chat-poc-realtime-development",
    DATASET_ID: "90000000-0000-4000-8000-000000000001",
    DEV_SESSION_SECRET: "a".repeat(48),
    WS_TICKET_SECRET: "b".repeat(48),
    REALTIME_INTERNAL_SECRET: "c".repeat(48),
    FLUTTER_API_BASE_URL: "http://127.0.0.1:3000/api/v1",
  };
  validateTarget(env);
  for (const patch of [
    { APP_ENV: "production" },
    { CLOUDFLARE_ENVIRONMENT: "production" },
    { CLOUDFLARE_WORKER_NAME: "existing-main" },
    { DATASET_ID: "bad" },
    { WS_TICKET_SECRET: env.DEV_SESSION_SECRET },
  ])
    assert.throws(() => validateTarget({ ...env, ...patch }));
});
test("client configuration accepts only valid local backend endpoints", () => {
  for (const url of [
    "http://127.0.0.1:3000/api/v1",
    "http://10.0.2.2:3000/api/v1",
    "http://192.168.1.20:3000/api/v1",
    "http://172.16.0.1:3000/api/v1",
  ])
    validateFlutterEndpoint(url);
  for (const url of [
    "garbage",
    "https://production.example/api/v1",
    "http://user:pass@127.0.0.1/api/v1",
    "http://127.0.0.1/api/v1?q=x",
    "http://127.0.0.1/api/v1#fragment",
    "file:///api/v1",
    "http://127.0.0.1/api/v2",
    "http://172.32.0.1/api/v1",
  ])
    assert.throws(() => validateFlutterEndpoint(url));
});
