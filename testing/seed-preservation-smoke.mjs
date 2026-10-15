throw new Error("This protocol-v1 probe is retired. Use testing/room-sync-smoke.mjs and the protocol-v2 unit/runtime suites; no old fixture writes were attempted.");
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import mongoose from "../nestjs/node_modules/mongoose/index.js";
import { readEnvironment, root } from "../nestjs/scripts/environment.mjs";
const env = await readEnvironment(),
  client = new mongoose.mongo.MongoClient(env.MONGO_URI);
await client.connect();
async function snapshot() {
  const result = {};
  for (const name of ["users", "rooms", "messages", "dataset_meta"])
    result[name] = await client
      .db()
      .collection(name)
      .find({})
      .sort({ _id: 1 })
      .toArray();
  result.event_outbox = await client
    .db()
    .collection("event_outbox")
    .find(
      {},
      {
        projection: {
          _id: 1,
          datasetId: 1,
          userId: 1,
          streamSeq: 1,
          eventId: 1,
          envelopeJson: 1,
          envelopeHash: 1,
          createdAt: 1,
        },
      },
    )
    .sort({ _id: 1 })
    .toArray();
  return JSON.stringify(result);
}
async function seed() {
  const child = spawn(
    process.execPath,
    [resolve(root, "nestjs/scripts/database.mjs"), "seed"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.resume();
  child.stderr.resume();
  const code = await new Promise((r, j) => {
    child.on("error", j);
    child.on("close", r);
  });
  assert.equal(code, 0, "seed helper succeeds");
}
try {
  const before = await snapshot();
  await seed();
  assert.equal(
    await snapshot(),
    before,
    "all domain bodies/counters and immutable journal bytes survive first reseed",
  );
  await seed();
  assert.equal(await snapshot(), before, "second reseed is also idempotent");
  const report = {
    scope:
      "dedicated local development Mongo dataset; repeated real application seed without concurrent mutations",
    datasetId: env.DATASET_ID,
    verifiedAt: new Date().toISOString(),
    snapshotSha256: createHash("sha256").update(before).digest("hex"),
    checks: [
      "two reseeds preserve complete users/rooms/messages/dataset bodies",
      "all user counters unchanged",
      "all immutable outbox envelope bytes and associations unchanged",
    ],
  };
  await writeFile(
    resolve(root, ".local/seed-preservation-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
