# Multi-Domain Webmail on Cloudflare — Design Document

A self-hosted, multi-domain, multi-account email platform built on Cloudflare's developer
platform. Inspired by VCMail's architecture (inbound MX → function → storage → webmail →
outbound relay) but with one deployment serving every domain, instead of one stack per domain.

**Working name:** `mailbase` (rename freely)

---

## 1. Goals & Non-Goals

### Goals
- Receive and send email on unlimited domains for ~$0–5/month (replace Google Workspace).
- One deployment, one database, one webmail URL — domains and accounts are *data*, not infrastructure.
- Multiple user accounts per domain; aliases, shared inboxes, and catch-all support.
- Adding a new domain is configuration only (eventually a button in an admin UI), never a redeploy.
- Web client first. No IMAP/SMTP server initially.

### Non-Goals (for now)
- IMAP/POP3/SMTP access for Outlook/Thunderbird/phone apps (possible later via a VPS bridge
  reading the same storage — see §8).
- End-to-end encryption and LLM features (VCMail's headline features) — deferred to a later phase.
- Serving other people as a product (multi-tenant SaaS hardening, billing, abuse handling).

---

## 2. Architecture Overview

```
                    INBOUND                                 OUTBOUND
┌──────────┐   ┌──────────────────┐   ┌─────────────┐   ┌────────────┐
│ Internet │──▶│ Cloudflare Email │──▶│ Email Worker │   │   Resend   │──▶ Internet
│  (SMTP)  │   │ Routing (MX, all │   │ parse, file, │   │  (HTTP API │
└──────────┘   │ domains, catch-  │   │ store        │   │  per-domain│
               │ all rules)       │   └──────┬───────┘   │  DKIM)     │
               └──────────────────┘          │           └─────▲──────┘
                                             ▼                 │
                              ┌────────────────────────┐       │
                              │  R2: raw .eml blobs    │       │
                              │  D1: metadata, users,  │◀──────┤
                              │      mailboxes, threads│       │
                              └───────────┬────────────┘       │
                                          │                    │
                                          ▼                    │
                              ┌────────────────────────┐       │
                              │  API Worker (Hono)     │───────┘
                              │  REST + auth + send    │
                              └───────────┬────────────┘
                                          │ HTTPS/JSON
                                          ▼
                              ┌────────────────────────┐
                              │  React SPA (webmail)   │
                              │  mail.<primary>.com    │
                              │  domain/account switch │
                              └────────────────────────┘
```

### Key design decisions

1. **One Email Worker for all domains.** Every domain's catch-all rule points at the same
   Worker. The Worker reads the envelope recipient, looks up the address → mailbox mapping in
   D1, stores the raw message in R2, and writes parsed metadata to D1. Unknown addresses go to
   the domain's catch-all mailbox or are rejected, per-domain setting.
2. **Raw email is the source of truth.** Full RFC 5322 messages stored verbatim in R2
   (`{domain}/{mailboxId}/{messageId}.eml`). D1 holds only parsed metadata + body text for
   listing/search. Re-parsing or future IMAP bridges always work from the raw blob.
3. **Domains and accounts are rows.** `domains`, `users`, `mailboxes`, `addresses`,
   `mailbox_members` tables. Adding a domain or account never touches code.
4. **Outbound is abstracted.** A thin `MailSender` interface with a Resend implementation.
   Swappable for Postmark/SES/Cloudflare Email Service later without touching callers.
5. **Auth is first-party.** Email + password, salted hash (scrypt/argon2 via WebCrypto-friendly
   lib), session tokens in D1, HttpOnly cookies. Passkeys/2FA later.

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| DNS / domains | Cloudflare (registration stays at GoDaddy; nameservers → Cloudflare) | Free, full API for automating new domains |
| Inbound MX | Cloudflare Email Routing (catch-all → Worker) | Free, unlimited addresses, per-domain rules |
| Inbound processing | Cloudflare **Email Worker** (TypeScript) | Serverless SES→Lambda equivalent |
| Email parsing | `postal-mime` | De-facto standard MIME parser for Workers |
| Raw storage | **R2** | S3-compatible, zero egress fees |
| Metadata / app DB | **D1** (SQLite) + Drizzle ORM | Relational, free tier generous, FTS5 for search |
| API | **Hono** on a Worker | Tiny, fast, the standard Workers framework |
| Webmail UI | **React** (Vite SPA) on Cloudflare Pages/Workers assets | Chosen; biggest ecosystem |
| UI components | Tailwind CSS + shadcn/ui | Fast path to a clean inbox UI |
| Outbound | **Resend** (behind `MailSender` interface) | Chosen; simple multi-domain DKIM, free 3k/mo |
| Auth | Email + password, sessions in D1 | Chosen; no third-party identity |
| Attachments | R2 (same bucket, `attachments/` prefix) | Served via signed URLs from API Worker |
| Tooling | TypeScript everywhere, Wrangler, Vitest + Miniflare | Standard Cloudflare dev loop |
| CI/CD | GitHub Actions → `wrangler deploy` | Push-to-deploy |

**Monorepo layout**

```
mailbase/
├── packages/
│   ├── email-worker/     # inbound: Email Routing handler
│   ├── api/              # Hono REST API + auth + send
│   ├── web/              # React SPA
│   └── shared/           # types, D1 schema, MailSender interface
├── migrations/           # D1 SQL migrations
└── wrangler.toml(s)
```

---

## 4. Data Model (D1)

```sql
domains          (id, name, catch_all_mailbox_id NULL, reject_unknown BOOL,
                  resend_verified BOOL, created_at)
users            (id, email_login, password_hash, display_name, is_admin, created_at)
sessions         (id, user_id, token_hash, expires_at, created_at)
mailboxes        (id, domain_id, name, created_at)            -- e.g. "josh", "support"
addresses        (id, domain_id, local_part, mailbox_id)      -- josh@, j@, hello@ → one mailbox
mailbox_members  (mailbox_id, user_id, role)                  -- shared inboxes, permissions
identities       (id, user_id, address_id, display_name)      -- who may send as what
messages         (id, mailbox_id, r2_key, thread_id, direction, from_addr, to_addrs,
                  subject, snippet, body_text, has_attachments, size, date,
                  is_read, is_starred, folder, created_at, message_id_header)
attachments      (id, message_id, filename, mime_type, size, r2_key)
threads          (id, mailbox_id, subject_norm, last_message_at, message_count)
messages_fts     (FTS5 virtual table over subject, from_addr, body_text)
```

Folder model: a simple `folder` enum per message (`inbox`, `sent`, `archive`, `trash`, `spam`)
plus labels later if wanted. Threading: normalize subject + `References`/`In-Reply-To` headers
(each message's own `Message-ID` is stored in `message_id_header` so those lookups work).

---

## 5. Core Flows

### Inbound
1. Email Routing invokes Email Worker with envelope + raw stream.
2. Worker parses with postal-mime; resolves `rcpt to` → `addresses` → `mailbox`.
3. Unknown address → domain catch-all mailbox, or `message.setReject()` if domain says reject.
4. Store raw `.eml` in R2; extract attachments to R2; insert `messages` + `attachments` rows;
   update/create thread; update FTS index.
5. Failures: Worker throws → Cloudflare retries / sender gets 4xx temp-fail, so mail isn't lost.

### Read (webmail)
1. SPA authenticates (session cookie) → API Worker.
2. List: paginated query on `messages` by mailbox + folder. Body text from D1; full original
   (HTML, raw) lazily fetched from R2 through the API.
3. HTML email rendered in a sandboxed iframe (`sandbox`, CSP, no external loads by default,
   "load remote images" opt-in) — standard webmail XSS hygiene.

### Send
1. SPA composes; API validates the user owns the chosen identity.
2. API calls Resend HTTP API (domain already DKIM-verified at Resend).
3. Store a copy in `messages` with `direction=outbound`, `folder=sent` (+ raw copy to R2).
4. Bounces/complaints: Resend webhooks → API Worker → mark message, surface in UI.

### Add a new domain (runbook → later a button)
1. Add zone to Cloudflare; point GoDaddy nameservers at it.
2. Enable Email Routing; create catch-all rule → Email Worker (API call).
3. Add domain at Resend; create the DKIM/SPF DNS records (API call).
4. Insert `domains` row + default mailbox/addresses.
Steps 2–4 are fully API-automatable — Phase 5 wraps them in an admin UI.

---

## 6. Security Notes

- Session cookies: HttpOnly, Secure, SameSite=Lax; CSRF token for mutations.
- Password hashing: argon2id (WASM) or scrypt; rate-limit login (Workers KV counter or Turnstile).
- HTML email sandboxing as above; attachments served with `Content-Disposition: attachment`
  and signed, expiring URLs.
- Secrets (Resend key, session signing key) in Worker secrets, never in the repo.
- D1 access only through the API Worker; R2 bucket private.
- SPF/DKIM/DMARC records per domain (Resend handles DKIM; add DMARC `p=quarantine` once stable).

---

## 7. Costs (steady state, personal/small-team volume)

| Item | Cost |
|---|---|
| Cloudflare Email Routing, Workers, Pages | Free tier (Workers paid plan $5/mo only if needed) |
| R2 | Free ≤10 GB, then ~$0.015/GB-mo |
| D1 | Free tier covers this comfortably |
| Resend | Free ≤3,000 emails/mo, ≤100/day |
| Domains | Already owned (GoDaddy renewal unchanged) |

≈ **$0/month** initially; hard ceiling around $5–10/mo at much higher volume.

---

## 8. Future Options (explicitly out of scope now)

- **IMAP bridge:** small VPS (Hetzner/Oracle free tier) running a Node IMAP server that reads
  R2/D1 — enables Outlook/Thunderbird/phone apps without re-architecting (VCMail's Oracle
  server pattern).
- **Cloudflare Email Service** for outbound once GA → drop Resend, all-Cloudflare.
- **Push/real-time:** Durable Objects or polling → live inbox updates.
- **E2E encryption, on-device LLM** (the VCMail headline features) — layer on top later.

---

## 9. Development Plan

### Phase 0 — Foundations (a weekend)
- Move one test domain's nameservers to Cloudflare (use a low-value domain first).
- Monorepo scaffold, Wrangler config, D1 database + initial migration, R2 bucket.
- CI: GitHub Actions deploy on push.
- **Milestone:** `wrangler deploy` works; schema applied; test domain live on Cloudflare DNS.

### Phase 1 — Inbound pipeline (≈1 week part-time)
- Email Worker: parse → resolve address → store raw to R2 → metadata to D1 → attachments.
- Catch-all rule on the test domain; seed mailboxes/addresses by SQL.
- Test with real emails from Gmail/Outlook senders, big attachments, weird MIME.
- **Milestone:** mail sent to anything@testdomain.com reliably lands in D1/R2.

### Phase 2 — Read-only webmail (≈2–3 weeks; the bulk of UI work)
- API Worker: sessions, login, message list/detail/thread endpoints, attachment URLs.
- React SPA: login, folder list, message list (virtualized), thread view, sandboxed HTML
  rendering, read/unread, star, archive/trash, search (FTS5).
- **Milestone:** you stop checking that domain's mail anywhere else.

### Phase 3 — Sending (≈3–4 days)
- Resend domain verification; `MailSender` interface + Resend impl.
- Compose UI (to/cc/bcc, reply/reply-all/forward with quoting, attachments upload to R2).
- Sent folder, bounce webhook handling.
- **Milestone:** full send/receive loop on one domain; reply threading correct.

### Phase 4 — Multi-account & permissions (≈1 week)
- Users/identities/mailbox_members fully wired: shared inboxes, aliases, per-user
  send-as enforcement, account switcher in UI, user invitations.
- **Milestone:** second user with their own mailbox + a shared support@ inbox.

### Phase 5 — Multi-domain automation (≈1 week)
- Admin UI: add domain (Cloudflare zone/Email Routing/Resend via API), manage mailboxes,
  addresses, catch-all policy per domain.
- Domain switcher in webmail; unified "all inboxes" view.
- **Milestone:** onboard a real second domain end-to-end from the UI, no console/CLI.

### Phase 6 — Migrate & harden (ongoing)
- Move remaining domains over one at a time; cancel Google Workspace.
- Spam handling (start: trust Cloudflare's inbound filtering + an allow/block list; later:
  classify in the Worker), DMARC tightening, rate limiting, backups (R2 → scheduled export),
  monitoring (Workers analytics + error alerting).
- **Milestone:** Google bill = $0; a month of daily use without touching the console.

**Suggested order of attack: 0 → 1 → 2 → 3 on a single throwaway domain, then 4 → 5, then
migrate real domains in 6.** Phases 1–3 give a usable single-user product fast; everything
after is multiplying it out.
