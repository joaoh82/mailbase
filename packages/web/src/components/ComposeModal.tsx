import {
  htmlToText,
  plainTextToHtml,
  sanitizeOutboundHtml,
} from "@mailbase/shared/html";
import { Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type AttachmentMeta,
  createDraft,
  deleteDraft,
  type Draft,
  type DraftMode,
  sendDraft,
  sendMail,
  updateDraft,
  uploadAttachment,
  type Identity,
  type UploadResult,
} from "../api";
import { buildComposeBody, resolveSignature, swapSignature } from "../signature";
import { RichTextEditor, type RichTextEditorHandle } from "./RichTextEditor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface ComposeInitial {
  identityId?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  /** Internal id of the message being replied to (drives server threading). */
  inReplyTo?: string;
  /** What this compose is, stored on its draft (Phase 8). */
  mode?: DraftMode;
  /** The replied-to / forwarded message, stored on its draft. */
  sourceMessageId?: string;
  /** Open an existing server-side draft (Phase 8) instead of a fresh compose. */
  draft?: Draft;
}

// Autosave (Phase 8): once the user has changed something, the compose is
// saved as a server-side draft this long after they stop typing, and again on
// close. Drafts are shared with agents (same store), so every save carries the
// version it read; a 409 means someone else edited it and autosave stops.
const AUTOSAVE_DELAY_MS = 2000;

function splitAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function ComposeModal({
  identities,
  initial,
  onClose,
  onSent,
}: {
  identities: Identity[];
  initial: ComposeInitial;
  onClose: () => void;
  onSent: () => void;
}) {
  const draft = initial.draft;
  const [identityId, setIdentityId] = useState(
    draft
      ? (draft.identityId ?? "")
      : (initial.identityId ?? identities[0]?.id ?? ""),
  );
  const [to, setTo] = useState(draft ? draft.to.join(", ") : (initial.to ?? ""));
  const [cc, setCc] = useState(draft ? draft.cc.join(", ") : (initial.cc ?? ""));
  const [bcc, setBcc] = useState(
    draft ? draft.bcc.join(", ") : (initial.bcc ?? ""),
  );
  const [showCc, setShowCc] = useState(
    Boolean(draft ? draft.cc.length || draft.bcc.length : initial.cc || initial.bcc),
  );
  const [subject, setSubject] = useState(draft?.subject ?? initial.subject ?? "");
  // The quoted/forwarded history (if any) is fixed for the life of the
  // composer; the signature is inserted above it and swapped when the From
  // identity changes (MAIL-4). All three are tracked in the same normalized
  // HTML space (sanitized) so the signature can be found and replaced exactly.
  const [quotedHtml] = useState(() =>
    draft ? "" : sanitizeOutboundHtml(plainTextToHtml(initial.body ?? "")),
  );
  const editorRef = useRef<RichTextEditorHandle>(null);
  const initialSignature = sanitizeOutboundHtml(
    resolveSignature(identities.find((i) => i.id === identityId)),
  );
  // The signature currently applied to the body, so a From change can swap it
  // in place rather than stacking a second one.
  const appliedSignature = useRef(initialSignature);
  // A stored draft already carries its body (and any signature) verbatim.
  const [initialHtml] = useState(() =>
    draft
      ? draft.html || sanitizeOutboundHtml(plainTextToHtml(draft.text))
      : buildComposeBody(initialSignature, quotedHtml),
  );
  const [bodyHtml, setBodyHtml] = useState(initialHtml);
  const [bodyText, setBodyText] = useState(() => htmlToText(initialHtml));
  // New uploads not yet saved into a draft, and files already on the draft.
  const [attachments, setAttachments] = useState<UploadResult[]>([]);
  const [draftFiles, setDraftFiles] = useState<AttachmentMeta[]>(
    draft?.attachments ?? [],
  );
  const [removedFileIds, setRemovedFileIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Server-side draft state (Phase 8).
  const draftRef = useRef<{ id: string; version: number } | null>(
    draft ? { id: draft.id, version: draft.version } : null,
  );
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    draft ? "saved" : "idle",
  );
  const [conflict, setConflict] = useState(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const editCount = useRef(0);
  const markDirty = () => {
    editCount.current += 1;
    setDirty(true);
  };

  // Swap the signature when the user picks a different From identity: replace
  // the previously-inserted one (normalizing the editor's HTML so it can be
  // matched) and re-seed the editor. onChange then refreshes bodyHtml/bodyText.
  function handleIdentityChange(nextId: string) {
    setIdentityId(nextId);
    markDirty();
    const next = sanitizeOutboundHtml(
      resolveSignature(identities.find((i) => i.id === nextId)),
    );
    const prev = appliedSignature.current;
    if (next === prev) return;
    const current = sanitizeOutboundHtml(bodyHtml);
    const updated = swapSignature(current, prev, next, quotedHtml);
    appliedSignature.current = next;
    editorRef.current?.setContent(updated);
  }

  // Save the compose as a draft (create on first save, then versioned
  // updates). Returns false on failure; a version conflict stops autosave.
  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (conflict) return false;
    if (savingRef.current) await savingRef.current;
    const editsAtStart = editCount.current;
    const uploadIds = attachments.map((a) => a.uploadId);
    const fields = {
      identityId: identityId || null,
      to: splitAddresses(to),
      cc: splitAddresses(cc),
      bcc: splitAddresses(bcc),
      subject,
      html: bodyText.trim() ? bodyHtml : "",
      text: bodyText,
      uploadIds,
    };
    const run = (async () => {
      setSaveState("saving");
      try {
        const current = draftRef.current;
        const { draft: saved } = current
          ? await updateDraft(current.id, current.version, {
              ...fields,
              removeAttachmentIds: removedFileIds,
            })
          : await createDraft({
              ...fields,
              mode: initial.mode ?? (initial.inReplyTo ? "reply" : "new"),
              sourceMessageId: initial.sourceMessageId ?? initial.inReplyTo,
            });
        draftRef.current = { id: saved.id, version: saved.version };
        setDraftFiles(saved.attachments);
        // Uploads included in this save now live on the draft.
        setAttachments((prev) => prev.filter((a) => !uploadIds.includes(a.uploadId)));
        setRemovedFileIds([]);
        if (editCount.current === editsAtStart) setDirty(false);
        setSaveState("saved");
        return true;
      } catch (err) {
        setSaveState("idle");
        if (err instanceof ApiError && err.code === "draft_conflict") {
          setConflict(true);
        } else {
          setError(err instanceof Error ? err.message : "Could not save the draft.");
        }
        return false;
      }
    })();
    savingRef.current = run;
    try {
      return await run;
    } finally {
      savingRef.current = null;
    }
  }, [
    conflict,
    attachments,
    identityId,
    to,
    cc,
    bcc,
    subject,
    bodyHtml,
    bodyText,
    removedFileIds,
    initial.mode,
    initial.inReplyTo,
    initial.sourceMessageId,
  ]);

  // Debounced autosave while the user edits.
  useEffect(() => {
    if (!dirty || conflict || sending) return;
    const timer = setTimeout(() => {
      void saveDraft();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, conflict, sending, saveDraft]);

  // Closing keeps the work: unsaved edits are saved as a draft first.
  const handleClose = useCallback(async () => {
    if (dirty && !conflict) await saveDraft();
    onClose();
  }, [dirty, conflict, saveDraft, onClose]);

  async function handleDiscard() {
    const current = draftRef.current;
    if (current) {
      try {
        await deleteDraft(current.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not discard the draft.");
        return;
      }
    }
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const result = await uploadAttachment(file);
        setAttachments((prev) => [...prev, result]);
        markDirty();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSend() {
    setError(null);
    const recipients = splitAddresses(to);
    if (!identityId) {
      setError("Choose a From address.");
      return;
    }
    if (recipients.length === 0) {
      setError("Add at least one recipient.");
      return;
    }
    setSending(true);
    try {
      // Let an in-flight autosave finish first so it can't create a draft
      // that outlives this send.
      if (savingRef.current) await savingRef.current;
      // A compose that has become a draft is sent as that draft (after saving
      // the latest edits), so the draft is removed once it's in Sent.
      if (draftRef.current) {
        const pending =
          dirty || attachments.length > 0 || removedFileIds.length > 0;
        if (pending && !(await saveDraft())) return;
        const current = draftRef.current;
        await sendDraft(current.id, current.version);
        onSent();
        onClose();
        return;
      }
      // The HTML is the body; send a plaintext fallback alongside it so the
      // message is a proper multipart/alternative. An empty editor sends no
      // HTML (a plain, empty-body message), matching the old behaviour.
      const hasBody = bodyText.trim().length > 0;
      await sendMail({
        identityId,
        to: recipients,
        cc: splitAddresses(cc),
        bcc: splitAddresses(bcc),
        subject,
        text: bodyText,
        html: hasBody ? bodyHtml : undefined,
        inReplyTo: initial.inReplyTo,
        uploadIds: attachments.map((a) => a.uploadId),
      });
      onSent();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === "draft_conflict") {
        setConflict(true);
      } else {
        setError(err instanceof Error ? err.message : "Could not send the message.");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">
            {draft ? "Draft" : "New message"}
          </h2>
          <span className="ml-auto mr-3 text-xs text-slate-500">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved" && !dirty
                ? "Draft saved"
                : ""}
          </span>
          <button
            aria-label="Close"
            className="text-slate-400 hover:text-slate-200"
            onClick={() => void handleClose()}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {identities.length === 0 ? (
            <p className="rounded-md bg-amber-950 px-3 py-2 text-xs text-amber-300">
              You don't have a send-as address yet, so sending is disabled. Your
              account needs an <code>identities</code> row linking it to an
              address before you can send (see docs/SELF_HOSTING.md).
            </p>
          ) : (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-12 text-right">From</span>
              <select
                className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                value={identityId}
                onChange={(e) => handleIdentityChange(e.target.value)}
              >
                {identities.map((id) => {
                  // Mailbox name wins (MAIL-22): the From the recipient sees.
                  const fromName = id.mailboxDisplayName || id.displayName;
                  return (
                    <option key={id.id} value={id.id}>
                      {fromName ? `${fromName} <${id.address}>` : id.address}
                    </option>
                  );
                })}
              </select>
            </label>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="w-12 text-right">To</span>
            <Input
              autoFocus
              placeholder="comma-separated addresses"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                markDirty();
              }}
            />
            {!showCc && (
              <button
                type="button"
                className="shrink-0 text-xs text-sky-400 hover:text-sky-300"
                onClick={() => setShowCc(true)}
              >
                Cc/Bcc
              </button>
            )}
          </label>

          {showCc && (
            <>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span className="w-12 text-right">Cc</span>
                <Input value={cc} onChange={(e) => {
                setCc(e.target.value);
                markDirty();
              }} />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span className="w-12 text-right">Bcc</span>
                <Input value={bcc} onChange={(e) => {
                setBcc(e.target.value);
                markDirty();
              }} />
              </label>
            </>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="w-12 text-right">Subject</span>
            <Input
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                markDirty();
              }}
            />
          </label>

          <RichTextEditor
            ref={editorRef}
            initialContent={initialHtml}
            onChange={(html, text) => {
              setBodyHtml(html);
              setBodyText(text);
              markDirty();
            }}
          />

          {(attachments.length > 0 || draftFiles.length > 0) && (
            <ul className="flex flex-wrap gap-2">
              {draftFiles.map((file) => (
                <li
                  key={file.id}
                  className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="max-w-48 truncate">{file.filename}</span>
                  <button
                    aria-label={`Remove ${file.filename}`}
                    className="text-slate-500 hover:text-slate-200"
                    onClick={() => {
                      setDraftFiles((prev) => prev.filter((f) => f.id !== file.id));
                      setRemovedFileIds((prev) => [...prev, file.id]);
                      markDirty();
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
              {attachments.map((att, i) => (
                <li
                  key={att.uploadId}
                  className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="max-w-48 truncate">{att.filename}</span>
                  <button
                    aria-label={`Remove ${att.filename}`}
                    className="text-slate-500 hover:text-slate-200"
                    onClick={() => {
                      setAttachments((prev) => prev.filter((_, j) => j !== i));
                      markDirty();
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {conflict && (
            <p className="rounded-md bg-amber-950 px-3 py-2 text-xs text-amber-300">
              This draft was changed elsewhere (another tab or an agent). Your
              latest edits were not saved — close it and reopen it from Drafts to
              load the current version.
            </p>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() =>
                document.getElementById("compose-file-input")?.click()
              }
            >
              <Paperclip className="h-3.5 w-3.5" />
              {uploading ? "Uploading…" : "Attach"}
            </Button>
            <input
              id="compose-file-input"
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            {draftRef.current || dirty ? (
              <Button variant="ghost" size="sm" onClick={() => void handleDiscard()}>
                Discard
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={conflict || saveState === "saving"}
              onClick={() => void saveDraft()}
            >
              Save draft
            </Button>
            <Button
              size="sm"
              disabled={sending || identities.length === 0}
              onClick={handleSend}
            >
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
