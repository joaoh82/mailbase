import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// Drizzle mirror of migrations/0001_initial_schema.sql. Migrations are the
// source of truth for DDL; keep this file in sync with them.

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  catchAllMailboxId: text("catch_all_mailbox_id").references(
    (): AnySQLiteColumn => mailboxes.id,
  ),
  rejectUnknown: integer("reject_unknown", { mode: "boolean" })
    .notNull()
    .default(false),
  resendVerified: integer("resend_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  // Provider handles (migration 0007): the Cloudflare zone and Resend domain a
  // domain was provisioned into from the admin UI. '' for manually-seeded
  // domains, which the admin UI labels "managed manually".
  cloudflareZoneId: text("cloudflare_zone_id").notNull().default(""),
  resendDomainId: text("resend_domain_id").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  emailLogin: text("email_login").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull().default(""),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    // Per-session CSRF token (migration 0004): returned to the SPA at login
    // and via /api/auth/me, required in X-CSRF-Token on mutations.
    csrfToken: text("csrf_token").notNull().default(""),
  },
  (table) => [index("idx_sessions_user").on(table.userId)],
);

// Fixed-window login rate limiting (migration 0004), keyed by IP + email.
export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start", { mode: "timestamp" }).notNull(),
  count: integer("count").notNull().default(0),
});

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Human-friendly From name for outbound mail (migration 0010, MAIL-22): the
    // shared identity of this inbox, e.g. "Painel News". It WINS over the
    // sender's per-identity display_name, so every member sends under the
    // mailbox's name. '' falls back to the sending identity's own display_name.
    displayName: text("display_name").notNull().default(""),
    // Default signature (migration 0008): HTML appended to outgoing mail when a
    // sending identity in this mailbox has no signature of its own. '' = none.
    signature: text("signature").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("mailboxes_domain_id_name_unique").on(
      table.domainId,
      table.name,
    ),
    index("idx_mailboxes_domain").on(table.domainId),
  ],
);

export const addresses = sqliteTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("addresses_domain_id_local_part_unique").on(
      table.domainId,
      table.localPart,
    ),
    index("idx_addresses_mailbox").on(table.mailboxId),
  ],
);

export const mailboxMembers = sqliteTable(
  "mailbox_members",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.userId] }),
    index("idx_mailbox_members_user").on(table.userId),
  ],
);

export const identities = sqliteTable(
  "identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addressId: text("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull().default(""),
    // Per-identity signature (migration 0008): HTML appended to outgoing mail
    // sent as this identity. Takes precedence over the mailbox default; '' =
    // fall back to the owning mailbox's signature.
    signature: text("signature").notNull().default(""),
  },
  (table) => [
    uniqueIndex("identities_user_id_address_id_unique").on(
      table.userId,
      table.addressId,
    ),
    index("idx_identities_user").on(table.userId),
  ],
);

// Roles a user can hold in a mailbox (mailbox_members.role). "owner" may manage
// the mailbox's membership and create invites into it; "member" can read and
// send-as but not manage. Global users.is_admin overrides this everywhere.
export const MAILBOX_ROLES = ["owner", "member"] as const;
export type MailboxRole = (typeof MAILBOX_ROLES)[number];

// One-time invitation to onboard a new login into a mailbox (migration 0006).
// The token itself is never stored; only its SHA-256 hash, like sessions.
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    role: text("role", { enum: MAILBOX_ROLES }).notNull().default("member"),
    invitedBy: text("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("idx_invites_mailbox").on(table.mailboxId)],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    subjectNorm: text("subject_norm").notNull(),
    lastMessageAt: integer("last_message_at", { mode: "timestamp" }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
  },
  (table) => [
    index("idx_threads_mailbox_recency").on(
      table.mailboxId,
      table.lastMessageAt,
    ),
    index("idx_threads_mailbox_subject").on(table.mailboxId, table.subjectNorm),
  ],
);

export const MESSAGE_FOLDERS = [
  "inbox",
  "sent",
  "archive",
  "trash",
  "spam",
] as const;
export type MessageFolder = (typeof MESSAGE_FOLDERS)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull().unique(),
    threadId: text("thread_id").references(() => threads.id),
    direction: text("direction", { enum: MESSAGE_DIRECTIONS }).notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddrs: text("to_addrs", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    hasAttachments: integer("has_attachments", { mode: "boolean" })
      .notNull()
      .default(false),
    size: integer("size").notNull().default(0),
    date: integer("date", { mode: "timestamp" }).notNull(),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    isStarred: integer("is_starred", { mode: "boolean" })
      .notNull()
      .default(false),
    folder: text("folder", { enum: MESSAGE_FOLDERS })
      .notNull()
      .default("inbox"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    // RFC 5322 Message-ID without angle brackets; '' when the header is absent.
    messageIdHeader: text("message_id_header").notNull().default(""),
    // Outbound only (migration 0005): the provider's (Resend) id for the
    // accepted message, used to correlate bounce/complaint webhooks; '' inbound.
    providerMessageId: text("provider_message_id").notNull().default(""),
    // '' for inbound and freshly-sent mail; 'bounced' / 'complained' once a
    // webhook reports a problem, surfaced in the webmail.
    deliveryStatus: text("delivery_status").notNull().default(""),
  },
  (table) => [
    index("idx_messages_mailbox_folder_date").on(
      table.mailboxId,
      table.folder,
      table.date,
    ),
    index("idx_messages_thread").on(table.threadId),
    index("idx_messages_mailbox_message_id").on(
      table.mailboxId,
      table.messageIdHeader,
    ),
    index("idx_messages_provider_message_id").on(table.providerMessageId),
    // One copy of a message per mailbox; '' (no Message-ID) is exempt.
    uniqueIndex("idx_messages_mailbox_msgid_unique")
      .on(table.mailboxId, table.messageIdHeader)
      .where(sql`message_id_header != ''`),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull().unique(),
  },
  (table) => [index("idx_attachments_message").on(table.messageId)],
);

// User-defined labels (migration 0009): a flat, many-to-many tagging layer on
// top of the folder enum (labels are additive, folders untouched). Scoped to a
// shared mailbox — visible to and managed by every member of that mailbox, like
// signatures/members/identities — so authorization reuses the same membership
// checks. A label may only be applied to a message in the same mailbox.
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Optional UI color: '' (default chip styling) or a "#rrggbb" hex value.
    color: text("color").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("labels_mailbox_id_name_unique").on(
      table.mailboxId,
      table.name,
    ),
    index("idx_labels_mailbox").on(table.mailboxId),
  ],
);

// Join table for the message ↔ label many-to-many. Rows cascade-delete when
// either the message or the label is deleted.
export const messageLabels = sqliteTable(
  "message_labels",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.labelId] }),
    // "messages with label X"; the reverse ("labels on message Y") is the PK.
    index("idx_message_labels_label").on(table.labelId),
  ],
);

// Calendar event status (migration 0011): the iCalendar STATUS, normalized.
export const EVENT_STATUSES = ["confirmed", "cancelled", "tentative"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

// Attendee participation status (iCalendar PARTSTAT), normalized to lowercase.
export const ATTENDEE_PARTSTATS = [
  "needs-action",
  "accepted",
  "tentative",
  "declined",
] as const;
export type AttendeePartstat = (typeof ATTENDEE_PARTSTATS)[number];

// Calendar events from iCalendar/iMIP invites (migration 0011, Phase 7). The raw
// .ics is the source of truth in R2; these rows are derived. Identity is the
// iCalendar UID (not the email Message-ID), reconciled per mailbox: a higher
// SEQUENCE supersedes, a CANCEL flips status. Times are stored in UTC; tzid keeps
// the original zone for display; all_day events are floating (never tz-shifted).
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    // The message this invite arrived on; null for invites we originate or after
    // the message is deleted (so purging mail keeps the event).
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    uid: text("uid").notNull(),
    sequence: integer("sequence").notNull().default(0),
    organizerAddr: text("organizer_addr").notNull().default(""),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    // Null when the invite carries no DTEND/DURATION.
    endsAt: integer("ends_at", { mode: "timestamp" }),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    tzid: text("tzid").notNull().default(""),
    status: text("status", { enum: EVENT_STATUSES })
      .notNull()
      .default("confirmed"),
    // Raw RRULE, stored verbatim; '' = non-recurring (v1 renders master only).
    rrule: text("rrule").notNull().default(""),
    method: text("method").notNull().default(""),
    rawIcsR2Key: text("raw_ics_r2_key").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Reconcile a re-sent/updated invite by UID within a mailbox.
    uniqueIndex("events_mailbox_id_uid_unique").on(table.mailboxId, table.uid),
    // Calendar range queries over a [from, to] window.
    index("idx_events_mailbox_starts").on(table.mailboxId, table.startsAt),
    // "the event for this message" — the reading-pane RSVP card.
    index("idx_events_message").on(table.messageId),
  ],
);

// Per-event attendees (migration 0011). is_self marks the mailbox's own line,
// which drives RSVP rendering and the PARTSTAT echoed back in a REPLY. Composite
// pk (event_id, addr) cascades from events.
export const eventAttendees = sqliteTable(
  "event_attendees",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    addr: text("addr").notNull(),
    displayName: text("display_name").notNull().default(""),
    partstat: text("partstat", { enum: ATTENDEE_PARTSTATS })
      .notNull()
      .default("needs-action"),
    role: text("role").notNull().default(""),
    isSelf: integer("is_self", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.addr] })],
);

// messages_fts is an FTS5 virtual table (plus sync triggers) that Drizzle
// cannot model. It exists only in the SQL migration; query it with raw SQL.
