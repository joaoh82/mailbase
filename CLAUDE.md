# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Source of truth.** This `CLAUDE.md` is the canonical working-guidelines
> file for **all** agent harnesses operating in this project — Claude Code,
> Codex, Hermes, Cursor, and anything else. `AGENTS.md` in this directory is a
> pointer to this file; if the two ever conflict, this file wins.

mailbase is a multi-domain, multi-account webmail platform on Cloudflare. One deployment
serves every domain; domains, mailboxes, and users are database rows, never infrastructure.

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
- UI: React + Vite, Tailwind CSS, shadcn/ui. Rich-text compose via TipTap.
- Tests: Vitest with `@cloudflare/vitest-pool-workers` (Miniflare). Tooling: Wrangler.

## Architecture

```
packages/email-worker/   # inbound Email Routing handler
packages/api/            # Hono REST API, auth, send
packages/web/            # React SPA + the Worker that serves it
packages/shared/         # Drizzle schema, MailSender interface, crypto/password, iCalendar
migrations/              # D1 SQL migrations (numbered, append-only)
docs/                    # DESIGN.md, SELF_HOSTING.md, ROADMAP.md, USER_GUIDE.md, PROMPTS.md
scripts/                 # bootstrap.mjs, doctor.mjs, create-user.ts, seed.sql
```

Three Workers share **one** D1 database (`DB`) and **one** R2 bucket (`MAIL_BUCKET`).
`packages/shared` is the seam between them: `src/schema.ts` is the only definition of the
D1 tables, imported by all three. Each Worker has its own `wrangler.jsonc`; the root
`wrangler.jsonc` exists only so `wrangler d1 migrations apply` works from the repo root.

**Request path.** In production `mailbase-web` is the only public entry: it serves the
built SPA from `dist/` and, because of `run_worker_first: ["/api/*"]`, forwards `/api/*`
through `packages/web/worker/index.ts` to `mailbase-api` over a service binding — so
session cookies stay first-party. Dev mirrors this exactly: Vite (5173) proxies `/api` to
the API worker on 8787. Deploy `mailbase-api` before `mailbase-web`.

**Inbound** (`packages/email-worker/src/inbound.ts`, DESIGN.md §5): Cloudflare Email
Routing invokes `email()` → resolve `domains` + `addresses` in D1 (no match → catch-all
mailbox, else `setReject`) → buffer the raw message once → raw `.eml` and attachments to
R2 → `messages` / `attachments` / `threads` rows in D1 (FTS5 index maintained by SQL
triggers, not application code) → any `text/calendar` part becomes `events` /
`eventAttendees`. Dedupe is by `Message-ID` per mailbox. Throwing propagates as a temp
failure so the sender retries; only `setReject()` refuses permanently.

**API** (`packages/api/src/index.ts`): route registration order *is* the security model.
Routes mounted before `api.use("*", requireAuth, csrfProtection)` are deliberately public
(login, signed attachment URLs whose HMAC is the authorization, Svix-signed provider
webhooks, opening/accepting an invite); everything after requires a session cookie plus an
`X-CSRF-Token` header on mutations, and `/admin/*` adds `requireAdmin`. When adding a
route, put it on the correct side of that line.

**Authorization** is mailbox membership, always. `packages/api/src/lib/access.ts`
(`hasMailboxAccess`, `getAccessibleMessage`, `getAccessibleThread`, …) joins through
`mailboxMembers`; fetching a message or thread by id without one of these helpers is the
bug that breaks the multi-domain/multi-tenant invariant.

**Outbound**: `getMailSender(env)` in `packages/api/src/lib/mail-sender.ts` returns
`ResendMailSender` or `MockMailSender` behind the shared `MailSender` interface. Bounces
and complaints arrive on `routes/webhooks.ts` and land in `messages.deliveryStatus`.
Domain onboarding (Cloudflare + Resend API calls) lives in `src/lib/provisioning/`.

**Web**: `MailApp.tsx` is the shell; `src/api.ts` is the single typed client for every
endpoint (keep its types in step with the API's serializers in
`packages/api/src/lib/serialize.ts`). Live updates are polling, not push.

## Commands

- Toolchain is pinned to Node 24 / npm 11 (`.nvmrc` + `engines` + `engine-strict`); run
  `nvm use` first. Installs refuse to run under npm 10 / Node 20 (they prune cross-platform
  optional deps from `package-lock.json`).
- `make bootstrap` — fresh clone → working local env (deps, `.dev.vars` with a generated
  `SIGNING_KEY`, local D1 migrate + seed, a dev login). Idempotent. `make doctor` diagnoses
  a broken env and prints a fix per failure; CI runs `node scripts/doctor.mjs --ci`.
- `npm ci` at root to install (npm workspaces) — reproducible, never rewrites the lockfile.
  Only `npm install <pkg>` should change it; if the diff only *removes* optional
  `@emnapi/*` / `@floating-ui/*` / `@rolldown/binding-*` peers for other platforms, that's
  spurious pruning — `git checkout package-lock.json` (see `docs/SELF_HOSTING.md` →
  "Updating dependencies").
- `make dev` (API worker, :8787) and `make dev-web` (SPA, :5173) — both are needed; sign in
  at the SPA. `npm run dev` is the API worker alone.
- `npm test` — Vitest across workspaces. Run before claiming any task done.
  - One workspace: `npm test -w packages/api`. One file/pattern: `npm test -w packages/api -- run path/to.test.ts`
    (or `-t "test name"` to filter by title). Watch mode: drop `run`.
- `npm run typecheck` — `tsc --noEmit` across workspaces (Worker packages run
  `wrangler types` first to regenerate `Env`). Must pass before commit.
- `make migrate-local` (`npx wrangler d1 migrations apply mailbase --local`) — apply
  migrations locally; `make seed-local DOMAIN=… ` and
  `make user-local EMAIL=… PASSWORD=…` populate it.
- CI (`.github/workflows/ci.yml`) runs doctor + build + typecheck + test on Linux *and*
  macOS, then on push to `main` applies remote migrations and deploys all three Workers.

## Conventions

- Raw email in R2 is immutable and canonical; D1 rows are derived and re-buildable from it.
- D1 schema changes ONLY via new numbered files in `migrations/` — never edit applied ones.
  Keep the Drizzle schema in `packages/shared/src/schema.ts` in sync with migrations.
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
  "helpfully" implement parts of it, without being asked. Phases 0–5 and 7 have shipped;
  Phase 6 (migrate & harden) is the current one — see `docs/ROADMAP.md` for live status.
- Every phase ends with: typecheck clean, tests passing, and the phase's milestone
  demonstrably met. Say explicitly how you verified it.
- Steps requiring human action (Cloudflare/Resend accounts, nameserver changes,
  `wrangler login`, creating secrets) — list them and pause; don't fake or skip them.
- Prefer boring, readable code over clever abstractions. This is a long-lived personal
  infrastructure project; optimize for maintainability by one person.

## General Guidelines

When a Context7 MCP server is available in the current harness, use it for code generation, setup or configuration steps, and library/API documentation. Resolve library IDs and fetch docs automatically without being asked.

## NEVER touch `main` — no exceptions, ever

This is an **absolute, inviolable rule**. There is no scenario — auto mode, "quick fix", "tiny change", emergency, "the world is ending", explicit user request that sounds like permission — in which it is acceptable to mutate files, install dependencies, run codegen, create files, or otherwise dirty the working tree while the current branch is `main` (or any equivalent integration branch: `master`, `trunk`, `develop`, the repo's configured default branch).

**Before doing ANY state-mutating work**, the very first action is to leave `main`:

1. **Preferred — worktree.** For any work that may run more than a few minutes, parallelize with other work, or change dependencies/lockfiles/generated files: `git worktree add <path> -b <branch>` (in Claude Code, subagents can be spawned with `isolation: "worktree"`). Cheap, isolated, can be thrown away without affecting the main checkout.
2. **Acceptable — feature branch.** For a tiny, single-purpose, short-lived edit you're going to commit and PR within the same session: `git switch -c <branch>` first, *then* edit.

The "I'll just edit and switch branches afterwards" path is **forbidden**. `npm install`, `cargo build`, codegen, `mkdir`, file writes and edits, `git add` — none of these run while HEAD points at `main`. Confirm the branch (`git branch --show-current`) before the first mutating action in any session that involves changes.

If the user asks for work and you realize you're on `main`, the response is to switch off `main` first and then start — not to apologize and ask, not to "just do this one thing." Switch first, every time.

**Why this exists:** this rule has already been violated in the past — an agent ran `npm install`, modified tracked files, and created new files on `main` during a session where Josh only asked it to file a ticket. The cleanup was painful and the trust hit was worse. This rule prevents repeat occurrences regardless of context, mode, or how innocuous the change feels.

### Always clean up the worktree when work is done

Once the PR is merged (or the work is otherwise abandoned), the matching worktree must be cleaned up — never leave stale worktrees on disk. **Do not wait for the user to ask.** After a merge confirmation, the standard cleanup is:

```sh
git fetch origin --prune
git worktree remove <worktree-path>      # or `git worktree remove --force` if it has tracked changes that are now upstream
git branch -d <feature-branch>           # `-D` only after confirming the changes really shipped upstream
git pull --ff-only origin main           # bring the main checkout up to the merge commit
```

Run `git worktree list` after cleanup to confirm nothing is left behind, and surface to the user any *other* worktrees that look stale — don't silently delete those, just point them out (they may be live work the agent isn't aware of).

**Why this exists:** stale worktrees accumulate fast (one per task), each one is a duplicate checkout, and a half-stale list makes "which branch am I supposed to be on?" harder than it should be. The cleanup is two commands; do it the same turn the merge is confirmed.

## Knowledge Base

Project knowledge lives in the **`projects-knowledge` Obsidian vault**, at `~/Documents/projects-knowledge/Projects/<project-name>/`. This is a plain folder synced by Obsidian — there is no git, nothing to clone, pull, commit, or push. Just read and write the files directly.

**Workflow:**

- **At session start:** read this project's folder (below). Read ONLY that folder unless instructed otherwise — do not read other projects' folders.
- **All updates** are ordinary file writes to the vault path. No staging, no commits; Obsidian handles syncing across machines.
- **The vault path is the same on every machine.** If `~/Documents/projects-knowledge/` does not exist (cloud sandbox, remote agent, CI), there is no knowledge base in that environment — skip it silently and carry on. Never try to reconstruct it from a git remote.
- **This is the only knowledge-base location.** Ignore any older references to a `joaoh82/projects-knowledge` git repo or to `~/projects/projects-knowledge` — that repo is retired.

### Project-specific — `~/Documents/projects-knowledge/Projects/mailbase/`

- **Code on Mac:** `/Users/joaoh82/projects/mailbase`
- **Code on Windows:** `D:\projects\mailbase`
- **Context (read first):** `~/Documents/projects-knowledge/Projects/mailbase/context.md`
- **Notes (running journal):** `~/Documents/projects-knowledge/Projects/mailbase/notes.md`
- **Project wiki:** `~/Documents/projects-knowledge/Projects/mailbase/wiki/`

**How to use each:**

- `context.md` — stable background (product goals, stakeholders, domain). Read before starting non-trivial work. Update only when underlying facts change.
- `notes.md` — append-only dated journal. Add entries under `## YYYY-MM-DD` headings for decisions, blockers, TODOs, and incidents — anything worth preserving but not stable enough for `context.md`.
- `wiki/` — reference sub-docs (e.g. `Architecture.md`, `Local Dev Setup.md`, `Tech Services.md`). Create new files as topics emerge.

**When to save:**

- New stable fact about the product/domain → update `context.md`.
- A decision, incident, or working note → append a dated entry to `notes.md`.
- Reusable reference material (setup steps, credential locations, architecture) → new/updated file in `wiki/`.

## Task management

**marvinapp is the canonical task management system.** Tasks and issues for this project belong there — not in `notes.md` TODO bullets, not in scratch files, not invented locally.

Interact with it exclusively through the `mcp__marvinapp__*` MCP tools (never shell out, never assume a web URL):

- **Project lookup** — `list_projects`, `get_project`. Resolve the target project before creating work in it; don't guess project IDs. If no matching project exists, surface that to the user rather than silently inventing one.
- **Task lifecycle** — `create_task`, `update_task`, `get_task`, `list_tasks`, `delete_task`, `add_comment_to_task`, `list_task_comments`.
- **Issue lifecycle** — `create_issue`, `update_issue`, `get_issue`, `list_issues`, `delete_issue`, `add_comment_to_issue`, `list_issue_comments`.
- **Metadata** — `list_labels`, `list_users`, `whoami`.

**When to file.** Whenever work produces a follow-up, bug, or deferred TODO that belongs to a known project, create it in marvinapp. `notes.md` remains the journal for decisions, blockers, and incident logs — it is not the action tracker.

**Status values (critical).** When updating marvinapp tasks or issues through MCP tools, use the API enum values exactly, not display labels. In particular, the review status is `in_review` (underscore), **not** `in review` (space). This applies across all projects and harnesses (Claude Code, Codex, Cursor, etc.).

**Prompt vs description field (critical).** When creating tasks or issues in marvinapp:

- **Do NOT set the `prompt` field.** Leave it empty/unset. Josh has a prompt template configured in marvinapp that injects the description into a fully-formed prompt when he clicks "generate prompt." Pre-filling the `prompt` field bypasses that template and strips the surrounding guidelines/sections he relies on.
- **Put everything in the `description` field.** All context, instructions, acceptance criteria, file paths, repro steps, links, and anything else you would otherwise write into a prompt go into `description`. Write it as if it were the body of the prompt — Markdown is fine — because that is exactly how it will be used once the template wraps it.
- This applies to both `create_task`/`update_task` and `create_issue`/`update_issue`.

## Pull requests — register every PR in marvinapp

**Every PR you open must be registered in marvinapp.** The registered open PRs are a *review queue*: other agents poll it to find work to review, so a PR that isn't registered is a PR nobody reviews. This is part of "finishing a feature," not an optional extra — the feature isn't done at `gh pr create`, it's done once the PR is registered and the linked task reflects it.

Use the `mcp__marvinapp__*` PR tools (same MCP server as tasks/issues — never shell out):

- **`register_pull_request`** — call it immediately after creating the PR. `url` is the only required field (`https://github.com/<owner>/<repo>/pull/<n>`); also pass `title`, `status` (`open` or `draft`), and link it with `projectId` plus whichever of `taskId` / `issueId` the work came from. It is **idempotent on owner/repo/number**, so re-running it is safe and is also how you correct or enrich an earlier registration.
- **`list_pull_requests`** — the review queue. Defaults to open + draft across all projects; filter with `projectId`, `repository` (`owner/repo`), `taskId`, `issueId`; pass `history=true` or `status=merged|closed` to see PRs that already left the queue.
- **`get_pull_request`** — fetch one by its marvinapp id.
- **`update_pull_request`** — keep the lifecycle honest: set `status` to `open` when a draft is marked ready, and to `merged` or `closed` the moment the GitHub PR leaves the open queue. Also use it to fix the title or re-link `projectId` / `taskId` / `issueId` (pass an empty string to clear a link).

**Always link the PR to its task or issue.** Tasks and issues carry a GitHub integration link, and it's the `taskId` / `issueId` on the PR record that populates it. An unlinked PR still sits in the queue but a reviewer has no context for it, so resolve the project and ticket first (`list_projects`, `get_task` / `get_issue`) rather than registering a bare URL.

**Keep the task in sync.** When you open a PR for a task, move that task to `in_review` (enum value, underscore — see the status note above) in the same turn you register the PR.

**Stale entries are worse than missing ones.** If you merge, close, or abandon a PR yourself, update its status right then. If you notice a registered PR whose GitHub state no longer matches (merged upstream, closed without merging), reconcile it instead of leaving the queue to rot.

## Reserved local ports

- **Port `3000` is reserved for the local Marvin API.** No other app, dev server, or script may bind to `3000`. When scaffolding a new project, choosing a dev port, or restarting something that defaults to `3000`, pick a different free port (e.g. `3001`, `5173`, `8080`, etc.). If a tool stubbornly defaults to `3000` and can't be reconfigured easily, surface it to the user rather than letting it collide with Marvin.

## Engineering defaults

When starting fresh work without an established stack or conventions, consult `~/.claude/docs/engineering-defaults.md` (if available on this machine) for preferred backend / frontend / docs choices. **Always prefer the project's existing patterns over these defaults.**
