import {
  readFile,
  writeFile,
  mkdtemp,
  rm,
  chmod,
  mkdir,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
  initializeEnvironment,
  appendMissing,
  validateTarget,
  deploymentEnvironment,
  writeFlutterConfig,
  runtimeKeys,
  root,
} from "./environment.mjs";
import { verifyFreePlan } from "./plan-verification.mjs";

const env = await initializeEnvironment();
validateTarget(env);
await writeFlutterConfig(env);
const local = process.argv.includes("--local");
const command = resolve(root, "cloudflare/node_modules/.bin/wrangler");
async function localCommand(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (status !== 0)
    throw new Error(
      "Local database/application prerequisite failed; run db:up, build and db:seed individually for diagnostics.",
    );
}
async function run(args, childEnv = deploymentEnvironment(env)) {
  const child = spawn(command, args, {
    cwd: resolve(root, "cloudflare"),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (part) => (output += part));
  child.stderr.on("data", (part) => (output += part));
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (status !== 0)
    throw new Error(
      `Wrangler ${args[0]} failed (exit ${status}); no CLI output is printed because it may contain credentials. Run the documented nonsecret dry-run to inspect configuration errors.`,
    );
  return output;
}
async function cloudflare(path, { allow404 = false } = {}) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`,
    {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (response.status === 404 && allow404) return null;
  if (!response.ok)
    throw new Error(
      `Cloudflare target inspection failed (HTTP ${response.status}).`,
    );
  const data = await response.json();
  if (!data.success) throw new Error("Cloudflare target inspection failed.");
  return data.result;
}
await localCommand(process.execPath, [
  resolve(root, "nestjs/scripts/database.mjs"),
  "up",
]);
await localCommand("npm", ["--prefix", "nestjs", "run", "build"]);
await localCommand(process.execPath, [
  resolve(root, "nestjs/scripts/database.mjs"),
  "seed",
]);
console.log(
  "Dedicated local replica set, indexes, dataset and seed verified non-destructively.",
);
await mkdir(resolve(root, ".local"), { recursive: true });
const config = JSON.parse(
  await readFile(resolve(root, "cloudflare/wrangler.jsonc"), "utf8"),
);
config.name = env.CLOUDFLARE_WORKER_NAME;
config.env.development.name = env.CLOUDFLARE_WORKER_NAME;
config.env.development.vars = {
  APP_ENV: "development",
  DATASET_ID: env.DATASET_ID,
};
const configPath = resolve(root, "cloudflare/wrangler.local.jsonc");
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
await run([
  "deploy",
  "--env",
  "development",
  "--config",
  configPath,
  "--dry-run",
  "--outdir",
  resolve(root, ".local/worker-build"),
]);
console.log("Worker development configuration passed Wrangler dry-run.");
if (local) {
  await writeFile(
    resolve(root, "cloudflare/.dev.vars.development"),
    runtimeKeys.map((key) => `${key}=${JSON.stringify(env[key])}`).join("\n") +
      "\n",
    { mode: 0o600 },
  );
  await chmod(resolve(root, "cloudflare/.dev.vars.development"), 0o600);
  console.log(
    "Local runtime secrets generated from the two-key allowlist. No cloud deployment attempted.",
  );
  console.log(
    "Start local Worker: npm --prefix cloudflare run dev:local -- --config wrangler.local.jsonc",
  );
  process.exit(0);
}
if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN)
  throw new Error(
    "Real Cloudflare deployment blocked: set CLOUDFLARE_ACCOUNT_ID and a restricted CLOUDFLARE_API_TOKEN in nestjs/.env. Local implementation and tests remain usable.",
  );
// Inspect only the designated name before deploying. Never adopt an unrelated Worker.
const settings = await cloudflare(
  `/workers/scripts/${encodeURIComponent(env.CLOUDFLARE_WORKER_NAME)}/settings`,
  { allow404: true },
);
if (settings) {
  const bindings = settings.bindings ?? [];
  const dataset = bindings.find((b) => b.name === "DATASET_ID")?.text;
  const mode = bindings.find((b) => b.name === "APP_ENV")?.text;
  if (dataset !== env.DATASET_ID || mode !== "development")
    throw new Error(
      "The chosen Worker already exists with a different dataset/environment. Refusing to overwrite it.",
    );
}
const subscriptions = await cloudflare("/subscriptions");
const plan = await verifyFreePlan({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  subscriptions,
  directory: resolve(root, ".local"),
});
await writeFile(
  resolve(root, ".local/cloudflare-plan.json"),
  JSON.stringify({ checkedAt: new Date().toISOString(), ...plan }, null, 2) +
    "\n",
);
console.log(
  "Workers Free dashboard evidence and account subscriptions verified; no billing change requested.",
);
const directory = await mkdtemp(resolve(tmpdir(), "chat-poc-secrets-"));
await chmod(directory, 0o700);
let output;
try {
  const file = resolve(directory, "runtime.secret.json");
  await writeFile(
    file,
    JSON.stringify(
      Object.fromEntries(runtimeKeys.map((key) => [key, env[key]])),
    ),
    { mode: 0o600 },
  );
  output = await run([
    "deploy",
    "--env",
    "development",
    "--config",
    configPath,
    "--secrets-file",
    file,
    "--strict",
  ]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
const origins = [
  ...output.matchAll(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/g),
].map((m) => new URL(m[0]).origin);
const actual = origins.find((origin) =>
  new URL(origin).hostname.startsWith(`${env.CLOUDFLARE_WORKER_NAME}.`),
);
if (!actual)
  throw new Error(
    "Deployment returned no verifiable workers.dev origin. Inspect the designated Worker without guessing an endpoint.",
  );
if (env.REALTIME_BASE_URL && new URL(env.REALTIME_BASE_URL).origin !== actual)
  throw new Error(
    "Deployed origin differs from supplied REALTIME_BASE_URL; user value preserved.",
  );
await appendMissing({ REALTIME_BASE_URL: actual });
const health = await fetch(`${actual}/health`, {
  signal: AbortSignal.timeout(10000),
});
if (!health.ok) throw new Error("Worker health verification failed.");
const headers = {
  Authorization: `Bearer ${env.REALTIME_INTERNAL_SECRET}`,
  "X-Dataset-Id": env.DATASET_ID,
};
const stream = await fetch(`${actual}/internal/v1/users/1/stream`, {
  headers,
  signal: AbortSignal.timeout(10000),
});
if (!stream.ok)
  throw new Error("Authenticated Worker stream verification failed.");
const head = await stream.json();
if (head.datasetId !== env.DATASET_ID || head.userId !== "1")
  throw new Error("Deployed Worker identity verification failed.");
const denied = await fetch(`${actual}/internal/v1/users/1/stream`, {
  signal: AbortSignal.timeout(10000),
});
if (denied.status !== 401)
  throw new Error("Worker missing-key negative check failed.");
const now = Math.floor(Date.now() / 1000),
  deviceId = randomUUID();
const ticket = await new SignJWT({
  deviceId,
  datasetId: env.DATASET_ID,
  sessionExp: now + 300,
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuer("chat-poc-nestjs")
  .setAudience("chat-poc-realtime")
  .setSubject("1")
  .setIssuedAt(now)
  .setExpirationTime(now + 60)
  .setJti(randomUUID())
  .sign(new TextEncoder().encode(env.WS_TICKET_SECRET));
await new Promise((resolve, reject) => {
  const ws = new WebSocket(
    `${actual.replace("https:", "wss:")}/v1/ws?ticket=${encodeURIComponent(ticket)}`,
  );
  const timer = setTimeout(() => {
    ws.close();
    reject(new Error("Ticket-authorized socket hello timed out."));
  }, 10000);
  ws.onmessage = (event) => {
    try {
      const hello = JSON.parse(event.data);
      if (
        hello.type !== "hello" ||
        hello.datasetId !== env.DATASET_ID ||
        hello.deviceId !== deviceId
      )
        throw new Error("Socket identity mismatch.");
      clearTimeout(timer);
      ws.close(1000, "setup check");
      resolve();
    } catch {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Socket hello verification failed."));
    }
  };
  ws.onerror = () => {
    clearTimeout(timer);
    reject(new Error("Ticket-authorized socket verification failed."));
  };
});
await writeFile(
  resolve(root, ".local/deployment.json"),
  `${JSON.stringify({ worker: env.CLOUDFLARE_WORKER_NAME, environment: "development", datasetId: env.DATASET_ID, origin: actual, verifiedAt: new Date().toISOString(), checks: ["health", "authenticated-stream", "missing-key-negative", "ticket-socket-hello"] }, null, 2)}\n`,
);
console.log(`Verified development Worker: ${actual}`);
console.log("Start API: npm --prefix nestjs run start:dev");
console.log(
  "Run iOS: cd flutter && flutter run -d 3CC14436-EC3C-4419-A079-C84951E5FA07 --dart-define-from-file=config.local.json",
);
