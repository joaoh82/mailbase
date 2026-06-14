# Roadmap

mailbase ships in phases. Each phase is a self-contained milestone that leaves the
project usable on its own. This page is the quick view of where things stand; the detailed
engineering plan and per-phase milestone definitions live in
[DESIGN.md §9](DESIGN.md#9-development-plan), and the self-hosting steps each phase adds
are tracked in [SELF_HOSTING.md](SELF_HOSTING.md).

**Status legend:** ✅ shipped · 🚧 in progress · ⬜ under consideration

## Shipped

### ✅ Phase 0 — Foundations
npm-workspaces monorepo, Wrangler config per worker, the full D1 schema + first migration,
the R2 bucket, and CI (GitHub Actions) that builds, typechecks, and tests on Linux + macOS,
and deploys all three workers on push to `main`. The toolchain is pinned (Node 24 / npm 11
via `.nvmrc` + `engines`), and `npm ci` installs reproducibly from the committed lockfile.

### ✅ Phase 1 — Inbound pipeline
The Email Worker: parse with `postal-mime` → resolve the envelope recipient to a mailbox →
store the raw `.eml` immutably in R2 → write metadata and attachments to D1 → create/update
the thread → update the FTS index. Unknown recipients follow the domain's catch-all or are
rejected. Storage failures throw so Cloudflare temp-fails rather than losing mail.

### ✅ Phase 2 — Read-only webmail
Auth (argon2id, D1-backed sessions, HttpOnly cookies, CSRF on mutations, rate-limited
login) and a three-pane React inbox: folder list, virtualized message list, threaded
conversation view, read/unread, star, archive/trash, full-text search, signed expiring
attachment URLs, and HTML rendered in a sandboxed iframe with remote images blocked behind
a per-message opt-in.

### ✅ Phase 3 — Sending
The `MailSender` interface with a Resend adapter (the only file allowed to import Resend).
Compose, reply / reply-all / forward with quoting, attachment upload, a Sent folder,
correct reply threading (`In-Reply-To` / `References`), and bounce/complaint flagging via
Resend webhooks.

### ✅ Phase 4 — Multi-account & permissions
Shared inboxes, aliases, and `owner` / `member` roles, with every read scoped to the
caller's mailbox memberships and every send scoped to their identities. An account/mailbox
switcher in the UI, and a one-time invite-link flow to onboard brand-new accounts.

### ✅ Phase 5 — Multi-domain automation
The admin **Domains** panel: add a domain end-to-end (Cloudflare zone / Email Routing /
catch-all → email worker, and Resend domain / DKIM/SPF records, all via API), manage a
domain's mailboxes, addresses, and catch-all policy, and watch live verification status.
A domain switcher and a unified **"all inboxes"** view in the webmail. The one step that
can't be automated — delegating nameservers at the registrar — is surfaced in the UI.

## In progress

### 🚧 Phase 6 — Migrate & harden
Moving real domains over one at a time (and retiring Google Workspace), plus production
hardening:

- **Spam handling** — start by trusting Cloudflare's inbound filtering plus an allow/block
  list; later, classify in the Worker.
- **DMARC tightening** to `p=quarantine` once deliverability is stable.
- **Rate limiting** on login and the API.
- **Scheduled R2 backups** (export on a cron).
- **Monitoring & error alerting** via Workers analytics.

**Milestone:** Google bill = $0, and a month of daily use without touching the console.

## Under consideration

Explicitly out of scope for now, but the architecture (raw mail in R2 as the source of
truth) leaves room for these — see
[DESIGN.md §8](DESIGN.md#8-future-options-explicitly-out-of-scope-now):

- **⬜ IMAP/SMTP bridge** — a small VPS reading the same R2/D1, so Outlook / Thunderbird /
  phone apps work without re-architecting.
- **⬜ Cloudflare Email Service for outbound** — drop Resend for an all-Cloudflare stack
  once it's generally available.
- **⬜ Push / real-time inbox** — live updates via Durable Objects or polling. A manual
  **Refresh** button in the message list already ships as the low-risk baseline; this layers
  live updates on top.
- **⬜ End-to-end encryption and on-device LLM features.**

---

Found a bug or have an idea? Open an issue or a pull request — see
[Contributing](../README.md#contributing).
