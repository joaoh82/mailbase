import {
  Archive,
  Download,
  Image,
  Mail,
  MailOpen,
  Paperclip,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchMessageFull,
  mintAttachmentUrl,
  type AttachmentMeta,
  type MessageDetail,
} from "../api";
import { buildEmailSrcdoc, EMAIL_IFRAME_SANDBOX } from "../email-html";
import { cn } from "../lib/utils";
import { formatListDate } from "./MessageList";
import { Button } from "./ui/button";

export function MessageView({
  message,
  initiallyExpanded,
  onToggleStar,
  onSetRead,
  onMove,
}: {
  message: MessageDetail;
  initiallyExpanded: boolean;
  onToggleStar: (item: { id: string; isStarred: boolean }) => void;
  onSetRead: (id: string, isRead: boolean) => void;
  onMove: (id: string, target: "inbox" | "archive" | "trash") => void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // Local mirrors so the buttons reflect actions immediately even though the
  // canonical state lives in the list above.
  const [isStarred, setIsStarred] = useState(message.isStarred);
  const [isRead, setIsRead] = useState(message.isRead);
  const [folder, setFolder] = useState(message.folder);

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
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
