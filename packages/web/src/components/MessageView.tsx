import {
  AlertTriangle,
  Archive,
  Check,
  Download,
  Forward,
  Image,
  Mail,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  applyLabel,
  fetchMessageFull,
  type AttachmentMeta,
  type Label,
  listLabels,
  type MessageDetail,
  mintAttachmentUrl,
  removeLabel,
} from "../api";
import { buildEmailSrcdoc, EMAIL_IFRAME_SANDBOX } from "../email-html";
import { cn } from "../lib/utils";
import { DEFAULT_LABEL_COLOR, LabelChip } from "./LabelChip";
import type { ComposeKind } from "./MailApp";
import { formatListDate } from "./MessageList";
import { Button } from "./ui/button";

const DELIVERY_NOTICE: Record<string, string> = {
  bounced: "This message bounced — the recipient's server rejected it.",
  complained: "The recipient marked this message as spam.",
};

export function MessageView({
  message,
  initiallyExpanded,
  onToggleStar,
  onSetRead,
  onMove,
  onReply,
  onApplyLabel,
  onRemoveLabel,
}: {
  message: MessageDetail;
  initiallyExpanded: boolean;
  onToggleStar: (item: { id: string; isStarred: boolean }) => void;
  onSetRead: (id: string, isRead: boolean) => void;
  onMove: (id: string, target: "inbox" | "archive" | "trash") => void;
  onReply: (message: MessageDetail, kind: ComposeKind) => void;
  // Keep the list row's chips in step when labels change here (MAIL-16).
  onApplyLabel: (messageId: string, label: Label) => void;
  onRemoveLabel: (messageId: string, labelId: string) => void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // Local mirrors so the buttons reflect actions immediately even though the
  // canonical state lives in the list above.
  const [isStarred, setIsStarred] = useState(message.isStarred);
  const [isRead, setIsRead] = useState(message.isRead);
  const [folder, setFolder] = useState(message.folder);
  // Labels mirror + the apply menu's options for this message's mailbox, which
  // are fetched lazily the first time the menu opens.
  const [labels, setLabels] = useState<Label[]>(message.labels);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [availableLabels, setAvailableLabels] = useState<Label[] | null>(null);

  function openLabelMenu() {
    setLabelMenuOpen((open) => !open);
    if (availableLabels === null) {
      listLabels(message.mailboxId)
        .then((r) => setAvailableLabels(r.labels))
        .catch(() => setAvailableLabels([]));
    }
  }

  function toggleLabel(label: Label) {
    if (labels.some((l) => l.id === label.id)) {
      setLabels((prev) => prev.filter((l) => l.id !== label.id));
      onRemoveLabel(message.id, label.id);
    } else {
      setLabels((prev) =>
        [...prev, label].sort((a, b) => a.name.localeCompare(b.name)),
      );
      onApplyLabel(message.id, label);
    }
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="block w-full rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 text-left hover:bg-slate-900"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm text-slate-300">
            {message.fromAddr}
          </span>
          <span className="shrink-0 text-xs text-slate-500">
            {formatListDate(message.date)}
          </span>
        </span>
        <span className="block truncate text-xs text-slate-500">
          {message.snippet}
        </span>
      </button>
    );
  }

  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/60">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-100">
            {message.fromAddr}
          </p>
          <p className="truncate text-xs text-slate-500">
            to {message.toAddrs.join(", ")}
          </p>
          <p className="text-xs text-slate-500">
            {new Date(message.date).toLocaleString()}
          </p>
          {labels.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {labels.map((l) => (
                <LabelChip
                  key={l.id}
                  label={l}
                  onRemove={() => toggleLabel(l)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Reply"
            onClick={() => onReply(message, "reply")}
          >
            <Reply className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Reply all"
            onClick={() => onReply(message, "replyAll")}
          >
            <ReplyAll className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Forward"
            onClick={() => onReply(message, "forward")}
          >
            <Forward className="h-4 w-4" />
          </Button>
          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Labels"
              onClick={openLabelMenu}
            >
              <Tag className="h-4 w-4" />
            </Button>
            {labelMenuOpen && (
              <>
                {/* Click-away backdrop. */}
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => setLabelMenuOpen(false)}
                />
                <div className="absolute right-0 z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-slate-700 bg-slate-800 p-1 shadow-lg">
                  {availableLabels === null ? (
                    <p className="px-2 py-1.5 text-xs text-slate-400">Loading…</p>
                  ) : availableLabels.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-slate-400">
                      No labels in this mailbox yet.
                    </p>
                  ) : (
                    availableLabels.map((l) => {
                      const checked = labels.some((x) => x.id === l.id);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => toggleLabel(l)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-700"
                        >
                          <span
                            className="h-3 w-3 shrink-0 rounded-sm"
                            style={{
                              backgroundColor: l.color || DEFAULT_LABEL_COLOR,
                            }}
                          />
                          <span className="flex-1 truncate">{l.name}</span>
                          {checked && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={isStarred ? "Unstar" : "Star"}
            onClick={() => {
              onToggleStar({ id: message.id, isStarred });
              setIsStarred(!isStarred);
            }}
          >
            <Star
              className={cn(
                "h-4 w-4",
                isStarred && "fill-yellow-400 text-yellow-400",
              )}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={isRead ? "Mark as unread" : "Mark as read"}
            onClick={() => {
              onSetRead(message.id, !isRead);
              setIsRead(!isRead);
            }}
          >
            {isRead ? (
              <Mail className="h-4 w-4" />
            ) : (
              <MailOpen className="h-4 w-4" />
            )}
          </Button>
          {folder !== "archive" && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Archive"
              onClick={() => {
                onMove(message.id, "archive");
                setFolder("archive");
              }}
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {folder !== "trash" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Move to trash"
              onClick={() => {
                onMove(message.id, "trash");
                setFolder("trash");
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Move back to inbox"
              onClick={() => {
                onMove(message.id, "inbox");
                setFolder("inbox");
              }}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </header>

      {DELIVERY_NOTICE[message.deliveryStatus] && (
        <div className="flex items-center gap-2 border-b border-red-900 bg-red-950 px-4 py-2 text-xs text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {DELIVERY_NOTICE[message.deliveryStatus]}
        </div>
      )}

      <MessageBody message={message} />

      {message.attachments.length > 0 && (
        <footer className="flex flex-wrap gap-2 border-t border-slate-800 px-4 py-3">
          {message.attachments.map((att) => (
            <AttachmentChip
              key={att.id}
              messageId={message.id}
              attachment={att}
            />
          ))}
        </footer>
      )}
    </article>
  );
}

function MessageBody({ message }: { message: MessageDetail }) {
  const [full, setFull] = useState<{
    html: string | null;
    text: string | null;
  } | null>(null);
  const [error, setError] = useState(false);
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

  useEffect(() => {
    fetchMessageFull(message.id)
      .then(setFull)
      .catch(() => setError(true));
  }, [message.id]);

  if (error) {
    // The indexed plain text is still available even if R2/parse failed.
    return (
      <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-sm text-slate-200">
        {message.bodyText}
      </pre>
    );
  }
  if (!full) {
    return <p className="px-4 py-3 text-sm text-slate-500">Loading body…</p>;
  }
  if (!full.html) {
    return (
      <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-sm text-slate-200">
        {full.text ?? message.bodyText}
      </pre>
    );
  }

  return (
    <div>
      {!allowRemoteImages && (
        <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-4 py-1.5 text-xs text-slate-400">
          <Image className="h-3.5 w-3.5" />
          Remote images are blocked.
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAllowRemoteImages(true)}
          >
            Load images
          </Button>
        </div>
      )}
      <iframe
        title={`Message: ${message.subject}`}
        sandbox={EMAIL_IFRAME_SANDBOX}
        srcDoc={buildEmailSrcdoc(full.html, { allowRemoteImages })}
        className="h-[60vh] w-full rounded-b-lg bg-white"
      />
    </div>
  );
}

function AttachmentChip({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: AttachmentMeta;
}) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      // Mint a short-lived signed URL, then let the browser download it; the
      // response is Content-Disposition: attachment.
      const { url } = await mintAttachmentUrl(messageId, attachment.id);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={download}>
      <Paperclip className="h-3 w-3" />
      <span className="max-w-48 truncate">{attachment.filename}</span>
      <span className="text-slate-500">{formatSize(attachment.size)}</span>
      <Download className="h-3 w-3" />
    </Button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
