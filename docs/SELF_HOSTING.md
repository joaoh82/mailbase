# Self-hosting mailbase

This guide walks you from a fresh clone to your own mailbase deployment on your own
Cloudflare account.

> **Kept current per phase.** This document tracks the project as it develops; each
> phase that changes setup adds its steps here. **Current as of Phase 1** — that means
> receiving works: mail sent to any address on your domain is parsed, stored in R2/D1,
> and ready for the webmail UI that arrives with Phase 2.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is enough to start)
- [Node.js](https://nodejs.org/) 22+ and npm
- `make` (optional but recommended; every `make` target prints the underlying command,
  so you can always run the raw `npx wrangler …` equivalent yourself)
- A domain you control, for receiving mail (needed from Phase 1 onward)
- A [Resend](https://resend.com) account, for sending mail (needed from Phase 3 onward)

Cost expectations: Cloudflare free tier covers Workers/D1/Email Routing at personal
volume; R2 is free up to 10 GB; Resend is free up to 3,000 emails/month. See
[DESIGN.md §7](DESIGN.md#7-costs-steady-state-personalsmall-team-volume).

## 1. Clone and install

```sh
git clone https://github.com/joaoh82/mailbase
cd mailbase
make install
```

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

## 6. Deploy

```sh
make deploy
```

This deploys, in order: the email worker, the API worker, and the web SPA (built
first). Your workers land at:

- `https://mailbase-api.<your-subdomain>.workers.dev/health` → `{"status":"ok"}`
- `https://mailbase-web.<your-subdomain>.workers.dev` → placeholder page
- `mailbase-email-worker` has no HTTP endpoint; it is invoked by Email Routing (Phase 1)

## 7. Continuous deployment (optional)

If you host your fork on GitHub, the included workflow
(`.github/workflows/ci.yml`) typechecks and tests every push/PR, and on push to
`main` applies migrations and deploys all three workers.

It needs two repository secrets (**Settings → Secrets and variables → Actions**):

| Secret                  | Where to get it |
| ----------------------- | --------------- |
| `CLOUDFLARE_API_TOKEN`  | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → start from the **"Edit Cloudflare Workers"** template → add **Account → D1 → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Right sidebar of any zone's overview page, or `npx wrangler whoami` |

Deploys only run for pushes to `main` in your own repo — fork PRs never see the
secrets.

## 8. Point a domain at Cloudflare

To receive mail (Phase 1+), your domain's DNS must be served by Cloudflare:

1. In the Cloudflare dashboard, **Add a domain** (zone). The free plan is fine.
2. At your registrar, replace the domain's nameservers with the two Cloudflare
   assigns you.
3. Wait for the zone to become **Active** (minutes to hours).

Use a low-value/test domain first.

## 9. Enable Email Routing and route mail to the worker

In the Cloudflare dashboard, on your domain's zone:

1. Open **Email → Email Routing** and click **Enable Email Routing**. Let it add the
   MX and SPF DNS records it proposes.
2. Under **Routing rules**, edit the **Catch-all address** rule: set the action to
   **Send to a Worker** and pick `mailbase-email-worker`, then enable the rule.

No per-address rules are needed — every address on the domain is one catch-all rule
pointing at the worker; who actually receives what is decided by the database rows
you seed next.

## 10. Seed your domain, mailbox, and addresses

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

## Local development

```sh
make migrate-local   # apply migrations to the local Miniflare D1
make seed-local DOMAIN=yourdomain.com [MAILBOX=you]   # seed local D1
make dev             # API worker on a local port, with local D1/R2 bindings
make dev-web         # web SPA dev server on http://localhost:5173
make test            # run all tests
make typecheck       # type-check all workspaces
```

Local state (D1 data, R2 objects) lives under `.wrangler/state/` and is gitignored.
Secrets for local dev go in `.dev.vars` files (gitignored) — never commit them; in
production use `wrangler secret put`. No secrets are needed as of Phase 0.

## Coming in later phases

Each of these will extend this guide when it ships:

- **Phase 2 — webmail:** create your login user; session signing secret.
- **Phase 3 — sending:** verify your domain at Resend, set the `RESEND_API_KEY` secret.
- **Phase 5 — multi-domain:** add further domains from the admin UI instead of this runbook.
