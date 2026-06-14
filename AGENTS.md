# AGENTS.md

Entrypoint for **AI coding agents** (Codex, Cursor, Aider, Gemini CLI, etc.).
Claude Code reads [`CLAUDE.md`](CLAUDE.md) instead — that file stays the canonical,
day-to-day Claude development guide; this one is a self-contained, pointer-heavy
entrypoint for every *other* agent. They overlap on purpose; neither is a copy of the
other.

mailbase is a multi-domain, multi-account webmail platform on Cloudflare. Domains,
mailboxes, and users are database rows, never infrastructure.

## Get it running — one command

From a fresh clone, the entire local setup is one idempotent command:

```sh
nvm use            # match the pinned Node 24 / npm 11 (.nvmrc) — required, see Ground rules
make bootstrap     # or: npm run setup   (or, most robust: node scripts/bootstrap.mjs)
```

`make bootstrap` installs deps, writes `packages/api/.dev.vars` (with a generated
`SIGNING_KEY`), migrates + seeds the **local** D1 database, and creates a dev login —
then prints how to start the app and the credentials it created. It is safe to re-run
(a second run is a clean no-op). Override the defaults with env vars:
`DOMAIN=`, `MAILBOX=`, `EMAIL=`, `PASSWORD=`.

**No Cloudflare or Resend account is needed for local dev** — everything above runs
against local Miniflare bindings.

Then start it (two terminals) and sign in at the printed URL:

```sh
make dev           # API  → http://localhost:8787
make dev-web       # web  → http://localhost:5173   ← open this and sign in
```

If anything looks off, run the preflight — it prints an exact fix for each failure:

```sh
make doctor        # or: npm run doctor / node scripts/doctor.mjs
```

## Ground rules (read before changing anything)

These are the durable, shared rules. They live in the docs so both this file and
`CLAUDE.md` point at one source of truth instead of drifting:

- **Never commit to `main`.** Always branch or use a worktree first, created from an
  up-to-date `main`. See [`CLAUDE.md` → "NEVER touch `main`"](CLAUDE.md) and
  [`docs/SELF_HOSTING.md` → Ground rules](docs/SELF_HOSTING.md#ground-rules-for-agents-and-humans).
- **Use the pinned toolchain: Node 24 / npm 11** (`nvm use`). Older Node ships an older
  npm that silently prunes cross-platform optional deps from `package-lock.json` and
  breaks `npm ci` elsewhere. `make doctor` flags this. Details:
  [`docs/SELF_HOSTING.md` → Updating dependencies](docs/SELF_HOSTING.md#updating-dependencies).
- **Read [`docs/DESIGN.md`](docs/DESIGN.md) before non-trivial work** — it is the source
  of truth for architecture, the data model, and the phased plan. If a change contradicts
  it, update DESIGN.md in the same PR.
- **Work one phase at a time** (`docs/DESIGN.md` §9) and **keep docs current in the same
  PR** as the code. Don't start a later phase unasked.
- **Stop at human-gated steps** — list them and pause; never fake or skip account /
  nameserver / login actions (see the table below).

Verify before claiming done: `make typecheck` and `make test` must pass.

## Human vs agent — where to stop

Reusing the `[YOU]` convention from [`docs/PROMPTS.md`](docs/PROMPTS.md). The canonical
version of this table lives in
[`docs/SELF_HOSTING.md` → Ground rules](docs/SELF_HOSTING.md#ground-rules-for-agents-and-humans).

**You (the agent) can do these autonomously — no human needed:**

| Action | How |
| --- | --- |
| Local setup (deps, `.dev.vars`, migrate, seed, login) | `make bootstrap` |
| Run the app locally | `make dev` + `make dev-web` |
| Build / typecheck / test / lint | `make build` · `make typecheck` · `make test` |
| Preflight diagnosis | `make doctor` |
| **Remote**, *given creds already exist* (a non-interactive `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the environment) | `make setup` (create D1 + R2), `make migrate-remote`, `wrangler secret put <NAME>` from supplied values, `make deploy` |

**`[YOU]` — human-only (interactive or account-gated). Pause and list these; do not attempt them:**

| `[YOU]` step | Why an agent can't |
| --- | --- |
| Create a Cloudflare account; `npx wrangler login` | Interactive browser OAuth |
| Enable R2 in the dashboard | One-time dashboard activation (payment method on file) |
| Add a domain as a Cloudflare zone | Account-gated |
| Delegate nameservers at the registrar | Lives outside Cloudflare (GoDaddy, etc.) |
| Upgrade to the Workers Paid plan ($5/mo) | Billing; argon2 login needs >10ms CPU |
| Create a Resend account + verify a sending domain | Account-gated |

The philosophy mirrors the Phase-5 Domains panel: **automate via API, pause on
nameservers.** Once a human has supplied credentials, an agent can drive the remote
deploy non-interactively.

## Layout & commands

```
packages/email-worker/   # inbound Email Routing handler
packages/api/            # Hono REST API, auth, send
packages/web/            # React SPA (Vite + Tailwind)
packages/shared/         # types, Drizzle schema, MailSender interface
migrations/              # D1 SQL migrations (numbered, append-only)
scripts/                 # bootstrap.mjs, doctor.mjs, create-user.ts, seed.sql
docs/                    # DESIGN.md, SELF_HOSTING.md, ROADMAP.md, PROMPTS.md
```

Run `make help` for every target with its underlying command. The whole stack is
TypeScript (`strict: true`); the only `.mjs` files are `scripts/bootstrap.mjs` and
`scripts/doctor.mjs`, which must run dependency-free on a bare clone and on a wrong Node
(see the header comment in `scripts/doctor.mjs`).

## Where to read more

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture, data model, flows, phased plan **(source of truth)**
- [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) — full manual setup + the agent quickstart and Ground rules
- [`docs/PROMPTS.md`](docs/PROMPTS.md) — phase-by-phase build prompts (shares the `[YOU]` convention)
- [`CLAUDE.md`](CLAUDE.md) — Claude Code's development rules (overlaps this file)
- [`README.md`](README.md) — project overview and the host-your-own summary
