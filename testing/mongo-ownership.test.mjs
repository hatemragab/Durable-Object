import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "../nestjs/node_modules/mongoose/index.js";
import { ensureReplicaSetInitialized } from "../nestjs/scripts/mongo-safety.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeLoopbackPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test(
  "a dedicated real mongod proves refusal, ownership verification, and idempotent initialization",
  { timeout: 60_000 },
  async (t) => {
    await mkdir(resolve(root, ".local"), { recursive: true });
    const fixture = await mkdtemp(resolve(root, ".local/mongo-ownership-"));
    const dbpath = resolve(fixture, "data"),
      wrongPath = resolve(fixture, "unowned-data");
    await mkdir(dbpath);
    await mkdir(wrongPath);
    const port = await freeLoopbackPort();
    // The fixture always launches its own process on a newly allocated loopback port.
    // No existing database URI, environment file, or development server is used.
    const child = spawn(
      "mongod",
      [
        "--replSet",
        "rs0",
        "--port",
        String(port),
        "--bind_ip",
        "127.0.0.1",
        "--dbpath",
        dbpath,
        "--logpath",
        resolve(fixture, "mongod.log"),
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    const client = new mongoose.mongo.MongoClient(
      `mongodb://127.0.0.1:${port}/admin?directConnection=true`,
      { serverSelectionTimeoutMS: 300, connectTimeoutMS: 300 },
    );
    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      let connected = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("The isolated test mongod exited before readiness.");
        try {
          await client.connect();
          connected = true;
          break;
        } catch {
          await pause(100);
        }
      }
      assert.ok(connected, "the isolated mongod must become reachable");
      const admin = client.db("admin");
      const options = await admin.command({ getCmdLineOpts: 1 });
      // Verify that a port race cannot make the test act on an unrelated process.
      assert.equal(
        await realpath(options.parsed.storage.dbPath),
        await realpath(dbpath),
      );

      await t.test(
        "a mismatched owned path is refused and the actual server remains uninitialized",
        async () => {
          await assert.rejects(
            ensureReplicaSetInitialized(admin, wrongPath, port),
            /unowned MongoDB server/,
          );
          await assert.rejects(
            admin.command({ replSetGetStatus: 1 }),
            (error) => error.code === 94,
          );
          const local = client.db("local");
          assert.equal(
            await local.collection("system.replset").countDocuments(),
            0,
          );
        },
      );

      await t.test(
        "a mismatched advertised port is refused before writing configuration",
        async () => {
          await assert.rejects(
            ensureReplicaSetInitialized(
              admin,
              dbpath,
              port === 65535 ? port - 1 : port + 1,
            ),
            /different replica-set name or port/,
          );
          await assert.rejects(
            admin.command({ replSetGetStatus: 1 }),
            (error) => error.code === 94,
          );
        },
      );

      await t.test(
        "the matching verified fixture path permits initial rs0 configuration",
        async () => {
          assert.deepEqual(
            await ensureReplicaSetInitialized(admin, dbpath, port),
            { initialized: true },
          );
          let primary = false;
          for (let attempt = 0; attempt < 80; attempt++) {
            const hello = await admin.command({ hello: 1 });
            if (hello.isWritablePrimary && hello.setName === "rs0") {
              primary = true;
              break;
            }
            await pause(100);
          }
          assert.ok(primary, "the owned rs0 fixture must become PRIMARY");
          const status = await admin.command({ replSetGetStatus: 1 });
          assert.equal(status.set, "rs0");
          assert.equal(status.members.length, 1);
          assert.equal(status.members[0].name, `127.0.0.1:${port}`);
        },
      );

      await t.test(
        "repeated calls preserve the existing replica configuration without reconfiguration",
        async () => {
          const before = (await admin.command({ replSetGetConfig: 1 })).config;
          assert.deepEqual(
            await ensureReplicaSetInitialized(admin, dbpath, port),
            { initialized: false },
          );
          const after = (await admin.command({ replSetGetConfig: 1 })).config;
          assert.deepEqual(after, before);
        },
      );
    } finally {
      await client.close();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      let stopTimer;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          stopTimer = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      clearTimeout(stopTimer);
      if (!stopped) {
        child.kill("SIGKILL");
        await exited;
      }
      // Cleanup is limited to the freshly generated fixture after its process has stopped.
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test("a different existing set is rejected without any initiation command", async () => {
  const commands = [];
  const admin = {
    command: async (command) => {
      commands.push(command);
      return { set: "unrelated-set" };
    },
  };
  await assert.rejects(
    ensureReplicaSetInitialized(admin, "/unused", 12345),
    /other than the dedicated rs0/,
  );
  assert.deepEqual(commands, [{ replSetGetStatus: 1 }]);
});
