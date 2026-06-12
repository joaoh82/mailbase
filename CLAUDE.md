# mailbase

Multi-domain, multi-account webmail platform on Cloudflare. One deployment serves every
domain; domains, mailboxes, and users are database rows, never infrastructure.

**Read `docs/DESIGN.md` before any non-trivial work.** It is the source of truth for
architecture, data model, flows, and the phased plan. If an implementation decision
contradicts it, stop and ask rather than silently diverging. If we agree to change the
design, update `docs/DESIGN.md` in the same PR.

## Stack (fixed — do not substitute)

- TypeScript everywhere, `strict: true`. No JS files.
- Cloudflare Workers: Email Worker (inbound), Hono API Worker, React SPA via Workers assets.
- Storage: R2 for raw `.eml` and attachments (source of truth), D1 via **Drizzle ORM** for
  metadata. Search via D1 FTS5.
- Email parsing: `postal-mime`. Outbound: Resend, but ONLY behind the `MailSender`
  interface in `packages/shared` — no direct Resend calls outside its adapter.
- UI: React + Vite, Tailwind CSS, shadcn/ui.
- Tests: Vitest with `@cloudflare/vitest-pool-workers` (Miniflare). Tooling: Wrangler.

## Layout

```
packages/email-worker/   # inbound Email Routing handler
packages/api/            # Hono REST API, auth, send
packages/web/            # React SPA
packages/shared/         # types, Drizzle schema, MailSender interface
migrations/              # D1 SQL migrations (numbered, append-only)
docs/                    # DESIGN.md, PROMPTS.md
```

## Commands

- `npm install` at root (npm workspaces).
- `npm run dev` — local dev via `wrangler dev` (Miniflare bindings for D1/R2).
- `npm test` — Vitest across workspaces. Run before claiming any task done.
- `npm run typecheck` — `tsc --noEmit` across workspaces. Must pass before commit.
- `npx wrangler d1 migrations apply mailbase --local` — apply migrations locally.
- Deploys happen via `wrangler deploy` per package (CI does this on push to main).

## Conventions

- Raw email in R2 is immutable and canonical; D1 rows are derived and re-buildable from it.
- D1 schema changes ONLY via new numbered files in `migrations/` — never edit applied ones.
  Keep Drizzle schema in `packages/shared` in sync with migrations.
- All API mutations require a session + CSRF check. Cookies: HttpOnly, Secure, SameSite=Lax.
- Passwords: argon2id. Never log credentials, tokens, or full message bodies.
- Secrets (Resend key, session signing key) only via `wrangler secret` / `.dev.vars`
  (gitignored). Never hardcode; never commit `.dev.vars`.
- Rendered email HTML is hostile input: sandboxed iframe, strict CSP, no remote loads by
  default. Attachments served with `Content-Disposition: attachment` via signed expiring URLs.
- Multi-domain invariant: nothing may assume a single domain. Every mailbox/address/message
  query is scoped by domain or mailbox membership.
- Commit style: small, per-feature commits, imperative subject line.

## Working agreement

- Work ONE phase (from `docs/DESIGN.md` §9) at a time. Do not start the next phase, or
  "helpfully" implement parts of it, without being asked.
- Every phase ends with: typecheck clean, tests passing, and the phase's milestone
  demonstrably met. Say explicitly how you verified it.
- Steps requiring human action (Cloudflare/Resend accounts, nameserver changes,
  `wrangler login`, creating secrets) — list them and pause; don't fake or skip them.
- Prefer boring, readable code over clever abstractions. This is a long-lived personal
  infrastructure project; optimize for maintainability by one person.
