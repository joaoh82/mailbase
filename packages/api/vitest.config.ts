import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Paths are relative to this package, like wrangler.configPath below; tests
// must be run via the package's npm script (root `npm test` does this).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SIGNING_KEY: "test-signing-key",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
