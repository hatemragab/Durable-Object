import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
/** Account APIs do not expose a documented positive Workers Free classifier.
 * Accept a recent concrete dashboard observation, never a generic boolean flag.
 */
export async function verifyFreePlan({
  accountId,
  subscriptions,
  directory,
  now = Date.now(),
}) {
  if (!Array.isArray(subscriptions))
    throw new Error("Account subscriptions could not be verified.");
  const workerPlans = subscriptions.filter((s) =>
    /workers/i.test(JSON.stringify(s.rate_plan ?? {})),
  );
  if (
    workerPlans.some(
      (s) =>
        /WORKERS_PAID|PARTNERS_WORKERS|paid|enterprise/i.test(
          JSON.stringify(s.rate_plan ?? {}),
        ) && s.state !== "Cancelled",
    )
  )
    throw new Error(
      "A paid/partner Workers subscription was observed; this Free-plan trial will not deploy to it.",
    );
  let observation;
  try {
    observation = JSON.parse(
      await readFile(
        resolve(directory, "cloudflare-plan-verification.json"),
        "utf8",
      ),
    );
  } catch {
    throw new Error(
      "Real deployment blocked: effective Workers Free plan needs a current account-specific dashboard observation. See operations/LOCAL_DEVELOPMENT.md.",
    );
  }
  let source;
  try {
    source = new URL(observation.sourceUrl);
  } catch {
    throw new Error("Plan observation has no valid dashboard source.");
  }
  const observed = Date.parse(observation.observedAt);
  if (
    observation.accountId !== accountId ||
    observation.plan !== "Workers Free" ||
    observation.method !== "dashboard-observation" ||
    source.origin !== "https://dash.cloudflare.com" ||
    !source.pathname.startsWith(`/${accountId}/workers`) ||
    !Number.isFinite(observed) ||
    observed > now + 5000 ||
    now - observed > 86_400_000
  )
    throw new Error(
      "Workers Free observation is stale, mismatched, or not a concrete account dashboard observation.",
    );
  const image = await stat(resolve(directory, "cloudflare-plan.png")).catch(
    () => null,
  );
  if (!image?.isFile() || image.size === 0)
    throw new Error(
      "Plan observation is missing its account dashboard screenshot evidence.",
    );
  return {
    plan: "Workers Free",
    method: observation.method,
    observedAt: observation.observedAt,
    workerPlans,
  };
}
