import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyFreePlan } from "../nestjs/scripts/plan-verification.mjs";
test("unknown, unrelated free, paid, stale and mismatched plans never authorize deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-poc-plan-")),
    accountId = "a".repeat(32),
    now = Date.parse("2026-10-15T00:00:00Z");
  const valid = {
    accountId,
    plan: "Workers Free",
    method: "dashboard-observation",
    sourceUrl: `https://dash.cloudflare.com/${accountId}/workers-and-pages`,
    observedAt: "2026-10-14T23:59:00Z",
  };
  const check = (subscriptions = []) =>
    verifyFreePlan({ accountId, subscriptions, directory, now });
  try {
    await assert.rejects(check());
    await assert.rejects(
      check([{ rate_plan: { id: "free", public_name: "Free zone" } }]),
    );
    await writeFile(
      join(directory, "cloudflare-plan-verification.json"),
      JSON.stringify(valid),
    );
    await assert.rejects(check(), /screenshot/);
    await writeFile(
      join(directory, "cloudflare-plan.png"),
      Buffer.from([137, 80, 78, 71]),
    );
    assert.equal((await check()).plan, "Workers Free");
    await assert.rejects(
      check([{ rate_plan: { id: "WORKERS_PAID" }, state: "Paid" }]),
      /paid/,
    );
    for (const patch of [
      { accountId: "b".repeat(32) },
      { plan: "Free" },
      { observedAt: "2026-10-10T00:00:00Z" },
      { sourceUrl: "https://example.com" },
      { method: "operator-boolean" },
    ]) {
      await writeFile(
        join(directory, "cloudflare-plan-verification.json"),
        JSON.stringify({ ...valid, ...patch }),
      );
      await assert.rejects(check());
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
