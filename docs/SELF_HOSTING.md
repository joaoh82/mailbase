# Self-hosting mailbase

This guide walks you from a fresh clone to your own mailbase deployment on your own
Cloudflare account.

> **Kept current per phase.** This document tracks the project as it develops; each
> phase that changes setup adds its steps here. **Current as of Phase 5** — receiving
> works (mail to any address on your domain is parsed and stored in R2/D1), reading
> works (sign in, browse folders, read HTML mail safely, star/archive/trash, download
> attachments, search), **sending works** (a rich-text composer that produces HTML mail
> with a plaintext fallback, reply/reply-all/forward with quoting, attachments, a Sent
> folder, and bounce/complaint flagging via webhooks),
> **multiple users** can share inboxes with `owner`/`member` roles, send only from
> addresses they own, and onboard new accounts via one-time invite links (step 15), and
> **admins add new domains from the webmail itself** — the Cloudflare zone, Email
> Routing, catch-all rule, and Resend DKIM/SPF records are all created via API, with a
> domain switcher and unified "all inboxes" view in the UI (step 16).

## Quickstart (agents & humans): one-command local setup

To get a **local** dev environment running without walking the full guide below, from a
fresh clone:

```sh
nvm use            # match the pinned Node 24 / npm 11 (.nvmrc)
make bootstrap     # or: npm run setup
```

`make bootstrap` is idempotent and does everything local: install deps, create
`packages/api/.dev.vars` (with a generated `SIGNING_KEY`), migrate + seed the local D1
database, and create a dev login — then it prints the start commands (`make dev` +
`make dev-web`), the login it created, and the human-only steps it won't attempt. If a
setup looks broken, `make doctor` checks the toolchain and dev state and prints a fix for
each problem. **No Cloudflare or Resend account is needed for local dev.**

This is the fast path for AI agents too — see **[AGENTS.md](../AGENTS.md)** (the
cross-agent entrypoint) and the Ground rules below. The rest of this document is the full,
manual, production walkthrough.

## Ground rules (for agents and humans)

The durable rules every contributor — human or AI agent — follows. Both
[AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) link here so there is one source
of truth instead of three copies that drift.

- **Never commit to `main`.** Branch or use a git worktree, created from an up-to-date
  `main`. (Claude Code's stricter phrasing lives in [CLAUDE.md](../CLAUDE.md).)
- **Use the pinned toolchain — Node 24 / npm 11** (`nvm use`). Older npm corrupts the
  lockfile (see [Updating dependencies](#updating-dependencies)); the repo enforces it via
  `engines` + `engine-strict`, and `make doctor` flags a wrong version with the fix.
- **Read [DESIGN.md](DESIGN.md) before non-trivial work** — it is the source of truth for
  architecture and the data model. Update it in the same PR if a change diverges.
- **Keep docs current in the same PR** as code that changes behavior, setup, commands, or
  architecture.
- **One command sets up local dev** (`make bootstrap`, above). **Stop at human-gated
  steps** — list them and pause rather than faking them.

### Human vs agent — what's automatable, where to stop

Marked with the `[YOU]` convention from [PROMPTS.md](PROMPTS.md).

**An agent can do autonomously:** install / build / typecheck / test, local
migrate / seed / user (`make bootstrap`), run the app (`make dev` + `make dev-web`), and —
*once a human has supplied credentials* (a non-interactive `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` in the environment) — the remote path: `make setup` (create
D1 + R2), `make migrate-remote`, `wrangler secret put <NAME>` from supplied values, and
`make deploy`.

**`[YOU]` (human-only — pause and list these; do not attempt them):**

- `[YOU]` Create a Cloudflare account and run `npx wrangler login` (interactive OAuth).
- `[YOU]` Enable R2 in the dashboard (one-time activation, payment method on file).
- `[YOU]` Add your domain as a Cloudflare zone and delegate nameservers at your registrar.
- `[YOU]` Upgrade to the Workers Paid plan ($5/mo) — argon2 login exceeds the free 10ms CPU cap.
- `[YOU]` Create a Resend account and verify your sending domain.

The philosophy mirrors the Phase-5 Domains panel: **automate via API, pause on
nameservers.**

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up). The free tier is enough
  to start (Phases 0–1), but the **Workers Paid plan ($5/mo) is required from Phase 2
  onward** — see the login note below.
- [Node.js](https://nodejs.org/) 22+ **and npm 11+**. An `.nvmrc` pins Node 24 (which
  ships npm 11); run `nvm use` to match it. The repo enforces this (`engines` +
  `engine-strict`), so installs refuse to run under npm 10 / Node 20 — older npm silently
  prunes platform-specific deps from the lockfile (see
  [Updating dependencies](#updating-dependencies)).
- `make` (optional but recommended; every `make` target prints the underlying command,
  so you can always run the raw `npx wrangler …` equivalent yourself)
- A domain you control, for receiving mail (needed from Phase 1 onward)
- A [Resend](https://resend.com) account, for sending mail (needed from Phase 3 onward)

> **Phase 2 needs the Workers Paid plan.** Login hashes passwords with argon2id, which
> costs ~150ms of CPU per sign-in. The Workers **free** plan caps CPU at **10ms per
> request**, so on the free plan a login is killed mid-hash and fails *even with the
> correct password*. The **Workers Paid plan ($5/mo)** raises the limit and is what
> mailbase targets (the [config](../packages/api/wrangler.jsonc) sets `limits.cpu_ms`
> to 1000). Receiving mail (Phases 0–1) works fine on the free plan. Upgrade under
> **Workers & Pages → Plans** in the dashboard before completing Phase 2.

Cost expectations: Cloudflare free tier covers Workers/D1/Email Routing at personal
volume; R2 is free up to 10 GB; Resend is free up to 3,000 emails/month; the Workers
Paid plan adds $5/mo and is required from Phase 2 (above). See
[DESIGN.md §7](DESIGN.md#7-costs-steady-state-personalsmall-team-volume).

## 1. Clone and install

```sh
git clone https://github.com/joaoh82/mailbase
cd mailbase
nvm use        # match the pinned Node 24 / npm 11 (.nvmrc)
make install   # runs `npm ci` — a clean, reproducible install from the lockfile
```

`make install` deliberately runs `npm ci` (not `npm install`): it installs exactly what
the committed `package-lock.json` specifies and never rewrites it, so a fresh clone or a
`git pull` is always one command with no lockfile churn. To add or upgrade a dependency,
see [Updating dependencies](#updating-dependencies).

## 2. Authenticate wrangler

```sh
npx wrangler login
```

This opens a browser window to authorize the Wrangler CLI against your Cloudflare
account.

## 3. Create the D1 database

```sh
npx wrangler d1 create mailbase
```

Copy the `database_id` from the output, then replace the existing `database_id` value
in **all three** of these files (the IDs in the repo belong to the upstream deployment
— they are harmless to know but useless to you):

- `wrangler.jsonc` (repo root)
- `packages/api/wrangler.jsonc`
- `packages/email-worker/wrangler.jsonc`

> `wrangler d1 create` may also append an extra `d1_databases` entry to the root
> `wrangler.jsonc`. You can delete it — only the `DB` binding entry is used.

## 4. Enable R2 and create the bucket

R2 needs one-time activation that the API cannot do for you: in the Cloudflare
dashboard, open **R2 Object Storage** in the left sidebar and click through the
enable flow (it requires a payment method on file, but the free tier costs $0).
If you skip this, the next command fails with error `10042`.

Then:

```sh
npx wrangler r2 bucket create mailbase-mail
```

(Or run both this step's command and step 3's via `make setup`.)

## 5. Apply the database schema

```sh
make migrate-remote
```

This runs every migration in `migrations/` against your D1 database. Re-running is
safe; already-applied migrations are skipped.

## 6. Set the attachment signing secret

Attachment downloads use signed, expiring URLs; the API worker needs an HMAC key:

```sh
openssl rand -hex 32 | npx wrangler secret put SIGNING_KEY -c packages/api/wrangler.jsonc
```

(Any long random string works; `wrangler secret put` also accepts interactive input.)

## 7. Deploy

```sh
make deploy
```

This deploys, in order: the email worker, the API worker, and the web worker (SPA
built first). The order matters once: `mailbase-web` binds to `mailbase-api` via a
service binding, so the API must exist before the first web deploy. Your workers
land at:

- `https://mailbase-api.<your-subdomain>.workers.dev/health` → `{"status":"ok"}`
- `https://mailbase-web.<your-subdomain>.workers.dev` → the webmail (login screen)
- `mailbase-email-worker` has no HTTP endpoint; it is invoked by Email Routing (Phase 1)

The web worker serves the SPA and proxies `/api/*` to `mailbase-api`, so the whole
app lives on the single `mailbase-web` origin — that is the URL you bookmark, and it
keeps the session cookie first-party.

## 8. Continuous deployment (optional)

If you host your fork on GitHub, the included workflow
(`.github/workflows/ci.yml`) builds, typechecks, and tests every push/PR on both
Linux and macOS (so a lockfile missing one platform's native deps fails CI, not your
clone), and on push to `main` applies migrations and deploys all three workers.

It needs two repository secrets (**Settings → Secrets and variables → Actions**):

| Secret                  | Where to get it |
| ----------------------- | --------------- |
| `CLOUDFLARE_API_TOKEN`  | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → start from the **"Edit Cloudflare Workers"** template → add **Account → D1 → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Right sidebar of any zone's overview page, or `npx wrangler whoami` |

Deploys only run for pushes to `main` in your own repo — fork PRs never see the
secrets.

## 9. Point a domain at Cloudflare

To receive mail (Phase 1+), your domain's DNS must be served by Cloudflare:

1. In the Cloudflare dashboard, **Add a domain** (zone). The free plan is fine.
2. At your registrar, replace the domain's nameservers with the two Cloudflare
   assigns you.
3. Wait for the zone to become **Active** (minutes to hours).

Use a low-value/test domain first.

## 10. Enable Email Routing and route mail to the worker

In the Cloudflare dashboard, on your domain's zone:

1. Open **Email → Email Routing** and click **Enable Email Routing**. Let it add the
   MX and SPF DNS records it proposes.
2. Under **Routing rules**, edit the **Catch-all address** rule: set the action to
   **Send to a Worker** and pick `mailbase-email-worker`, then enable the rule.

No per-address rules are needed — every address on the domain is one catch-all rule
pointing at the worker; who actually receives what is decided by the database rows
you seed next.

## 11. Seed your domain, mailbox, and addresses

```sh
make seed-remote DOMAIN=yourdomain.com MAILBOX=you
```

This inserts into your remote D1 database (see `scripts/seed.sql`):

- a `domains` row for `yourdomain.com` (with unknown recipients delivered, not rejected),
- one mailbox named after `MAILBOX` (defaults to `josh`),
- two addresses — `you@yourdomain.com` and `hello@yourdomain.com` — into that mailbox,
- a catch-all: any other address on the domain lands in the same mailbox.

To reject mail for unknown addresses instead of catch-all delivery:

```sh
npx wrangler d1 execute mailbase --remote -c packages/api/wrangler.jsonc \
  --command "UPDATE domains SET reject_unknown = 1, catch_all_mailbox_id = NULL WHERE name = 'yourdomain.com'"
```

Now send an email from any external account to `you@yourdomain.com` and verify it
landed:

```sh
npx wrangler d1 execute mailbase --remote -c packages/api/wrangler.jsonc \
  --command "SELECT from_addr, subject, snippet, has_attachments, datetime(date,'unixepoch') AS date FROM messages ORDER BY date DESC LIMIT 5"
# `r2 object get` takes one "{bucket}/{key}" path
npx wrangler r2 object get --remote --pipe \
  "mailbase-mail/$(npx wrangler d1 execute mailbase --remote -c packages/api/wrangler.jsonc --json \
     --command "SELECT r2_key FROM messages ORDER BY date DESC LIMIT 1" | grep r2_key | cut -d'"' -f4)"
```

The second command prints the raw `.eml` exactly as it arrived.

## 12. Create your webmail login and sign in

Accounts are created from the command line (there is deliberately no public
signup):

```sh
make user-remote EMAIL=you@yourdomain.com PASSWORD='a long passphrase' NAME="Your Name"
```

This hashes the password locally (argon2id) and inserts/updates the user in remote
D1, granting it membership of the seed mailbox (`MAILBOX_ID=...` to pick another).
Re-running with the same `EMAIL` resets the password.

Now open `https://mailbase-web.<your-subdomain>.workers.dev`, sign in with that
email and password, and read your mail: three-pane inbox, threads, search, stars,
archive/trash, attachment downloads. HTML mail renders in a sandboxed iframe with
remote images blocked until you click **Load images** on a message. For day-to-day use of
the webmail — composing, labels, shared inboxes, and adding domains/addresses from the UI —
see the [user guide](USER_GUIDE.md).

> If the correct password is rejected or sign-in hangs, confirm the account is on the
> **Workers Paid plan** (see Prerequisites): on the free plan the 10ms CPU limit kills
> the argon2id hash before login completes.

## 13. Enable sending with Resend

Outbound mail goes through [Resend](https://resend.com) (behind the `MailSender`
interface, so it can be swapped later). To send for real:

1. Create a Resend account and **add your domain** (Resend dashboard → **Domains → Add
   Domain**). Use the same domain you receive on.
2. Resend shows DKIM/SPF DNS records to add. Add them in the Cloudflare dashboard for
   your zone (**DNS → Records**), then click **Verify** in Resend. Wait for the domain
   to show **Verified**.
3. Create an API key (**API Keys → Create**) with send permission, and set it as a
   Worker secret:

   ```sh
   npx wrangler secret put RESEND_API_KEY -c packages/api/wrangler.jsonc
   ```

Without `RESEND_API_KEY` the API falls back to a mock sender: compose/send still works
and lands in the Sent folder, but nothing is delivered. With it set, mail is sent from
the address of the identity you choose in the composer.

> **Send-as identities.** You can only send from an address you have an *identity* for.
> `make user-*` (step 12) creates one identity per address in your seed mailbox, so your
> seeded addresses work immediately. As of Phase 4, adding someone to a mailbox (via an
> invite or the members panel — step 15) automatically mints their send-as identities for
> every address of that mailbox, so shared inboxes and aliases work with no manual SQL.

Now sign in, click **Compose**, format a line or two (bold, a bullet list, a link), and
send a message to an external account (e.g. your Gmail), then confirm it arrives with the
formatting intact. In Gmail's **Show original**, DKIM and SPF should both show **PASS**,
and the message is `multipart/alternative` (an HTML part plus a plaintext fallback).
Reply from Gmail and the reply lands back in your inbox, threaded with your sent message.

## 14. Bounce & complaint webhooks (optional)

Resend reports bounces and spam complaints via webhooks; wiring this up flags the
affected message in the webmail.

1. In Resend, **Webhooks → Add Webhook**. Set the endpoint to
   `https://mailbase-web.<your-subdomain>.workers.dev/api/webhooks/resend` and subscribe
   to the **`email.bounced`** and **`email.complained`** events.
2. Resend shows a signing secret (`whsec_…`). Set it as a Worker secret:

   ```sh
   npx wrangler secret put RESEND_WEBHOOK_SECRET -c packages/api/wrangler.jsonc
   ```

The endpoint verifies every request's Svix signature against this secret, so it is safe
to expose publicly. Messages that bounce or are marked as spam show a red notice in the
thread view.

## 15. Add more users, shared inboxes, and aliases (Phase 4)

mailbase is multi-user. Every read is scoped to your mailbox memberships and every send
to your identities, so users only ever see and send from what they belong to.

**Roles.** Each `mailbox_members` row has a role: `owner` or `member`. Both can read and
send; only an `owner` (or a global admin — a `users.is_admin = 1` account, which
`make user-*` creates) can manage a mailbox's membership. The first account you made in
step 12 is an admin.

**Invite a brand-new user.** As an owner/admin, open the mailbox in the webmail and click
**Manage** (next to the mailbox switcher). Enter the person's email, pick a role, and
click **Invite new user**. You get a one-time link (valid 7 days) to send them; they open
it, choose a password, and land signed in — already a member of that mailbox with send-as
identities for its addresses. No command-line user creation needed.

**Add an existing account to a shared inbox.** In the same **Manage** panel, enter their
email and click **Add existing account**. They immediately see the shared mailbox in their
switcher and can send as its address. Removing a member there also revokes their send-as
identities for that mailbox (the last owner can't be removed).

**Aliases** are just extra `addresses` rows pointing at the same mailbox (the seed already
adds a `hello@` alias). Every member of a mailbox automatically gets a send-as identity for
each of its addresses, so any alias is immediately usable as a from-address.

> Prefer the CLI? `make user-remote EMAIL=… PASSWORD=… MAILBOX_ID=…` still works for
> creating/attaching users directly, and is handy for the very first admin.

## 16. Add more domains from the admin UI (Phase 5)

Steps 9–13 walk you through your first domain by hand. From Phase 5, an admin
(`users.is_admin = 1`) can onboard **additional** domains end-to-end from the webmail —
no console, no CLI — using the **Domains** panel (the globe button at the bottom of the
sidebar). It drives the Cloudflare and Resend APIs for you; the one step that can't be
automated is delegating nameservers at your registrar, which the UI spells out.

### One-time: give mailbase API access to Cloudflare and Resend

The API worker needs two new secrets to provision domains. Without them the Domains
panel still works but runs in **simulation** (it records the domain row but provisions
nothing, and says so).

1. **Cloudflare API token.** Create one at
   [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   → Create Token → Custom token, with these **account-level** permissions so it can
   create zones and configure Email Routing/DNS:

   | Permission | Access |
   | ---------- | ------ |
   | Account → Zone | Edit |
   | Zone → Zone Settings | Edit |
   | Zone → DNS | Edit |
   | Zone → Email Routing Rules | Edit |
   | Zone → Email Routing Addresses | Edit |

   ```sh
   npx wrangler secret put CLOUDFLARE_API_TOKEN -c packages/api/wrangler.jsonc
   ```

2. **Cloudflare account id** (zones are created under it; `npx wrangler whoami` prints it):

   ```sh
   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID -c packages/api/wrangler.jsonc
   ```

3. **Resend key with domain access.** Domain registration reuses `RESEND_API_KEY`
   (step 13), but the key must have **Full access** (or at least domains write), not a
   send-only key. If yours is send-only, create a new key and re-set the secret.

> Optional: `EMAIL_WORKER_NAME` (defaults to `mailbase-email-worker`) if you renamed the
> inbound worker, and `RESEND_REGION` (defaults to `us-east-1`) to host new Resend
> domains in another AWS region. Both via `wrangler secret put` like above.

### Add a domain

1. Sign in as an admin and click **Domains** (sidebar) → **Add domain**. Enter the domain
   and a default mailbox name (e.g. `hello`). mailbase creates/reuses the Cloudflare zone,
   registers the domain with Resend, and inserts the `domains` row plus the default
   mailbox/address (you become its owner).
2. **Delegate nameservers (manual).** The panel shows the two Cloudflare nameservers —
   set them at your registrar (e.g. GoDaddy), replacing the existing ones. The zone stays
   **pending** until DNS propagates (minutes to hours); click **Status** to recheck.
3. Once the zone is **active**, click **Provision**. This enables Email Routing, points the
   catch-all rule at `mailbase-email-worker`, and writes Resend's DKIM/SPF records into the
   zone. It is idempotent — safe to re-run. If the apex still carries a non-Cloudflare MX
   record (e.g. a parked-domain null MX of `.`), Email Routing can't enable (Cloudflare
   error 2008) and the result offers **Remove it & retry** (mailbase deletes just that apex
   MX and re-provisions) or **I'll do it manually**; subdomain MX such as Resend's `send` is
   never touched.
4. Click **Verify** to have Resend re-check its records, and watch the status badges go
   green. Send a test message to `hello@yourdomain.com` to confirm inbound, and compose
   from the new address to confirm outbound (DKIM/SPF pass).
5. **Manage** the domain anytime from the same panel: add mailboxes and aliases, and set
   the catch-all policy (deliver unknown recipients to a mailbox, or reject them). New
   addresses automatically mint send-as identities for every member of their mailbox.

In the webmail, a **Domain** switcher (shown once you have mailboxes in more than one
domain) filters the mailbox list, and **All inboxes** shows every mailbox's mail in one
list, each message tagged with where it landed.

## Local development

**The fast path:** `make bootstrap` (or `npm run setup`) does the first four steps below
in one idempotent command — install, `.dev.vars`, migrate, seed, and create a login — and
prints the rest. `make doctor` diagnoses a broken local setup. The manual equivalent:

```sh
cp packages/api/.dev.vars.example packages/api/.dev.vars   # local SIGNING_KEY
make migrate-local   # apply migrations to the local Miniflare D1
make seed-local DOMAIN=yourdomain.com [MAILBOX=you]   # seed local D1
make user-local EMAIL=you@yourdomain.com PASSWORD=devpassword   # local login
make dev             # API worker on http://localhost:8787 (local D1/R2 bindings)
make dev-web         # webmail dev server on http://localhost:5173
make test            # run all tests
make typecheck       # type-check all workspaces
```

Run `make dev` and `make dev-web` side by side; Vite proxies `/api` to the API
worker on 8787, the same single-origin shape as production. Local mail to read can
be inserted by the email-worker tests or by seeding rows by hand.

Local state (D1 data, R2 objects) lives under `.wrangler/state/` and is gitignored.
Secrets for local dev go in `.dev.vars` files (gitignored) — never commit them; in
production use `wrangler secret put`. The API worker uses these secrets (see
`packages/api/.dev.vars.example`): `SIGNING_KEY` (required, signed attachment URLs),
`RESEND_API_KEY` (optional — unset uses the mock sender), `RESEND_WEBHOOK_SECRET`
(optional — only to verify bounce/complaint webhooks), and, for Phase 5 domain
provisioning, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (optional — unset runs the
Domains panel in simulation, provisioning nothing). Locally you'll usually leave the
Cloudflare/Resend secrets unset and let the admin UI simulate.

## Updating dependencies

Routine setup never edits `package-lock.json`: `make install` (`npm ci`) installs strictly
from the committed lockfile. **Only deliberately adding or upgrading a package should change
it.** When you do:

```sh
nvm use                       # Node 24 / npm 11 — required (see Prerequisites)
npm install <pkg>             # or `npm install` after editing a package.json by hand
git diff package-lock.json    # review what changed before committing
```

mailbase is developed on both macOS and Windows, and CI runs on Linux, so the lockfile must
carry **every** platform's optional native deps (e.g. `@rolldown/binding-darwin-arm64`,
`@rolldown/binding-linux-x64-gnu`, `@rolldown/binding-win32-x64-msvc`, and their
`@emnapi/*` / `@floating-ui/*` peers). `npm install` resolves for *your* platform and can
prune the others out of the lockfile — committing that breaks `npm ci` on the other OSes.

So after `npm install`, check the diff: if the only change is **removed** optional
`@emnapi/*`, `@floating-ui/*`, or `@rolldown/binding-*` entries for platforms other than
yours, that's spurious pruning — revert it:

```sh
git checkout package-lock.json   # then re-run only the line that adds the package you wanted
```

The Linux+macOS CI matrix is the backstop: a lockfile that drops a platform's native dep
fails `npm ci`/`npm run build` on that platform in CI rather than in someone's clone. Using
npm 11+ (the `engines` check enforces it) keeps this pruning to the handful of optional
peers above instead of the wider corruption npm 10 produces.

### Security overrides (`overrides` in `package.json`)

The root `package.json` carries an `overrides` block used to force a patched version of a
transitive dependency when the package that pulls it in hasn't bumped yet. Current entries:

- **`esbuild` → `0.28.1`** — `wrangler` and `@cloudflare/vitest-pool-workers` both pin
  esbuild to *exactly* `0.27.3`, which `npm audit` flags for two high-severity advisories
  ([GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr) — RCE via the
  Deno install path; [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)
  — arbitrary file read in esbuild's Windows dev server). Neither path is reachable here
  (we install via npm with an integrity-locked lockfile, never via Deno, and never run
  `esbuild.serve()`), and esbuild is **build/test tooling only** — it bundles the Workers
  and runs Vitest, and is never shipped into the Cloudflare Workers runtime. npm's only
  offered "fix" was a destructive downgrade of wrangler and vitest-pool-workers, so we pin
  esbuild up to the patched `0.28.1` (the vulnerable range ends at `0.28.0`) instead.

  **Remove this override** once both `wrangler` and `@cloudflare/vitest-pool-workers` depend
  on esbuild `> 0.28.0` on their own — check with `npm ls esbuild` after a dependency bump,
  delete the entry, run `npm install`, and confirm `npm audit` stays clean.

Adding or changing an override re-resolves the tree, so it triggers the same cross-platform
optional-peer pruning described above — review `git diff package-lock.json` and restore any
spuriously dropped `@emnapi/*` / `@floating-ui/*` / `@rolldown/binding-*` entries before
committing.

## Coming in later phases

Each of these will extend this guide when it ships (see the
[roadmap](ROADMAP.md) for the full picture):

- **Phase 6 — migrate & harden:** move remaining domains over, spam handling, DMARC
  tightening, rate limiting, scheduled R2 backups, and monitoring/alerting.
