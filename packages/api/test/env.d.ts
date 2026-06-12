import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// Test-only binding injected via vitest.config.ts; consumed once by
// test/apply-migrations.ts. SIGNING_KEY is already part of Cloudflare.Env
// via src/env-extra.d.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
