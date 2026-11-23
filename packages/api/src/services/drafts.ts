import {
  DRAFT_MODES,
  type DraftMode,
  draftAttachments,
  drafts,
  htmlToText,
  mailboxMembers,
  sanitizeOutboundHtml,
} from "@mailbase/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getAccessibleMessage, hasMailboxAccess } from "../lib/access";
import { serializeDraft } from "../lib/serialize";
import { composeFromMessage, type ReplyMode } from "./compose";
import { type SendQuota, type ServiceContext, ServiceError } from "./context";
import {
  getOwnedIdentity,
  type LoadedUpload,
  loadUpload,
  sendMessage,
  uploadKey,
} from "./send";

// Server-side drafts (Phase 8, DESIGN.md §5). Author-private: a draft is
// visible only to its author, and only while they are still a member of its
// mailbox — so an agent's drafts (the token is the user) land in the user's
// own Drafts. Updates are optimistic-concurrency checked on `version`; sending
// re-checks identity ownership, membership and reply-target access, trusting
// nothing that was stored at draft time.

const MAX_RECIPIENTS = 100;
const MAX_ADDR_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 1024 * 1024;
const MAX_DRAFTS_LISTED = 100;

export type DraftRow = typeof drafts.$inferSelect;

const conflict = () =>
  new ServiceError(
    409,
    "The draft was changed elsewhere; reload it and retry",
    "draft_conflict",
  );

const nowSeconds = () => new Date(Math.floor(Date.now() / 1000) * 1000);

/** Draft recipients are lenient (half-typed is fine); validated on send. */
function draftRecipients(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  const list =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : null;
  if (!list) throw new ServiceError(400, `${field} must be a list of addresses`);
  const out = list
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
  if (
    out.length > MAX_RECIPIENTS ||
    out.some((v) => v.length > MAX_ADDR_LENGTH)
  ) {
    throw new ServiceError(400, `${field} has too many or too long addresses`);
  }
  return out;
}

function bodyFields(input: { html?: unknown; text?: unknown }) {
  const out: { bodyHtml?: string; bodyText?: string } = {};
  if (input.html !== undefined) {
    if (typeof input.html !== "string") {
      throw new ServiceError(400, "html must be a string");
    }
    if (input.html.length > MAX_BODY_LENGTH) {
      throw new ServiceError(413, "Draft body is too large");
    }
    // Stored sanitized: the webmail loads it straight into the editor.
    out.bodyHtml = input.html.trim() ? sanitizeOutboundHtml(input.html) : "";
    if (out.bodyHtml) out.bodyText = htmlToText(out.bodyHtml);
  }
  if (input.text !== undefined && !out.bodyHtml) {
    if (typeof input.text !== "string") {
      throw new ServiceError(400, "text must be a string");
    }
    if (input.text.length > MAX_BODY_LENGTH) {
      throw new ServiceError(413, "Draft body is too large");
    }
    out.bodyText = input.text;
  }
  return out;
}

function subjectField(value: unknown): string {
  if (typeof value !== "string") {
    throw new ServiceError(400, "subject must be a string");
  }
  if (value.length > MAX_SUBJECT_LENGTH) {
    throw new ServiceError(400, "subject is too long");
  }
  return value;
}

/** The identity must be the caller's and belong to the draft's mailbox. */
async function checkIdentity(
  ctx: ServiceContext,
  identityId: string,
  mailboxId: string,
) {
  const identity = await getOwnedIdentity(ctx.db, ctx.userId, identityId);
  if (!identity || identity.mailboxId !== mailboxId) {
    throw new ServiceError(
      403,
      "You cannot send as that identity from this mailbox",
    );
  }
}

/** A draft by id, only for its author while still a member of its mailbox. */
async function requireDraft(
  ctx: ServiceContext,
  draftId: string,
): Promise<DraftRow> {
  const row = await ctx.db
    .select({ draft: drafts })
    .from(drafts)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, drafts.mailboxId),
        eq(mailboxMembers.userId, ctx.userId),
      ),
    )
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, ctx.userId)))
    .get();
  if (!row) throw new ServiceError(404, "Draft not found");
  return row.draft;
}

async function attachmentsOf(ctx: ServiceContext, draftIds: string[]) {
  const map = new Map<string, (typeof draftAttachments.$inferSelect)[]>();
  if (draftIds.length === 0) return map;
  const rows = await ctx.db
    .select()
    .from(draftAttachments)
    .where(inArray(draftAttachments.draftId, draftIds))
    .all();
  for (const row of rows) {
    const list = map.get(row.draftId) ?? [];
    list.push(row);
    map.set(row.draftId, list);
  }
  return map;
}

async function storeDraftAttachment(
  ctx: ServiceContext,
  draftId: string,
  file: LoadedUpload,
) {
  const r2Key = `drafts/${draftId}/${crypto.randomUUID()}`;
  await ctx.env.MAIL_BUCKET.put(r2Key, file.bytes, {
    httpMetadata: { contentType: file.mimeType },
  });
  await ctx.db.insert(draftAttachments).values({
    id: crypto.randomUUID(),
    draftId,
    filename: file.filename,
    contentType: file.mimeType,
    size: file.bytes.byteLength,
    r2Key,
  });
}

/** Move the caller's staged uploads into the draft's R2 prefix. */
async function attachUploads(
  ctx: ServiceContext,
  draftId: string,
  uploadIds: string[],
) {
  for (const uploadId of uploadIds) {
    const loaded = await loadUpload(ctx.env, ctx.userId, uploadId);
    if (!loaded) {
      throw new ServiceError(
        400,
        "An attachment upload has expired; re-add it and retry",
      );
    }
    await storeDraftAttachment(ctx, draftId, loaded);
    await ctx.env.MAIL_BUCKET.delete(uploadKey(ctx.userId, uploadId)).catch(
      () => undefined,
    );
  }
}

function idList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ServiceError(400, `${field} must be a list of ids`);
  }
  return value as string[];
}

/** The caller's drafts, newest first; optionally one mailbox. */
export async function listDrafts(
  ctx: ServiceContext,
  input: { mailboxId?: string } = {},
) {
  const conditions = [eq(drafts.userId, ctx.userId)];
  if (input.mailboxId) {
    if (!(await hasMailboxAccess(ctx.db, ctx.userId, input.mailboxId))) {
      throw new ServiceError(404, "Mailbox not found");
    }
    conditions.push(eq(drafts.mailboxId, input.mailboxId));
  }
  const rows = await ctx.db
    .select({ draft: drafts })
    .from(drafts)
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.mailboxId, drafts.mailboxId),
        eq(mailboxMembers.userId, ctx.userId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(MAX_DRAFTS_LISTED)
    .all();
  const list = rows.map((r) => r.draft);
  const atts = await attachmentsOf(
    ctx,
    list.map((d) => d.id),
  );
  return list.map((d) => serializeDraft(d, atts.get(d.id) ?? []));
}

export async function getDraft(ctx: ServiceContext, draftId: string) {
  const draft = await requireDraft(ctx, draftId);
  const atts = await attachmentsOf(ctx, [draft.id]);
  return serializeDraft(draft, atts.get(draft.id) ?? []);
}

export interface CreateDraftInput {
  mailboxId?: unknown;
  identityId?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  mode?: unknown;
  sourceMessageId?: unknown;
  uploadIds?: unknown;
}

/**
 * Create a draft. The mailbox comes from the identity when one is given (it
 * must be the caller's), else from mailboxId (must be a membership).
 */
export async function createDraft(
  ctx: ServiceContext,
  input: CreateDraftInput,
) {
  const identityId =
    typeof input.identityId === "string" && input.identityId
      ? input.identityId
      : null;
  let mailboxId = typeof input.mailboxId === "string" ? input.mailboxId : "";
  if (identityId) {
    const identity = await getOwnedIdentity(ctx.db, ctx.userId, identityId);
    if (!identity) {
      throw new ServiceError(403, "You cannot send as that identity");
    }
    if (mailboxId && mailboxId !== identity.mailboxId) {
      throw new ServiceError(400, "identityId does not belong to mailboxId");
    }
    mailboxId = identity.mailboxId;
  }
  if (!mailboxId) {
    throw new ServiceError(400, "identityId or mailboxId is required");
  }
  if (!(await hasMailboxAccess(ctx.db, ctx.userId, mailboxId))) {
    throw new ServiceError(404, "Mailbox not found");
  }

  const mode = (input.mode ?? "new") as DraftMode;
  if (!DRAFT_MODES.includes(mode)) {
    throw new ServiceError(
      400,
      `mode must be one of: ${DRAFT_MODES.join(", ")}`,
    );
  }
  let sourceMessageId: string | null = null;
  if (typeof input.sourceMessageId === "string" && input.sourceMessageId) {
    const source = await getAccessibleMessage(
      ctx.db,
      ctx.userId,
      input.sourceMessageId,
    );
    if (!source) throw new ServiceError(404, "Source message not found");
    sourceMessageId = source.id;
  }
  const uploadIds = idList(input.uploadIds, "uploadIds");

  const id = crypto.randomUUID();
  const now = nowSeconds();
  await ctx.db.insert(drafts).values({
    id,
    userId: ctx.userId,
    mailboxId,
    identityId,
    toAddrs: draftRecipients(input.to, "to"),
    ccAddrs: draftRecipients(input.cc, "cc"),
    bccAddrs: draftRecipients(input.bcc, "bcc"),
    subject: input.subject === undefined ? "" : subjectField(input.subject),
    ...bodyFields(input),
    mode,
    sourceMessageId,
    createdAt: now,
    updatedAt: now,
  });
  await attachUploads(ctx, id, uploadIds);
  return getDraft(ctx, id);
}

/**
 * Create a reply / reply-all / forward draft of a message, built server-side
 * (threading headers are derived from the source when it is sent). A forward
 * copies the source's attachments into the draft.
 */
export async function createReplyDraft(
  ctx: ServiceContext,
  messageId: string,
  mode: ReplyMode,
  body: { text?: string; html?: string } = {},
) {
  const composed = await composeFromMessage(ctx, messageId, mode, body);
  const id = crypto.randomUUID();
  const now = nowSeconds();
  await ctx.db.insert(drafts).values({
    id,
    userId: ctx.userId,
    mailboxId: composed.mailboxId,
    identityId: composed.identityId,
    toAddrs: composed.to,
    ccAddrs: composed.cc,
    subject: composed.subject,
    bodyHtml: composed.html,
    bodyText: composed.text,
    mode: composed.mode,
    sourceMessageId: composed.sourceMessageId,
    createdAt: now,
    updatedAt: now,
  });
  for (const att of composed.forwardAttachments) {
    const object = await ctx.env.MAIL_BUCKET.get(att.r2Key);
    if (!object) continue; // A missing blob is skipped rather than failing the draft.
    await storeDraftAttachment(ctx, id, {
      filename: att.filename,
      mimeType: att.mimeType,
      bytes: new Uint8Array(await object.arrayBuffer()),
    });
  }
  return getDraft(ctx, id);
}

export interface UpdateDraftInput {
  version?: unknown;
  identityId?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  uploadIds?: unknown;
  removeAttachmentIds?: unknown;
}

/**
 * Update a draft. With `version`, the write only lands if nobody else changed
 * the draft since (409 draft_conflict otherwise) — the webmail always sends it;
 * agents should. Every successful update bumps the version.
 */
export async function updateDraft(
  ctx: ServiceContext,
  draftId: string,
  input: UpdateDraftInput,
) {
  const draft = await requireDraft(ctx, draftId);
  if (input.version !== undefined && !Number.isInteger(input.version)) {
    throw new ServiceError(400, "version must be an integer");
  }
  const set: Partial<typeof drafts.$inferInsert> = {};
  if (input.identityId !== undefined) {
    if (input.identityId === null || input.identityId === "") {
      set.identityId = null;
    } else if (typeof input.identityId === "string") {
      await checkIdentity(ctx, input.identityId, draft.mailboxId);
      set.identityId = input.identityId;
    } else {
      throw new ServiceError(400, "identityId must be a string");
    }
  }
  if (input.to !== undefined) set.toAddrs = draftRecipients(input.to, "to");
  if (input.cc !== undefined) set.ccAddrs = draftRecipients(input.cc, "cc");
  if (input.bcc !== undefined) set.bccAddrs = draftRecipients(input.bcc, "bcc");
  if (input.subject !== undefined) set.subject = subjectField(input.subject);
  Object.assign(set, bodyFields(input));
  const uploadIds = idList(input.uploadIds, "uploadIds");
  const removeIds = idList(input.removeAttachmentIds, "removeAttachmentIds");

  const versionCheck =
    input.version !== undefined
      ? [eq(drafts.version, input.version as number)]
      : [];
  const updated = await ctx.db
    .update(drafts)
    .set({
      ...set,
      version: sql`${drafts.version} + 1`,
      updatedAt: nowSeconds(),
    })
    .where(and(eq(drafts.id, draft.id), ...versionCheck))
    .returning({ id: drafts.id })
    .get();
  if (!updated) throw conflict();

  if (removeIds.length > 0) {
    const doomed = await ctx.db
      .select()
      .from(draftAttachments)
      .where(
        and(
          eq(draftAttachments.draftId, draft.id),
          inArray(draftAttachments.id, removeIds),
        ),
      )
      .all();
    if (doomed.length > 0) {
      await ctx.db.delete(draftAttachments).where(
        inArray(
          draftAttachments.id,
          doomed.map((d) => d.id),
        ),
      );
      await ctx.env.MAIL_BUCKET.delete(doomed.map((d) => d.r2Key)).catch(
        () => undefined,
      );
    }
  }
  await attachUploads(ctx, draft.id, uploadIds);
  return getDraft(ctx, draft.id);
}

async function purgeDraft(ctx: ServiceContext, draftId: string) {
  const atts = await ctx.db
    .select({ r2Key: draftAttachments.r2Key })
    .from(draftAttachments)
    .where(eq(draftAttachments.draftId, draftId))
    .all();
  // draft_attachments rows cascade with the draft.
  await ctx.db.delete(drafts).where(eq(drafts.id, draftId));
  if (atts.length > 0) {
    await ctx.env.MAIL_BUCKET.delete(atts.map((a) => a.r2Key)).catch(
      () => undefined,
    );
  }
}

export async function deleteDraft(
  ctx: ServiceContext,
  draftId: string,
): Promise<void> {
  const draft = await requireDraft(ctx, draftId);
  await purgeDraft(ctx, draft.id);
}

/**
 * Send a draft through the one send path (services/send.ts), then delete it
 * and its R2 objects. The draft is first claimed by bumping its version, so two
 * concurrent sends of the same draft can't both go out (the loser gets 409).
 */
export async function sendDraft(
  ctx: ServiceContext,
  draftId: string,
  opts: { version?: unknown; quota?: SendQuota } = {},
) {
  const draft = await requireDraft(ctx, draftId);
  if (opts.version !== undefined && opts.version !== draft.version) {
    throw conflict();
  }
  if (!draft.identityId) {
    throw new ServiceError(400, "Choose an identity to send this draft from");
  }
  const claimed = await ctx.db
    .update(drafts)
    .set({ version: sql`${drafts.version} + 1` })
    .where(and(eq(drafts.id, draft.id), eq(drafts.version, draft.version)))
    .returning({ id: drafts.id })
    .get();
  if (!claimed) throw conflict();

  const rows = (await attachmentsOf(ctx, [draft.id])).get(draft.id) ?? [];
  const files: LoadedUpload[] = [];
  for (const row of rows) {
    const object = await ctx.env.MAIL_BUCKET.get(row.r2Key);
    if (!object) {
      throw new ServiceError(
        400,
        `Attachment ${row.filename} is missing; remove it and retry`,
      );
    }
    files.push({
      filename: row.filename,
      mimeType: row.contentType,
      bytes: new Uint8Array(await object.arrayBuffer()),
    });
  }

  const isReply = draft.mode === "reply" || draft.mode === "reply_all";
  const result = await sendMessage(ctx, {
    identityId: draft.identityId,
    to: draft.toAddrs,
    cc: draft.ccAddrs,
    bcc: draft.bccAddrs,
    subject: draft.subject,
    html: draft.bodyHtml,
    text: draft.bodyText,
    inReplyTo: isReply ? draft.sourceMessageId : null,
    attachments: files,
    quota: opts.quota,
  });
  await purgeDraft(ctx, draft.id);
  return result;
}
