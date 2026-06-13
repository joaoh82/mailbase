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
  /**
   * AWS region Resend hosts a new domain in (Phase 5 domain provisioning),
   * e.g. "us-east-1". Optional; defaults to us-east-1.
   */
  RESEND_REGION?: string;
  /**
   * Cloudflare API token for Phase 5 domain provisioning: create zones, enable
   * Email Routing, set the catch-all rule, and write DNS records. Needs
   * Account → Zone:Edit, Zone Settings:Edit, DNS:Edit and Email Routing:Edit.
   * When unset, the admin UI runs in simulation (nothing is provisioned). Set
   * via `wrangler secret put CLOUDFLARE_API_TOKEN`.
   */
  CLOUDFLARE_API_TOKEN?: string;
  /**
   * Cloudflare account id new zones are created under (Phase 5). Required
   * alongside CLOUDFLARE_API_TOKEN. Set via
   * `wrangler secret put CLOUDFLARE_ACCOUNT_ID`.
   */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /**
   * Name of the inbound email worker the catch-all rule routes to. Optional;
   * defaults to "mailbase-email-worker".
   */
  EMAIL_WORKER_NAME?: string;
}

declare namespace Cloudflare {
  interface Env {
    SIGNING_KEY: string;
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string;
    RESEND_REGION?: string;
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    EMAIL_WORKER_NAME?: string;
  }
}
