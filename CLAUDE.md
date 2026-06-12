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
  - One workspace: `npm test -w packages/api`. One file/pattern: `npm test -w packages/api -- run path/to.test.ts`
    (or `-t "test name"` to filter by title). Watch mode: drop `run`.
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
- `README.md`, `docs/SELF_HOSTING.md`, and the `Makefile` are user-facing and must stay
  current: any PR that changes setup steps, commands, secrets, or deploy behavior updates
  them in the same PR. Each phase that ships moves its entry out of the "Coming in later
  phases" section of `docs/SELF_HOSTING.md` and into the real setup steps.

## Working agreement

- Work ONE phase (from `docs/DESIGN.md` §9) at a time. Do not start the next phase, or
  "helpfully" implement parts of it, without being asked.
- Every phase ends with: typecheck clean, tests passing, and the phase's milestone
  demonstrably met. Say explicitly how you verified it.
- Steps requiring human action (Cloudflare/Resend accounts, nameserver changes,
  `wrangler login`, creating secrets) — list them and pause; don't fake or skip them.
- Prefer boring, readable code over clever abstractions. This is a long-lived personal
  infrastructure project; optimize for maintainability by one person.

## Knowledge Base

### Project-specific — `~/Documents/josh-obsidian-synced/Projects/mailbase/`

- **Code on Windows:** `D:\projects\mailbase`
- **Code on Mac:** `/Users/joaoh82/projects/mailbase`
- **Context (read first):** `~/Documents/josh-obsidian-synced/Projects/mailbase/context.md`
- **Notes (running journal):** `~/Documents/josh-obsidian-synced/Projects/mailbase/notes.md`
- **Project wiki:** `~/Documents/josh-obsidian-synced/Projects/mailbase/wiki/`

**How to use each:**

- `context.md` — stable background (product goals, stakeholders, domain). Read before starting non-trivial work. Update only when underlying facts change.
- `notes.md` — append-only dated journal. Add entries under `## YYYY-MM-DD` headings for decisions, blockers, TODOs, and incidents — anything worth preserving but not stable enough for `context.md`.
- `wiki/` — reference sub-docs (e.g. `Architecture.md`, `Local Dev Setup.md`, `Tech Services.md`). Create new files as topics emerge.

**When to save:**

- New stable fact about the product/domain → update `context.md`.
- A decision, incident, or working note → append a dated entry to `notes.md`.
- Reusable reference material (setup steps, credential locations, architecture) → new/updated file in `wiki/`.

### Cross-project knowledge — `~/Documents/josh-obsidian-synced/vault/`

- **General wiki:** `~/Documents/josh-obsidian-synced/vault/wiki/` — start at `_master-index.md`, then drill into the relevant topic's `_index.md`.
- **Raw dumps:** `~/Documents/josh-obsidian-synced/vault/raw/` — drop unprocessed research here as `YYYY-MM-DD-{slug}.md`.

Read the general wiki when the question isn't specific to this project. Drop raw research or imported notes into `vault/raw/` so it's captured even before it's distilled.
