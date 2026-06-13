import {
  htmlToText,
  plainTextToHtml,
  sanitizeOutboundHtml,
} from "@mailbase/shared/html";
import { Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  sendMail,
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
}

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
  const [identityId, setIdentityId] = useState(
    initial.identityId ?? identities[0]?.id ?? "",
  );
  const [to, setTo] = useState(initial.to ?? "");
  const [cc, setCc] = useState(initial.cc ?? "");
  const [bcc, setBcc] = useState(initial.bcc ?? "");
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc));
  const [subject, setSubject] = useState(initial.subject ?? "");
  // The quoted/forwarded history (if any) is fixed for the life of the
  // composer; the signature is inserted above it and swapped when the From
  // identity changes (MAIL-4). All three are tracked in the same normalized
  // HTML space (sanitized) so the signature can be found and replaced exactly.
  const [quotedHtml] = useState(() =>
    sanitizeOutboundHtml(plainTextToHtml(initial.body ?? "")),
  );
  const editorRef = useRef<RichTextEditorHandle>(null);
  const initialSignature = sanitizeOutboundHtml(
    resolveSignature(identities.find((i) => i.id === identityId)),
  );
  // The signature currently applied to the body, so a From change can swap it
  // in place rather than stacking a second one.
  const appliedSignature = useRef(initialSignature);
  const [initialHtml] = useState(() =>
    buildComposeBody(initialSignature, quotedHtml),
  );
  const [bodyHtml, setBodyHtml] = useState(initialHtml);
  const [bodyText, setBodyText] = useState(() => htmlToText(initialHtml));
  const [attachments, setAttachments] = useState<UploadResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Swap the signature when the user picks a different From identity: replace
  // the previously-inserted one (normalizing the editor's HTML so it can be
  // matched) and re-seed the editor. onChange then refreshes bodyHtml/bodyText.
  function handleIdentityChange(nextId: string) {
    setIdentityId(nextId);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const result = await uploadAttachment(file);
        setAttachments((prev) => [...prev, result]);
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
      setError(err instanceof Error ? err.message : "Could not send the message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">New message</h2>
          <button
            aria-label="Close"
            className="text-slate-400 hover:text-slate-200"
            onClick={onClose}
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
                {identities.map((id) => (
                  <option key={id.id} value={id.id}>
                    {id.displayName
                      ? `${id.displayName} <${id.address}>`
                      : id.address}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="w-12 text-right">To</span>
            <Input
              autoFocus
              placeholder="comma-separated addresses"
              value={to}
              onChange={(e) => setTo(e.target.value)}
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
                <Input value={cc} onChange={(e) => setCc(e.target.value)} />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span className="w-12 text-right">Bcc</span>
                <Input value={bcc} onChange={(e) => setBcc(e.target.value)} />
              </label>
            </>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span className="w-12 text-right">Subject</span>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>

          <RichTextEditor
            ref={editorRef}
            initialContent={initialHtml}
            onChange={(html, text) => {
              setBodyHtml(html);
              setBodyText(text);
            }}
          />

          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-2">
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
                    onClick={() =>
                      setAttachments((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
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
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
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
