// Secrets are not part of wrangler.jsonc, so `wrangler types` cannot emit
// them; merge them into the generated global Env (and Cloudflare.Env, which
// cloudflare:test's ProvidedEnv derives from) here.
interface Env {
  /**
   * HMAC key for signed attachment URLs. Set via
   * `wrangler secret put SIGNING_KEY` (production) or `.dev.vars` (local).
   */
  SIGNING_KEY: string;
}

declare namespace Cloudflare {
  interface Env {
    SIGNING_KEY: string;
  }
}
