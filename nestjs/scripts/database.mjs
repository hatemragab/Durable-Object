import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createConnection } from "node:net";
import mongoose from "mongoose";
import { initializeEnvironment, root } from "./environment.mjs";
import { ensureReplicaSetInitialized } from "./mongo-safety.mjs";
const { MongoClient } = mongoose.mongo;
const env = await initializeEnvironment();
if (env.APP_ENV !== "development")
  throw new Error("Refusing database setup outside development.");
let uri;
try {
  uri = new URL(env.MONGO_URI);
} catch {
  throw new Error("MONGO_URI must be a valid dedicated local replica-set URI.");
}
if (
  uri.protocol !== "mongodb:" ||
  !["127.0.0.1", "localhost"].includes(uri.hostname) ||
  !uri.port ||
  !uri.pathname.startsWith("/chat_poc_") ||
  uri.searchParams.get("replicaSet") !== "rs0"
)
  throw new Error(
    "db helper requires a dedicated chat_poc_* loopback rs0 database and an explicit port.",
  );
// Initiation must work before the server advertises its replica-set name.
const bootstrapUri = new URL(uri);
bootstrapUri.searchParams.delete("replicaSet");
bootstrapUri.searchParams.set("directConnection", "true");
let client;
try {
  client = new MongoClient(bootstrapUri.toString(), {
    serverSelectionTimeoutMS: 1500,
  });
} catch {
  throw new Error(
    "The MongoDB driver rejected MONGO_URI options; no credential-bearing URI is logged.",
  );
}
async function connect() {
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  }
}
if (!(await connect())) {
  if (process.argv[2] !== "up")
    throw new Error(
      "Mongo unavailable. Run npm --prefix nestjs run db:up first.",
    );
  const occupied = await new Promise((resolve) => {
    const socket = createConnection({
      host: uri.hostname,
      port: Number(uri.port),
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (occupied)
    throw new Error(
      "A server already listens on the configured Mongo port but the driver could not connect. Verify credentials and readiness; no replacement process was started.",
    );
  const data = resolve(root, ".local/mongo");
  await mkdir(data, { recursive: true });
  const child = spawn(
    "mongod",
    [
      "--replSet",
      "rs0",
      "--port",
      uri.port || "27028",
      "--bind_ip",
      "127.0.0.1",
      "--dbpath",
      data,
      "--logpath",
      resolve(data, "mongod.log"),
    ],
    { detached: true, stdio: "ignore" },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  await writeFile(
    resolve(data, "process.json"),
    JSON.stringify({
      pid: child.pid,
      port: Number(uri.port || 27028),
      dbpath: data,
    }),
  );
  let available = false;
  for (let n = 0; n < 30; n++) {
    if (await connect()) {
      available = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!available)
    throw new Error(
      "Dedicated mongod did not start; inspect .local/mongo/mongod.log.",
    );
}
try {
  const admin = client.db("admin");
  await ensureReplicaSetInitialized(
    admin,
    resolve(root, ".local/mongo"),
    uri.port,
  );
  let primary = false;
  for (let n = 0; n < 60; n++) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary && hello.setName === "rs0") {
      primary = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!primary) throw new Error("Replica set did not become PRIMARY.");
  console.log(
    "Dedicated local rs0 replica set is PRIMARY. No existing data was erased.",
  );
} finally {
  await client.close();
}
if (process.argv[2] === "seed") {
  // Reuse the application's dataset/index/seed implementation; no parallel seeder.
  const { createApp } = await import("../dist/src/app.js");
  const { readConfig } = await import("../dist/src/config/config.js");
  const app = await createApp(
    readConfig({
      ...env,
      REALTIME_BASE_URL: env.REALTIME_BASE_URL || "http://127.0.0.1:8787",
    }),
    { relay: false },
  );
  await app.close();
  console.log(
    "Application initialization verified dataset and seeded missing users.",
  );
}
