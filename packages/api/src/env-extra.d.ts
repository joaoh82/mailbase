// Secrets are not part of wrangler.jsonc, so `wrangler types` cannot emit
// them; merge them into the generated global Env (and Cloudflare.Env, which
// cloudflare:test's ProvidedEnv derives from) here.
interface Env {
  /**
   * HMAC key for signed attachment URLs. Set via
   * `wrangler secret put SIGNING_KEY` (production) or `.dev.vars` (local).
   */
  SIGNING_KEY: string;
  /**
   * Resend API key for outbound mail. When unset, the API falls back to a
   * mock sender (local dev / tests never reach Resend). Set via
   * `wrangler secret put RESEND_API_KEY`.
   */
  RESEND_API_KEY?: string;
  /**
   * Svix signing secret (`whsec_…`) for verifying Resend bounce/complaint
   * webhooks. Set via `wrangler secret put RESEND_WEBHOOK_SECRET`.
   */
  RESEND_WEBHOOK_SECRET?: string;
}

declare namespace Cloudflare {
  interface Env {
    SIGNING_KEY: string;
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string;
  }
}
