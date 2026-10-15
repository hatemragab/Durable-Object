import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCloudDeployment,
  validateTicketOrigin,
  waitForHeadAlignment,
  startHeartbeat,
  closeOwnedSocket,
} from "./local-smoke.mjs";

const env = {
  APP_ENV: "development",
  CLOUDFLARE_ENVIRONMENT: "development",
  CLOUDFLARE_WORKER_NAME: "chat-poc-realtime-development",
  DATASET_ID: "90000000-0000-4000-8000-000000000001",
  REALTIME_BASE_URL:
    "https://chat-poc-realtime-development.example.workers.dev",
};
const deployment = {
  worker: env.CLOUDFLARE_WORKER_NAME,
  environment: "development",
  datasetId: env.DATASET_ID,
  origin: env.REALTIME_BASE_URL,
  verifiedAt: "2026-10-15T12:00:00Z",
  checks: [
    "health",
    "authenticated-stream",
    "missing-key-negative",
    "ticket-socket-hello",
  ],
};
const snapshots = (workerHead = 10) =>
  ["1", "2", "3"].map((userId) => ({
    userId,
    workerEpoch: "91000000-0000-4000-8000-000000000001",
    workerHead,
    pendingRoomCount: 0,
    blockedCode: null,
    dependencyStatus: { mongo: "available", realtime: "available" },
  }));

test("cloud mode requires matching verified deployment, dataset and exact real origin", () => {
  assert.deepEqual(validateCloudDeployment(env, deployment), {
    origin: deployment.origin,
    worker: deployment.worker,
    verifiedAt: deployment.verifiedAt,
  });
  for (const patch of [
    { environment: "production" },
    { datasetId: "90000000-0000-4000-8000-000000000002" },
    { worker: "another-development-worker" },
    { checks: ["health"] },
    { verifiedAt: "invalid" },
  ])
    assert.throws(() =>
      validateCloudDeployment(env, { ...deployment, ...patch }),
    );
  for (const origin of [
    "http://127.0.0.1:8787",
    "https://127.0.0.1:8787",
    "http://chat-poc-realtime-development.example.workers.dev",
    "https://chat-poc-realtime-development.example.com",
    "https://different-worker.example.workers.dev",
    `${deployment.origin}:8443`,
    `${deployment.origin}/path`,
    `${deployment.origin}/?query=value`,
    `${deployment.origin}/#fragment`,
    "https://username:password@chat-poc-realtime-development.example.workers.dev",
  ])
    assert.throws(() =>
      validateCloudDeployment(
        { ...env, REALTIME_BASE_URL: origin },
        { ...deployment, origin },
      ),
    );
  assert.throws(() =>
    validateCloudDeployment(
      { ...env, REALTIME_BASE_URL: "https://another.example.workers.dev" },
      deployment,
    ),
  );
});

test("every API ticket must point to the exact WSS cloud deployment; local mode stays local", () => {
  const endpoint = `${deployment.origin.replace("https:", "wss:")}/v1/ws`;
  assert.equal(
    validateTicketOrigin(endpoint, deployment.origin).href,
    endpoint,
  );
  for (const value of [
    "ws://127.0.0.1:8787/v1/ws",
    endpoint.replace("wss:", "ws:"),
    "wss://another.example.workers.dev/v1/ws",
    `${endpoint}?ticket=must-not-be-returned-in-url`,
    `${endpoint}#fragment`,
    endpoint.replace("/v1/ws", "/another"),
    endpoint.replace("wss://", "wss://username:password@"),
  ])
    assert.throws(() => validateTicketOrigin(value, deployment.origin));
  assert.equal(
    validateTicketOrigin("ws://127.0.0.1:8787/v1/ws").protocol,
    "ws:",
  );
  assert.throws(() => validateTicketOrigin(endpoint));
});

test("cloud readiness waits for every current projection relay", async () => {
  let clock = 0,
    reads = 0;
  const result = await waitForHeadAlignment(
    async () => {
      reads++;
      return snapshots().map((item) => ({
        ...item,
        pendingRoomCount: reads < 3 ? 1 : 0,
      }));
    },
    {
      timeoutMs: 100,
      intervalMs: 10,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    },
  );
  assert.equal(reads, 3);
  assert.equal(clock, 20);
  assert.deepEqual(
    result,
    ["1", "2", "3"].map((userId) => ({
      userId,
      workerEpoch: "91000000-0000-4000-8000-000000000001",
      workerHead: 10,
    })),
  );
});

test("cloud readiness refuses integrity blocks and missing users, and times out on unavailable or trailing streams", async () => {
  const blocked = snapshots();
  blocked[1].blockedCode = "EVENT_CONFLICT";
  await assert.rejects(
    waitForHeadAlignment(async () => blocked),
    /blocked/,
  );
  await assert.rejects(
    waitForHeadAlignment(async () => snapshots().slice(0, 2)),
    /every/,
  );
  for (const values of [
    snapshots().map((item) => ({ ...item, workerEpoch: null })),
    snapshots().map((item) => ({ ...item, pendingRoomCount: 1 })),
    snapshots().map((item) => ({
      ...item,
      dependencyStatus: { mongo: "available", realtime: "unavailable" },
    })),
  ]) {
    let clock = 0;
    await assert.rejects(
      waitForHeadAlignment(async () => values, {
        timeoutMs: 20,
        intervalMs: 10,
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
        },
      }),
      /Timed out/,
    );
    assert.equal(clock, 20);
  }
});

test("owned client heartbeats continue through long replay and stop cleanly", async () => {
  let failed = false,
    heartbeat;
  const socket = {
    readyState: 1,
    send(value) {
      assert.equal(value, "ping");
      queueMicrotask(() => heartbeat.pong());
    },
  };
  heartbeat = startHeartbeat(
    socket,
    () => {
      failed = true;
    },
    { intervalMs: 5, timeoutMs: 100 },
  );
  try {
    const deadline = Date.now() + 1000;
    while (heartbeat.stats.pongs < 3 && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 5));
    assert.ok(heartbeat.stats.pongs >= 3);
    assert.equal(failed, false);
    heartbeat.stop();
    const count = heartbeat.stats.pings;
    await new Promise((done) => setTimeout(done, 25));
    assert.equal(heartbeat.stats.pings, count);
  } finally {
    heartbeat.stop();
  }
});

test("missing pong fails only the owned client once and clears its timers", async () => {
  let failures = 0;
  const heartbeat = startHeartbeat(
    { readyState: 1, send() {} },
    () => {
      failures++;
    },
    { intervalMs: 5, timeoutMs: 15 },
  );
  try {
    await new Promise((done) => setTimeout(done, 75));
    assert.equal(failures, 1);
    assert.equal(heartbeat.stats.pings, 1);
  } finally {
    heartbeat.stop();
  }
});

test("owned socket cleanup is bounded and terminates only a socket that misses its close grace", async () => {
  class Socket extends EventTarget {
    readyState = 1;
    terminated = 0;
    constructor(graceful) {
      super();
      this.graceful = graceful;
    }
    close(code, reason) {
      assert.equal(code, 1000);
      assert.equal(reason, "smoke disconnect");
      if (this.graceful)
        queueMicrotask(() => {
          this.readyState = 3;
          this.dispatchEvent(new Event("close"));
        });
    }
    terminate() {
      this.terminated++;
      this.readyState = 3;
    }
  }
  const healthy = new Socket(true),
    stalled = new Socket(false);
  assert.equal(await closeOwnedSocket(healthy, { timeoutMs: 15 }), false);
  assert.equal(healthy.terminated, 0);
  assert.equal(await closeOwnedSocket(stalled, { timeoutMs: 15 }), true);
  assert.equal(stalled.terminated, 1);
  assert.equal(await closeOwnedSocket(stalled), false);
  assert.equal(stalled.terminated, 1);
  assert.equal(await closeOwnedSocket(undefined), false);
});
