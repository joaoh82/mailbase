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
| Compose editor | **Tiptap** (ProseMirror) in `packages/web`, lazy-loaded | Small WYSIWYG: bold/italic/lists/headings/links → HTML email; code-split into its own async chunk so it stays out of the initial bundle (MAIL-6) |
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
                  resend_verified BOOL, cloudflare_zone_id, resend_domain_id,
                  created_at)
                  -- cloudflare_zone_id/resend_domain_id (Phase 5): provider
                  -- handles for domains added via the admin UI; '' for domains
                  -- seeded by hand, which the UI labels "managed manually".
users            (id, email_login, password_hash, display_name, is_admin, created_at)
sessions         (id, user_id, token_hash, expires_at, created_at)
mailboxes        (id, domain_id, name, display_name, signature, created_at) -- e.g. "josh", "support"
                  -- display_name: From name on outbound mail (MAIL-22); it WINS over the
                  --   sending identity's display_name, so a shared inbox sends under one
                  --   name. '' falls back to the sender's own identity display_name.
                  -- signature: default HTML signature for the mailbox (Phase 3+/MAIL-4)
addresses        (id, domain_id, local_part, mailbox_id)      -- josh@, j@, hello@ → one mailbox
mailbox_members  (mailbox_id, user_id, role)                  -- shared inboxes; role ∈ {owner, member}
identities       (id, user_id, address_id, display_name,      -- who may send as what
                  signature)                                  -- per-identity HTML signature
                  -- (MAIL-4); '' falls back to the owning mailbox's signature.
invites          (id, token_hash, email, mailbox_id, role,    -- one-time onboarding link (Phase 4):
                  invited_by, expires_at, accepted_at,        -- owner/admin creates it, the invitee
                  created_at)                                 -- sets a password to claim the account
messages         (id, mailbox_id, r2_key, thread_id, direction, from_addr, to_addrs,
                  subject, snippet, body_text, has_attachments, size, date,
                  is_read, is_starred, folder, created_at, message_id_header,
                  provider_message_id, delivery_status)
                  -- provider_message_id/delivery_status: outbound only; the
                  -- send provider's id + bounce/complaint state (Phase 3).
attachments      (id, message_id, filename, mime_type, size, r2_key)
threads          (id, mailbox_id, subject_norm, last_message_at, message_count)
labels           (id, mailbox_id, name, color, created_at)         -- user-defined labels
                  -- (MAIL-16), scoped to a shared mailbox; unique (mailbox_id, name).
message_labels   (message_id, label_id)                            -- many-to-many join,
                  -- composite pk (message_id, label_id); both FKs cascade-delete.
events           (id, mailbox_id, message_id NULL, uid, sequence,   -- calendar invites
                  organizer_addr, summary, description, location,   -- (iCalendar/iMIP,
                  starts_at, ends_at NULL, all_day, tzid, status,   -- Phase 7 / MAIL-25)
                  rrule, method, raw_ics_r2_key, created_at, updated_at)
                  -- unique (mailbox_id, uid): a re-sent invite reconciles by UID, a
                  -- higher SEQUENCE supersedes, CANCEL flips status. Times in UTC; raw
                  -- .ics in R2 is the source of truth. message_id ON DELETE SET NULL.
event_attendees  (event_id, addr, display_name, partstat, role, is_self)
                  -- composite pk (event_id, addr); FK cascades from events. is_self
                  -- marks the mailbox's own line, driving RSVP rendering + the REPLY echo.
messages_fts     (FTS5 virtual table over subject, from_addr, body_text)
```

Folder model: a simple `folder` enum per message (`inbox`, `sent`, `archive`, `trash`, `spam`).
**Labels** (MAIL-16) are an additive layer on top — a flat, many-to-many tagging system, not
a folder replacement. A label belongs to a shared mailbox (so it's visible to and managed by
every member, like signatures), and a label may only be applied to a message in the same
mailbox, so labels never cross the multi-domain boundary. The inbox can be filtered to one
label, and label chips show on rows and in the reading pane. Threading: normalize subject +
`References`/`In-Reply-To` headers (each message's own `Message-ID` is stored in
`message_id_header` so those lookups work).

Access model (Phase 4): every mailbox/message/thread read is scoped to the caller's
`mailbox_members` rows — nothing outside your memberships is reachable. Sending is scoped to
`identities` (you may only send from an address you have an identity for). Adding a member to a
mailbox mints an identity for each of that mailbox's addresses, so shared-inbox members and
aliases just work. `role` gates *management* (inviting users, adding/removing members, and
setting the mailbox `display_name`): only a mailbox `owner` or a global `is_admin` user may
manage a mailbox. New logins are onboarded via a one-time `invites` link; existing accounts are
added to shared mailboxes directly.

From name on outbound mail (MAIL-22): the mailbox `display_name` is the shared identity of a
role/team inbox and **wins** over the sender's per-identity `display_name`, so every member's
mail goes out as `Display Name <addr@domain>` under one name. It is required when an admin
creates a mailbox and editable by an owner afterwards; when it is `''` (the default mailbox a
new domain ships with, and legacy rows) the From falls back to the sender's own identity name.
The composer's From dropdown applies the same precedence so its preview matches what is sent.

---

## 5. Core Flows

### Inbound
1. Email Routing invokes Email Worker with envelope + raw stream.
2. Worker parses with postal-mime; resolves `rcpt to` → `addresses` → `mailbox`.
3. Unknown address → domain catch-all mailbox, or `message.setReject()` if domain says reject.
4. Store raw `.eml` in R2; extract attachments to R2; insert `messages` + `attachments` rows;
   update/create thread; update FTS index. Deliveries are deduplicated per mailbox by
   Message-ID (alias fan-out arrives once per envelope recipient; senders may retry after
   success), enforced by a unique index on `(mailbox_id, message_id_header)`.
5. Failures: Worker throws → Cloudflare retries / sender gets 4xx temp-fail, so mail isn't lost.

### Read (webmail)
1. SPA authenticates (session cookie) → API Worker. The web worker serves the SPA
   assets and proxies `/api/*` to the API Worker over a service binding, so both
   share one origin and the HttpOnly SameSite=Lax cookie stays first-party (no CORS,
   no third-party-cookie problems). Vite's dev proxy mirrors this locally.
2. List: paginated query on `messages` by mailbox + folder. Body text from D1; full original
   (HTML, raw) lazily fetched from R2 through the API.
3. HTML email rendered in a sandboxed iframe (`sandbox`, CSP, no external loads by default,
   "load remote images" opt-in) — standard webmail XSS hygiene. The iframe body background
   is a per-browser preference (MAIL-15): **white** (the default, always-legible canvas) or
   **blended**, which gives the body a dark default (`#0f172a` bg, `#e2e8f0` text,
   `color-scheme:dark`) matching the app chrome. The dark default is applied as a plain
   `body{}` rule — no `!important`, no targeting of email markup — so any background the
   email declares wins and rich HTML mail stays legible; only unstyled / plaintext-derived
   mail picks up the dark canvas. The preference lives in `localStorage` (no migration/API,
   like the poll cadence) and is set from Settings or a per-message header toggle; the
   sandbox and CSP are unchanged by it.

### Live updates (polling)
The inbox refreshes itself without a manual click (MAIL-14). The SPA polls a cheap
`GET /api/mailboxes/changes` endpoint — one row per mailbox the user belongs to, each
carrying `latestAt` (the max message `created_at`, epoch seconds, across every folder) and
the inbox `unread` count — every ~30s by default while the tab is visible, and immediately
on tab focus / visibility regain. The cadence is a per-browser preference set in Settings
(Off / 15s / 30s / 1m / 5m, stored in `localStorage` — no migration or API; "Off" leaves
just the manual Refresh). The client keeps the last signal; only when it moves does it
reuse the manual **Refresh** path (MAIL-13) to refetch the active view and the folder badges
in place. The probe is membership-scoped through the same query path as every other read, so
a user is never notified about mailboxes they can't access. It is one small grouped query per
tick and degrades gracefully: a failed poll just retries next tick, and the manual Refresh
(`r`) keeps working if polling is unavailable.

What it catches: new mail (any folder bumps `latestAt`) and unread-badge changes. What it
does **not** catch, by design: a star/move done in *another* session (those change neither
`latestAt` nor the unread count) — manual Refresh covers that. The Durable-Objects WebSocket
push in §8 is the planned next increment for sub-second latency; it would reuse this same
refetch path, with polling as the fallback when a socket is unavailable. No new bindings or
secrets are required for the polling baseline.

### Send
1. SPA composes in a rich-text editor; the API validates the user owns the chosen
   identity. The composer sends an HTML body plus a plaintext fallback. A
   **signature** is auto-inserted at compose time (MAIL-4): the chosen identity's
   signature, else the owning mailbox's default, else none. On a new message it
   sits at the bottom; on a reply/forward it sits above the quoted history, and
   changing the From identity swaps it in place. Signatures are sanitized HTML
   embedded in the body, so the derived plaintext fallback includes them too.
2. The API sanitizes the outbound HTML to a safe allowlist (`sanitizeOutboundHtml` in
   `packages/shared`) — we never trust the client — and derives the canonical plaintext
   from it, so every message is a proper `multipart/alternative`.
3. API calls Resend HTTP API (domain already DKIM-verified at Resend).
4. Store a copy in `messages` with `direction=outbound`, `folder=sent` (+ raw copy to R2).
5. Bounces/complaints: Resend webhooks → API Worker → mark message, surface in UI.

### Add a new domain (runbook → now a button)
1. Add zone to Cloudflare; point GoDaddy nameservers at it.
2. Enable Email Routing; create catch-all rule → Email Worker (API call).
3. Add domain at Resend; create the DKIM/SPF DNS records (API call).
4. Insert `domains` row + default mailbox/addresses.
**Phase 5 implements this as the admin "Domains" panel:** step 1's zone is created
(or reused) via the Cloudflare API and steps 2–4 run via API too; the only manual
step is delegating nameservers at the registrar, which the UI surfaces with the
exact nameservers to set. See `docs/SELF_HOSTING.md` §16.

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
| Cloudflare Email Routing, Workers, Pages | Free tier for Phases 0–1; **Workers Paid $5/mo required from Phase 2** (argon2id login exceeds the free plan's 10ms CPU limit) |
| R2 | Free ≤10 GB, then ~$0.015/GB-mo |
| D1 | Free tier covers this comfortably |
| Resend | Free ≤3,000 emails/mo, ≤100/day |
| Domains | Already owned (GoDaddy renewal unchanged) |

≈ **$0/month** for Phases 0–1; **$5/mo** once the webmail (Phase 2) is live, since
login needs the Workers Paid plan. Hard ceiling around $5–10/mo at much higher volume.

---

## 8. Future Options (explicitly out of scope now)

- **IMAP bridge:** small VPS (Hetzner/Oracle free tier) running a Node IMAP server that reads
  R2/D1 — enables Outlook/Thunderbird/phone apps without re-architecting (VCMail's Oracle
  server pattern).
- **Cloudflare Email Service** for outbound once GA → drop Resend, all-Cloudflare.
- **Push/real-time:** a **polling baseline ships today** (MAIL-14 — see §5 "Live updates");
  Durable Objects + Hibernatable WebSockets are the planned next increment for sub-second
  push, reusing the same refetch path with polling as the fallback.
- **E2E encryption, on-device LLM** (the VCMail headline features) — layer on top later.

---

## 9. Development Plan

> For the quick, status-at-a-glance view of these phases, see
> [ROADMAP.md](ROADMAP.md). This section is the detailed plan and milestone
> definitions.

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

### Phase 7 — Calendar (iCalendar / iMIP) — planned

Receive, display, RSVP to, and send meeting invites by email, with a per-mailbox **Calendar**
view in the webmail. Tracked as **MAIL-23** (umbrella) → MAIL-24…31. Layered onto the existing
inbound→R2/D1→webmail pipeline; **no new Cloudflare products** — it reuses the Email Worker,
D1, R2, the Hono API, the SPA, and the `MailSender`/Resend outbound path.

**Standards.** Email scheduling is **iMIP** (RFC 6047): an ordinary email carrying an
**iCalendar** (RFC 5545) payload with a `METHOD` — `REQUEST` (invite), `REPLY` (RSVP),
`CANCEL`. Scheduling semantics are **iTIP** (RFC 5546). The iCalendar `UID` (not the email
`Message-ID`) is the stable identity across updates and `SEQUENCE` is the revision counter.
This matters because Resend rewrites our outbound `Message-ID` (see §3 / SELF_HOSTING), so the
calendar `UID` — never the mail header — is the source of truth for identity and dedup.

**Parsing — decided in MAIL-24: use `ical.js`** (the Mozilla/kewisch library) to read
VEVENTs. It is the only candidate that is cleanly Cloudflare-Workers-safe (zero production
deps, ~22 KB gzipped, no Node built-ins) with battle-tested RFC 5545 correctness. `node-ical`
is rejected: its Temporal-polyfill dependency chain (~150–180 KB) is not Workers-safe and buys
nothing in v1 (we do not expand recurrence). A hand-rolled parser is a viable fallback but
earns no advantage over a 22 KB dependency. Timezones: register the invite's `VTIMEZONE` and
convert to UTC for storage; for an invite that carries a bare `TZID` with no `VTIMEZONE`, fall
back to `Intl.DateTimeFormat` (native in Workers) for the offset. All-day (`VALUE=DATE`)
events are floating and must **never** be timezone-shifted.

**Data model.** Two new mailbox-scoped tables (built in MAIL-25):
```sql
events            (id, mailbox_id, message_id NULL, uid, sequence, organizer_addr,
                   summary, description, location, starts_at, ends_at, all_day,
                   tzid, status, rrule NULL, method, raw_ics_r2_key, created_at, updated_at)
                   -- UNIQUE (mailbox_id, uid): a re-sent/updated invite reconciles by UID;
                   --   a higher SEQUENCE replaces, a CANCEL flips status. Scoped by
                   --   mailbox_id like every other table (multi-domain invariant).
event_attendees   (event_id, addr, display_name, partstat, role, is_self)
                   -- is_self marks the mailbox's own ATTENDEE line for RSVP rendering/echo.
```
The raw `.ics` is stored verbatim in R2 (source of truth, like the raw `.eml`); the rows are
derived and rebuildable from it.

**Inbound flow.** The Email Worker detects a `text/calendar` part (inline part and/or `.ics`
attachment — `postal-mime` surfaces both), parses the VEVENT, and upserts
`events`/`event_attendees` by `(mailbox_id, uid)` inside the existing atomic D1 batch — as a
best-effort step: a calendar-parse failure must **never** drop the mail (same discipline as the
postal-mime try/catch). A later same-`UID` higher-`SEQUENCE` REQUEST replaces the event; a
`CANCEL` flips `status` to cancelled.

**RSVP / send flow.** An RSVP builds a `METHOD:REPLY` iCalendar (echoing `UID`/`SEQUENCE`, our
single `ATTENDEE` line with the chosen `PARTSTAT`) addressed to the organizer; creating an
invite builds `METHOD:REQUEST`; an edit bumps `SEQUENCE`; a cancel sends `CANCEL`. All go out
through the existing `MailSender`, and the sent copy is stored like any outbound message.

**Outbound iMIP constraint — decided in MAIL-24 (important).** Resend exposes only
`html` / `text` / `attachments`; it does **not** let us add an inline `text/calendar`
`multipart/alternative` sibling, which is what makes Gmail/Outlook render native RSVP buttons in
the reading pane. The v1 recipe is therefore to **attach** the `.ics` with
`content_type: "text/calendar; method=REQUEST; charset=UTF-8"` and content as a UTF-8 buffer:
Gmail is tolerant (recognizes the invite / offers add-to-calendar), but **Outlook is unreliable
with attachment-only calendars** (resend-node #198). First-class inline iMIP likely needs a
transport with raw-MIME control (an SMTP/Nodemailer-style `alternatives` sender, or Cloudflare
Email Service once GA) behind a second `MailSender` implementation — the interface already gives
us that seam. **A live send to real Gmail + Outlook inboxes must verify the recipe before the
send sub-tickets (MAIL-29/30) commit to it** (see SELF_HOSTING / the MAIL-24 decision record).

**Recurrence — v1 scope (decided in MAIL-24).** Store the raw `RRULE`, render only the master
instance, and mark recurring invites as such. Full expansion (`EXDATE` / `RECURRENCE-ID`
overrides) is an explicit follow-up.

**UI.** An invite **RSVP card** in the reading pane (Accept / Tentative / Decline, reflecting
the current self `PARTSTAT`) and a per-mailbox **Calendar** view (month / week / agenda,
honoring the active-mailbox / unified "all inboxes" selection), lazy-loaded into its own chunk
like the Tiptap editor (MAIL-6).

**Milestone:** an invite from Gmail/Outlook/Apple Calendar lands as an RSVP card **and** a
Calendar event; Accept/Tentative/Decline sends a standards-compliant `REPLY` the organizer's
calendar ingests; a mailbase-created invite renders in Gmail/Outlook as a real invitation with
working RSVP; updates/cancels reconcile by `UID`; timezones and all-day events render
correctly — all mailbox-membership-scoped.
