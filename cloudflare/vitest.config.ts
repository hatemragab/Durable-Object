import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "development" },
      miniflare: {
        bindings: {
          WS_TICKET_SECRET: "fixture-only-upgrade-secret-000000000000000000000",
          REALTIME_INTERNAL_SECRET:
            "fixture-only-internal-secret-11111111111111111111",
        },
      },
    }),
  ],
  test: { testTimeout: 15_000, fileParallelism: false },
});
