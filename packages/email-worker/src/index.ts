import { handleInboundEmail } from "./inbound";

// Inbound pipeline (DESIGN.md §5): parse → resolve recipient → raw .eml to R2
// → attachments to R2 → messages/attachments/threads rows in D1 (FTS via
// triggers). Errors propagate so Cloudflare temp-fails the message and the
// sender retries; only setReject() refuses permanently.
export default {
  async email(message, env, _ctx) {
    await handleInboundEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
