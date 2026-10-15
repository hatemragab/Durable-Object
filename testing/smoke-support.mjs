/** Real HTTP + local/cloud WebSocket integration. Clients persist before ACK.
 * Uses only additive synthetic data in the dedicated development dataset.
 */
import assert from "node:assert/strict";
import { isUuid } from "../shared/dist/index.js";

function cloudOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Cloud smoke requires a verified HTTPS workers.dev origin.",
    );
  }
  assert.ok(
    url.protocol === "https:" &&
      url.hostname.endsWith(".workers.dev") &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Cloud smoke requires a verified HTTPS workers.dev origin.",
  );
  return url.origin;
}

export function validateCloudDeployment(env, deployment) {
  assert.equal(env.APP_ENV, "development");
  assert.equal(env.CLOUDFLARE_ENVIRONMENT, "development");
  assert.ok(isUuid(env.DATASET_ID), "Cloud smoke requires a valid dataset.");
  assert.equal(deployment.environment, "development");
  assert.equal(deployment.datasetId, env.DATASET_ID);
  assert.equal(deployment.worker, env.CLOUDFLARE_WORKER_NAME);
  assert.ok(
    /^[a-z][a-z0-9-]{2,62}$/.test(deployment.worker) &&
      /(?:dev|development|test)/.test(deployment.worker),
    "Cloud smoke requires the designated development Worker.",
  );
  const origin = cloudOrigin(deployment.origin);
  assert.equal(cloudOrigin(env.REALTIME_BASE_URL), origin);
  assert.ok(
    new URL(origin).hostname.startsWith(`${deployment.worker}.`),
    "Cloud origin must belong to the designated Worker.",
  );
  assert.ok(
    Number.isFinite(Date.parse(deployment.verifiedAt)) &&
      [
        "health",
        "authenticated-stream",
        "missing-key-negative",
        "ticket-socket-hello",
      ].every((check) => deployment.checks?.includes(check)),
    "Cloud smoke requires the completed deployment verification receipt.",
  );
  return {
    origin,
    worker: deployment.worker,
    verifiedAt: deployment.verifiedAt,
  };
}

export function validateTicketOrigin(value, expectedOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The API returned an invalid realtime endpoint.");
  }
  assert.ok(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/v1/ws",
    "The API returned an invalid realtime endpoint.",
  );
  if (expectedOrigin) {
    assert.equal(url.protocol, "wss:", "Cloud smoke refuses local realtime.");
    assert.equal(
      url.origin.replace(/^wss:/, "https:"),
      expectedOrigin,
      "API ticket endpoint differs from the verified cloud deployment.",
    );
  } else {
    assert.ok(
      ["ws:", "wss:"].includes(url.protocol) &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "Use --cloud to test a deployed Worker.",
    );
  }
  return url;
}

export async function waitForHeadAlignment(
  read,
  {
    timeoutMs = 600_000,
    intervalMs = 1000,
    now = Date.now,
    pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const snapshots = await read();
    assert.deepEqual(
      snapshots.map((item) => item.userId).sort(),
      ["1", "2", "3"],
      "Readiness must inspect every authoritative user stream.",
    );
    assert.ok(
      snapshots.every((item) => item.blockedCode === null),
      "A user stream is blocked; cloud smoke will not alter its history.",
    );
    if (
      snapshots.every(
        (item) =>
          Number.isSafeInteger(item.workerHead) &&
          item.workerHead >= 0 &&
          isUuid(item.workerEpoch) &&
          item.pendingRoomCount === 0 &&
          item.dependencyStatus?.mongo === "available" &&
          item.dependencyStatus?.realtime === "available",
      )
    )
      return snapshots.map(({ userId, workerEpoch, workerHead }) => ({
        userId,
        workerEpoch,
        workerHead,
      }));
    await pause(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error("Timed out waiting for all three current room projections.");
}

export function startHeartbeat(
  socket,
  onFailure,
  { intervalMs = 20_000, timeoutMs = 10_000 } = {},
) {
  const stats = { pings: 0, pongs: 0 };
  let timer,
    deadline,
    stopped = false;
  function stop() {
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
  }
  function fail() {
    if (stopped) return;
    stop();
    onFailure(new Error("The owned smoke socket heartbeat failed."));
  }
  timer = setInterval(() => {
    if (socket.readyState !== 1) return fail();
    if (deadline !== undefined) return;
    try {
      socket.send("ping");
      stats.pings++;
      deadline = setTimeout(fail, timeoutMs);
      deadline.unref?.();
    } catch {
      fail();
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stats,
    stop,
    pong() {
      stats.pongs++;
      clearTimeout(deadline);
      deadline = undefined;
    },
  };
}

export async function closeOwnedSocket(socket, { timeoutMs = 5000 } = {}) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return false;
  return new Promise((resolve) => {
    let finished = false,
      forced = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeEventListener("close", finish);
      resolve(forced);
    }
    function terminate() {
      forced = true;
      try {
        socket.terminate();
      } finally {
        finish();
      }
    }
    const timer = setTimeout(terminate, timeoutMs);
    socket.addEventListener("close", finish, { once: true });
    try {
      socket.close(1000, "smoke disconnect");
    } catch {
      terminate();
    }
  });
}
