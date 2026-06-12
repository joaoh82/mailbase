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
  },
  (table) => [index("idx_sessions_user").on(table.userId)],
);

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
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
  },
  (table) => [
    uniqueIndex("identities_user_id_address_id_unique").on(
      table.userId,
      table.addressId,
    ),
    index("idx_identities_user").on(table.userId),
  ],
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
  },
  (table) => [
    index("idx_messages_mailbox_folder_date").on(
      table.mailboxId,
      table.folder,
      table.date,
    ),
    index("idx_messages_thread").on(table.threadId),
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

// messages_fts is an FTS5 virtual table (plus sync triggers) that Drizzle
// cannot model. It exists only in the SQL migration; query it with raw SQL.
