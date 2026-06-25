# mailbase user guide

How to do everyday things in the mailbase webmail — read and send mail, organize with
folders and labels, manage shared inboxes, and (as an admin) add domains and addresses.

This guide is about **using** an already-running mailbase. If you're setting one up from
scratch on your own Cloudflare account, start with
[SELF_HOSTING.md](SELF_HOSTING.md) instead. For architecture and the data model, see
[DESIGN.md](DESIGN.md).

> **Who can do what.** Most tasks here are for any signed-in user. A few are gated:
> managing a shared inbox's members, signature, or labels needs the **owner** role on that
> mailbox (or a global admin); adding/managing **domains** needs a global **admin**
> (`users.is_admin = 1`). Gated tasks are marked **(owner)** or **(admin)** below.

## Contents

- [Signing in](#signing-in)
- [The layout at a glance](#the-layout-at-a-glance)
- [Reading mail](#reading-mail)
- [Searching](#searching)
- [Organizing: folders, stars, and labels](#organizing-folders-stars-and-labels)
- [Sending mail](#sending-mail)
- [Signatures](#signatures)
- [Live updates and refreshing](#live-updates-and-refreshing)
- [Working across multiple mailboxes and domains](#working-across-multiple-mailboxes-and-domains)
- [Shared inboxes: invite people and manage members (owner)](#shared-inboxes-invite-people-and-manage-members-owner)
- [Add a new domain (admin)](#add-a-new-domain-admin)
- [Create a new email address (admin)](#create-a-new-email-address-admin)
- [Quick reference](#quick-reference)

---

## Signing in

Open your mailbase URL (for a deployed instance, `https://mailbase-web.<subdomain>.workers.dev`;
for local dev, `http://localhost:5173`) and sign in with your **email and password**.

There's deliberately no public sign-up. Your account is created either by an admin
inviting you (you'll get a one-time link — see
[shared inboxes](#shared-inboxes-invite-people-and-manage-members-owner)) or from the
command line during setup. If you were invited, open the link, choose a password, and
you're signed straight in.

> If your correct password is rejected or sign-in hangs on a deployed instance, the
> Cloudflare account is likely on the Workers **free** plan — its 10 ms CPU limit kills the
> argon2id password hash mid-login. The fix is the $5/mo Workers Paid plan (see
> [SELF_HOSTING.md](SELF_HOSTING.md#prerequisites)).

## The layout at a glance

mailbase is a three-pane webmail:

- **Sidebar (left):** the **Compose** button, the domain and mailbox switchers, your
  folders (Inbox / Archive / Sent / Spam / Trash), this mailbox's labels, and — at the
  bottom — **Domains** (admins only), **Signature** (settings), your name, and **Sign out**.
- **Message list (middle):** a search box, the current folder/label, a **Refresh** button,
  and the list of messages. Scroll to the bottom to load older mail.
- **Reading pane (right):** the selected conversation, with per-message actions across the
  top (background toggle, reply, forward, label, star, archive, trash).

## Reading mail

- **Open a message:** click it in the middle list. It opens in the reading pane and is
  marked read automatically. Conversations are threaded — the message you clicked is
  expanded and earlier ones are collapsed; click a collapsed message to expand it.
- **HTML mail is sandboxed.** Messages render in an isolated frame, and **remote images are
  blocked by default** (a privacy measure — remote images can track when you open mail).
  Click **Load images** in the bar above the message to load them for that message.
- **Email background:** by default the email body sits on a **white** canvas. The **palette**
  icon in a message's action row toggles it to **blended** — a dark default that matches the
  rest of the app, so unstyled mail no longer floats as a bright white card. Emails that set
  their own background (most rich HTML newsletters) keep it, so they stay readable; if a
  blended message ever looks wrong, flip it back to white. The choice is per-browser and can
  also be set in **Signature** (sidebar) → **Reading pane**.
- **Attachments** appear as chips at the bottom of a message. Click one to download it
  (downloads go through short-lived signed URLs).
- **Mark read/unread:** use the envelope button in a message's action row. Unread messages
  have a blue dot and bold text in the list; the Inbox shows an unread count badge.
- **Bounce/spam notices:** if a message you sent bounced or was marked as spam, the thread
  shows a red banner saying so.

## Searching

Type in the **search box** at the top of the message list and press Enter. Search is
full-text over the selected mailbox (subjects and bodies, via SQLite FTS5). Clear it with
the **✕** in the box to return to the folder view.

Search is scoped to the currently selected mailbox, so it's hidden in the unified **All
inboxes** view — pick a specific mailbox to search it.

## Organizing: folders, stars, and labels

**Folders** are the fixed set every mailbox has: **Inbox, Archive, Sent, Spam, Trash**.
Move a message between them from its action row in the reading pane:

- **Archive** takes it out of the Inbox without deleting it.
- **Trash** moves it to Trash; from Trash you can move it **back to Inbox**.
- Each message lives in exactly one folder.

**Stars** flag a message for yourself. Click the star in the list row or the reading pane
to toggle it.

**Labels** are Gmail-style tags that layer *on top of* folders — a message keeps its
folder and can carry any number of labels. Labels are **per mailbox** and **shared** with
everyone on that mailbox.

- **Apply/remove a label on a message:** open it, click the **tag** button in the action
  row, and check/uncheck labels in the dropdown. Applied labels show as colored chips on
  the message and its list row; click a chip's **✕** to remove it.
- **Filter by label:** click a label under **Labels** in the sidebar to show only that
  mailbox's messages carrying it. Click a folder to clear the filter.
- **Create, rename, recolor, or delete labels:** click **Manage** next to **Labels** in the
  sidebar. Pick a name and an optional color, then **Add**. Any mailbox member can manage
  labels (they're shared, like the mailbox's signature). Deleting a label removes it from
  every message but never deletes the messages.

## Sending mail

Click **Compose** in the sidebar (or **Reply / Reply all / Forward** on an open message).
The composer opens with:

- **From** — pick which of your addresses to send as. You can only send from addresses you
  belong to (your *send-as identities*). Changing From swaps in that address's signature.
- **To**, and **Cc/Bcc** (click **Cc/Bcc** to reveal them) — comma- or semicolon-separated
  addresses.
- **Subject**.
- A **rich-text body** — bold, italic, bullet and numbered lists, headings, and links. The
  message goes out as real HTML with a plain-text fallback.
- **Attach** — add one or more files; remove a queued one with its **✕**.

Click **Send**. Sent mail lands in your **Sent** folder and threads correctly with replies.
Press **Esc** to discard and close the composer.

- **Reply** answers the sender; **Reply all** also Ccs the other recipients (minus your own
  addresses); **Forward** prefills the body with the original message and an `Fwd:` subject.
- Replies and forwards quote the original text so the recipient has context.

> Sending needs the instance to be wired to Resend. If it isn't (or you're in local dev),
> compose still works and lands in Sent, but nothing is delivered — see
> [SELF_HOSTING.md → Enable sending](SELF_HOSTING.md#13-enable-sending-with-resend).

## Signatures

A signature is appended to the bottom of mail you send. There are two levels:

- **Per-address signature:** click **Signature** at the bottom of the sidebar to open
  Settings. Pick an address (if you have more than one), edit the rich-text signature, and
  **Save signature**. This is the signature for mail sent from that address.
- **Mailbox default signature (owner):** set in the mailbox's **Manage** panel (see below).
  It's used for any of the mailbox's addresses that don't have their own signature.

An empty per-address signature falls back to the mailbox default. In the composer, the
right signature is inserted automatically and swaps when you change the From address.

## Live updates and refreshing

The inbox **updates on its own** — a lightweight poll refetches in place when new mail
arrives or the unread count changes, and it also refreshes the moment you return to the
browser tab, so you rarely refresh by hand.

- **Change the cadence:** **Signature** (sidebar) → **Live updates** → *Check for new mail*.
  The choice is per-browser; pick **Off** to rely only on manual refresh.
- **Refresh now:** click the circular **Refresh** button above the message list, or press
  **`r`** (when you're not typing and no dialog is open). This re-fetches without a full
  page reload.

## Working across multiple mailboxes and domains

If you belong to more than one mailbox, the sidebar has switchers:

- **Mailbox switcher:** choose a specific mailbox, or **📥 All inboxes** to see every
  mailbox's mail in one list (each row tagged with the mailbox it landed in). Folders and
  the unread badge follow your selection.
- **Domain switcher** (appears only when your mailboxes span more than one domain): narrow
  the mailbox list to a single domain, or **All domains**.

The **All inboxes** view is read-and-triage across everything at once; switch to a single
mailbox to search it or to see and manage its labels.

## Shared inboxes: invite people and manage members (owner)

A mailbox can be shared by several people. Each member has a role — **owner** or **member**
(both read and send; only owners and admins manage membership).

If you can manage the selected mailbox, a **Manage** link (people icon) appears next to the
mailbox switcher. It opens a panel where you can:

- **See current members** and their roles, and **Remove** someone (the last owner can't be
  removed).
- **Invite a brand-new person:** enter their email, pick a role, and click **Invite new
  user**. You get a **one-time link (valid 7 days)** — send it to them; they open it, choose
  a password, and land signed in, already a member with send-as identities for the mailbox's
  addresses.
- **Add an existing account:** enter their email and click **Add existing account** — they
  immediately see the shared mailbox and can send from its addresses.
- **Set the mailbox's default signature** (see [Signatures](#signatures)).

Removing a member also revokes their send-as identities for that mailbox.

## Add a new domain (admin)

Domains, mailboxes, and addresses are just database rows — adding one **never redeploys**.
As an admin, click **Domains** (the globe at the bottom of the sidebar) → **Add domain**.

1. **Add the domain.** Enter the domain (e.g. `example.com`) and a **default mailbox** name
   (e.g. `hello`). mailbase creates or reuses the Cloudflare zone, registers the domain with
   Resend, and inserts the domain row plus `hello@example.com`, making you its owner.
2. **Delegate nameservers (manual — the one step that can't be automated).** The panel shows
   two Cloudflare nameservers. At your domain registrar (GoDaddy, Namecheap, etc.), replace
   the domain's nameservers with those two. The zone stays **pending** until DNS propagates
   (minutes to hours).
3. **Provision.** Once the zone is **active** (click **Status** to recheck), open the domain
   and click **Provision**. This enables Email Routing, points the catch-all at the inbound
   email worker, and writes Resend's DKIM/SPF records into the zone. It's safe to re-run.
   - **Conflicting MX records.** If the zone apex already has a non-Cloudflare MX record (for
     example a parked-domain "null MX" of `.`), Email Routing can't enable and the result
     shows a prompt: **Remove it & retry** lets mailbase delete just the offending apex MX
     and re-provision, or **I'll do it manually** steps aside so you can remove it in the
     Cloudflare DNS panel and click **Provision** again. Subdomain MX records (such as
     Resend's `send`) are never touched.
4. **Verify.** Click **Verify** to have Resend re-check its records, and watch the three
   status badges — **Cloudflare zone**, **Email Routing**, **Resend** — go green. Send a test
   message to `hello@example.com` to confirm inbound, and compose from the new address to
   confirm outbound.
5. **Set the catch-all policy.** Under **Unknown recipients**, choose to **deliver** mail for
   any unlisted address to a mailbox, or **reject** unknown addresses. **Save policy**.

> **Simulation mode.** If the instance doesn't have Cloudflare/Resend API credentials set,
> the panel records the domain row but provisions nothing and shows an amber "simulation"
> banner. An operator sets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and a
> full-access `RESEND_API_KEY` to provision for real — see
> [SELF_HOSTING.md → Add more domains](SELF_HOSTING.md#16-add-more-domains-from-the-admin-ui-phase-5).
> A domain set up by hand instead shows as **manual**: nothing to provision, but you can
> still manage its mailboxes, addresses, and policy.

## Create a new email address (admin)

"An email address" can mean two things in mailbase; here's how to do each.

### A new address or mailbox on a domain

In **Domains** → open the domain → the **Mailboxes** section:

- **New mailbox** (its own inbox): type a name in **new mailbox name** and click **Add
  mailbox**. This creates `name@domain` with its own inbox; you become its owner.
- **Alias** (another address that delivers into an existing mailbox): click **+ alias** on a
  mailbox, type the local part, and **add**. Aliases are extra addresses pointing at the same
  inbox — e.g. `sales@` and `hello@` both landing in one mailbox.

Every member of the mailbox automatically gets a **send-as identity** for each of its
addresses, so a new address or alias is immediately usable as a From address. Remove an
address with its **✕**, or delete a whole mailbox with its trash icon.

### A new person's login

A login is a *user account*, created by giving someone access to a mailbox — there's no
separate "create user" screen. Open the mailbox's **Manage** panel and either **Invite new
user** (sends a one-time signup link) or **Add existing account**, as described under
[shared inboxes](#shared-inboxes-invite-people-and-manage-members-owner). The very first
admin account is created from the command line during setup
(`make user-*` — see [SELF_HOSTING.md](SELF_HOSTING.md#12-create-your-webmail-login-and-sign-in)).

## Quick reference

| Task | Where |
| --- | --- |
| New message | **Compose** (sidebar) |
| Reply / Reply all / Forward | message action row (reading pane) |
| Search a mailbox | search box (top of message list); Enter to run, ✕ to clear |
| Archive / Trash / move back to Inbox | message action row |
| Star / unstar | star icon in the list row or reading pane |
| Mark read / unread | envelope icon in the message action row |
| Load remote images | **Load images** bar above the message body |
| White ⇄ blended email background | **palette** icon in the message action row, or **Signature** (sidebar) → **Reading pane** |
| Download an attachment | attachment chip at the bottom of a message |
| Apply/remove a label | **tag** icon in the message action row |
| Filter by label | click a label under **Labels** (sidebar) |
| Create/edit labels | **Manage** next to **Labels** (sidebar) |
| Edit your signature | **Signature** (sidebar) → Settings |
| Change auto-update cadence | **Signature** (sidebar) → **Live updates** |
| Refresh now | Refresh button above the list, or press **`r`** |
| Switch mailbox / all inboxes | **Mailbox** switcher (sidebar) |
| Switch domain | **Domain** switcher (sidebar; shown with >1 domain) |
| Invite/add members, mailbox signature | **Manage** next to the mailbox switcher *(owner)* |
| Add or manage a domain | **Domains** (sidebar) *(admin)* |
| Add a mailbox or alias | **Domains** → open domain → **Mailboxes** *(admin)* |

---

Spotted something out of date or missing? The docs are part of the code — open an issue or
a PR (see [Contributing](../README.md#contributing)).
