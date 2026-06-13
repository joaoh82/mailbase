# Self-hosting mailbase

This guide walks you from a fresh clone to your own mailbase deployment on your own
Cloudflare account.

> **Kept current per phase.** This document tracks the project as it develops; each
> phase that changes setup adds its steps here. **Current as of Phase 3** — receiving
> works (mail to any address on your domain is parsed and stored in R2/D1), reading
> works (sign in, browse folders, read HTML mail safely, star/archive/trash, download
> attachments, search), and **sending works**: compose, reply/reply-all/forward with
> quoting, attachments, a Sent folder, and bounce/complaint flagging via webhooks.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up). The free tier is enough
  to start (Phases 0–1), but the **Workers Paid plan ($5/mo) is required from Phase 2
  onward** — see the login note below.
- [Node.js](https://nodejs.org/) 22+ and npm
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
(`.github/workflows/ci.yml`) typechecks and tests every push/PR, and on push to
`main` applies migrations and deploys all three workers.

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
remote images blocked until you click **Load images** on a message.

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
> `make user-*` (step 12) now creates one identity per address in your seed mailbox, so
> your seeded addresses work immediately. Adding more is a row in the `identities` table
> (`user_id` → `address_id`); a full UI for this arrives in Phase 4.

Now sign in, click **Compose**, send a message to an external account (e.g. your Gmail),
and confirm it arrives. In Gmail's **Show original**, DKIM and SPF should both show
**PASS**. Reply from Gmail and the reply lands back in your inbox, threaded with your
sent message.

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

## Local development

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
production use `wrangler secret put`. As of Phase 3 the API worker uses these secrets
(see `packages/api/.dev.vars.example`): `SIGNING_KEY` (required, signed attachment
URLs), `RESEND_API_KEY` (optional — unset uses the mock sender), and
`RESEND_WEBHOOK_SECRET` (optional — only to verify bounce/complaint webhooks).

## Coming in later phases

Each of these will extend this guide when it ships:

- **Phase 4 — multi-account & permissions:** shared inboxes, aliases, per-user send-as
  enforcement, an account switcher, and a UI for managing identities.
- **Phase 5 — multi-domain:** add further domains from the admin UI instead of this runbook.
