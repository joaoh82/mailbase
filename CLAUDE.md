# mailbase

Multi-domain, multi-account webmail platform on Cloudflare. One deployment serves every
domain; domains, mailboxes, and users are database rows, never infrastructure.

**Read `docs/DESIGN.md` before any non-trivial work.** It is the source of truth for
architecture, data model, flows, and the phased plan. If an implementation decision
contradicts it, stop and ask rather than silently diverging. If we agree to change the
design, update `docs/DESIGN.md` in the same PR.

> **Onboarding:** `make bootstrap` (idempotent) takes a fresh clone to a working **local**
> dev env; `make doctor` diagnoses it. Non-Claude agents read [`AGENTS.md`](AGENTS.md);
> the durable shared rules (never-touch-`main`, the Node 24 toolchain, the human-vs-agent
> split) are sourced from
> [`docs/SELF_HOSTING.md` → Ground rules](docs/SELF_HOSTING.md#ground-rules-for-agents-and-humans)
> so this file and `AGENTS.md` point at one source of truth instead of drifting.

## Stack (fixed — do not substitute)

- TypeScript everywhere, `strict: true`. No JS files — the only exceptions are the
  dependency-free onboarding scripts `scripts/bootstrap.mjs` and `scripts/doctor.mjs`,
  which must run on a bare clone (before `tsx` exists) and on a wrong Node (to diagnose
  it); see the header comment in `scripts/doctor.mjs`.
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
docs/                    # DESIGN.md, SELF_HOSTING.md, ROADMAP.md, PROMPTS.md
```

## Commands

- Toolchain is pinned to Node 24 / npm 11 (`.nvmrc` + `engines` + `engine-strict`); run
  `nvm use` first. Installs refuse to run under npm 10 / Node 20 (they prune cross-platform
  optional deps from `package-lock.json`).
- `npm ci` at root to install (npm workspaces) — reproducible, never rewrites the lockfile.
  Only `npm install <pkg>` should change it; if the diff only *removes* optional
  `@emnapi/*` / `@floating-ui/*` / `@rolldown/binding-*` peers for other platforms, that's
  spurious pruning — `git checkout package-lock.json` (see `docs/SELF_HOSTING.md` →
  "Updating dependencies").
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
- **Always keep documentation current — never let the docs drift from the code.** Treat
  docs as part of the change, not an afterthought: any PR that alters behavior, setup
  steps, commands, secrets, deploy steps, architecture, or roadmap status updates the
  relevant docs in the *same* PR. The user-facing surface — `README.md`,
  `docs/SELF_HOSTING.md`, `docs/ROADMAP.md`, and the `Makefile` — must always match
  reality, and `docs/DESIGN.md` stays the accurate source of truth for architecture and the
  data model. Each phase that ships moves its entry out of the "Coming in later phases"
  section of `docs/SELF_HOSTING.md` into the real setup steps and flips its status in
  `docs/ROADMAP.md`. When in doubt, re-read the docs you touched and fix anything stale.

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
