# Claude Code Prompts — phase by phase

Run Claude Code from the repo root. Feed one prompt per session (or `/clear` between
phases). Don't skip the verification step at the end of each phase. Manual steps you must
do yourself are marked **[YOU]**.

---

## Phase 0 — Foundations

**[YOU] first:** create a Cloudflare account, add a low-value test domain as a zone, point
its GoDaddy nameservers at Cloudflare, and run `wrangler login`.

```
Read CLAUDE.md and docs/DESIGN.md. Implement Phase 0 only.

Set up the npm-workspaces monorepo exactly per the layout in CLAUDE.md: four packages
(email-worker, api, web, shared), root tsconfig with strict mode, Vitest configured with
@cloudflare/vitest-pool-workers, and a wrangler config per worker package with D1 and R2
bindings (database: mailbase, bucket: mailbase-mail). Create migration 0001 implementing
the full D1 schema from DESIGN.md §4 including the FTS5 table, and the matching Drizzle
schema in packages/shared. Each worker should deploy with a trivial handler (health check
for api, log-only for email-worker, placeholder page for web). Add a GitHub Actions
workflow that typechecks, tests, and deploys on push to main.

Walk me through the wrangler commands to create the D1 database and R2 bucket, then stop
so I can run them and the deploys. Done means: typecheck and tests pass, migrations apply
locally, and all three workers deploy.

Do not start Phase 1.
```

---

## Phase 1 — Inbound pipeline

**[YOU] first:** enable Email Routing on the test domain in the Cloudflare dashboard and
add a catch-all rule pointing at the deployed email-worker.

```
Read CLAUDE.md and docs/DESIGN.md. Phase 0 is done. Implement Phase 1 only: the inbound
email pipeline in packages/email-worker, per DESIGN.md §5 "Inbound".

Parse with postal-mime; resolve the envelope recipient via addresses → mailboxes in D1;
store the raw message immutably in R2 under {domain}/{mailboxId}/{messageId}.eml; extract
attachments to R2; insert messages + attachments rows; create or update the thread using
normalized subject + References/In-Reply-To; update the FTS index. Unknown recipient: route
to the domain's catch_all_mailbox_id, or setReject() if reject_unknown is set. On any
storage failure, throw so Cloudflare temp-fails the message rather than losing it.

Add a seed script (or documented SQL) that creates my test domain, one mailbox, and a
couple of addresses. Write Vitest tests covering: plain text, HTML+attachments, multiple
recipients, unknown recipient (both catch-all and reject paths), and malformed MIME.

Done means: tests pass, and you give me a short manual test plan (send real emails from
Gmail/Outlook, including a large attachment) with queries to verify the rows and R2
objects. Do not start Phase 2.
```

---

## Phase 2 — Read-only webmail

This is the biggest phase; consider splitting it into 2a (API) and 2b (UI) sessions.

```
Read CLAUDE.md and docs/DESIGN.md. Phases 0–1 are done. Implement Phase 2 only: auth +
read-only webmail.

API (packages/api, Hono): signup-by-invite is out of scope; seed one user. Implement
login/logout with argon2id and D1-backed sessions (HttpOnly cookie, CSRF on mutations),
rate-limited login; endpoints for: list mailboxes the user can access, paginated message
list per mailbox+folder, thread view, full message (lazy HTML/raw fetched from R2), signed
expiring attachment URLs, mark read/unread, star, move to archive/trash, and FTS search.

Web (packages/web, React+Vite+Tailwind+shadcn): login screen; three-pane inbox (folders /
virtualized message list / thread view); HTML email rendered in a sandboxed iframe with
strict CSP, remote images blocked behind a per-message "load images" toggle; read/star/
archive/trash actions; search box.

Done means: typecheck/tests pass, plus a checklist for me: log in, read a real HTML email
safely, download an attachment, search finds an older message. Do not start Phase 3.
```

---

## Phase 3 — Sending

**[YOU] first:** create a Resend account, add and DKIM-verify the test domain, and set the
API key via `wrangler secret put RESEND_API_KEY` (and in `.dev.vars` locally).

```
Read CLAUDE.md and docs/DESIGN.md. Phases 0–2 are done. Implement Phase 3 only: outbound
mail per DESIGN.md §5 "Send".

Define the MailSender interface in packages/shared and a Resend adapter (the only file
that may import Resend). API: send endpoint that enforces the user owns the chosen
identity, stores the sent message (direction=outbound, folder=sent, raw copy to R2), and
threads replies correctly (In-Reply-To/References). Webhook endpoint for Resend bounces/
complaints that flags the affected message. Web: compose modal with to/cc/bcc, reply /
reply-all / forward with quoting, attachment upload to R2.

Done means: tests pass (mock MailSender in tests — never hit Resend), and a manual
checklist: send to my Gmail, verify DKIM/SPF pass in "show original", reply from Gmail and
confirm it threads. Do not start Phase 4.
```

---

## Phase 4 — Multi-account & permissions

```
Read CLAUDE.md and docs/DESIGN.md. Phases 0–3 are done. Implement Phase 4 only.

Wire users/identities/mailbox_members end to end: shared inboxes (multiple users on one
mailbox, role column enforced), aliases (multiple addresses → one mailbox), per-user
send-as enforcement via identities, an account/mailbox switcher in the UI, and an invite
flow (admin creates invite, new user sets password via one-time link).

Every API endpoint must be re-checked for mailbox-membership scoping — add tests proving a
user cannot read or send from a mailbox they don't belong to.

Done means: tests pass; checklist: second user logs in, sees only their mailbox plus the
shared support@ inbox, and is blocked from sending as me. Do not start Phase 5.
```

---

## Phase 5 — Multi-domain automation

**[YOU] first:** create a Cloudflare API token (Zone:Edit + Email Routing:Edit) and a
Resend key with domain permissions; add both as worker secrets.

```
Read CLAUDE.md and docs/DESIGN.md. Phases 0–4 are done. Implement Phase 5 only: the admin
UI and the "add a domain" automation per DESIGN.md §5 runbook.

Admin-only section in the web app: add domain (calls Cloudflare API to enable Email
Routing + catch-all rule to the email-worker, calls Resend API to register the domain and
create the DNS records, inserts the domains row + default mailbox), manage mailboxes/
addresses/catch-all policy per domain, and show domain verification status. Add a domain
switcher and a unified "all inboxes" view to the webmail.

Nameserver delegation at GoDaddy stays manual — surface clear instructions in the UI
instead. Done means: tests pass and I can onboard a real second domain end-to-end from the
UI with no CLI. Do not start Phase 6.
```

---

## Phase 6 — Hardening (recurring sessions, pick one item each)

```
Read CLAUDE.md and docs/DESIGN.md. Phases 0–5 are done. From DESIGN.md §9 Phase 6, work on
exactly one item this session: [PICK ONE: spam allow/block lists | DMARC tightening to
p=quarantine | scheduled R2 backup export | API rate limiting | error alerting via Workers
analytics]. Propose a brief plan first, wait for my OK, then implement with tests.
```

---

## Tips

- One phase per session; `/clear` between phases so stale context doesn't leak.
- If a phase goes sideways, it's cheaper to `git reset` and re-run the prompt than to
  debug a mess interactively.
- Commit (or let Claude Code commit) at every green checkpoint inside a phase.
- When you change your mind about the design, update docs/DESIGN.md first, then prompt.
