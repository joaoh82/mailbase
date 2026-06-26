import {
  AlertTriangle,
  Archive,
  CalendarDays,
  Check,
  Download,
  Forward,
  Image,
  Mail,
  MailOpen,
  Palette,
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
  type AttachmentMeta,
  type CalendarEvent,
  fetchMessageFull,
  getMessageEvent,
  type Label,
  listLabels,
  type MessageDetail,
  mintAttachmentUrl,
  removeLabel,
  rsvpEvent,
} from "../api";
import { buildEmailSrcdoc, EMAIL_IFRAME_SANDBOX } from "../email-html";
import { formatEventTime, PARTSTAT_LABELS } from "../lib/calendar";
import type { EmailBgMode } from "../lib/preferences";
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
  emailBgMode,
  onEmailBgModeChange,
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
  // Reading-pane body background (MAIL-15): a per-browser display preference,
  // owned by MailApp so the header toggle and Settings stay in sync.
  emailBgMode: EmailBgMode;
  onEmailBgModeChange: (mode: EmailBgMode) => void;
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
            aria-label={
              emailBgMode === "blended"
                ? "Email background: blended — switch to white"
                : "Email background: white — switch to blended"
            }
            title="Toggle email background"
            onClick={() =>
              onEmailBgModeChange(
                emailBgMode === "blended" ? "white" : "blended",
              )
            }
          >
            <Palette
              className={cn(
                "h-4 w-4",
                emailBgMode === "blended" && "text-sky-400",
              )}
            />
          </Button>
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

      <InviteCard message={message} />

      <MessageBody message={message} bgMode={emailBgMode} />

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

const RSVP_CHOICES: { value: "accepted" | "tentative" | "declined"; label: string }[] = [
  { value: "accepted", label: "Accept" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "Decline" },
];

// Reading-pane meeting invite (MAIL-29). Fetches the event a message carries (if
// any) and lets the user Accept / Tentative / Decline; the response sends a REPLY
// to the organizer and records the new status. Renders nothing for plain mail.
function InviteCard({ message }: { message: MessageDetail }) {
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [myStatus, setMyStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setEvent(null);
    getMessageEvent(message.id)
      .then(({ event }) => {
        if (!active) return;
        setEvent(event);
        setMyStatus(event?.attendees.find((a) => a.isSelf)?.partstat ?? null);
      })
      .catch(() => {
        // No card if the lookup fails; the message still renders.
      });
    return () => {
      active = false;
    };
  }, [message.id]);

  if (!event) return null;

  const cancelled = event.status === "cancelled";
  const self = event.attendees.find((a) => a.isSelf);
  const dateLabel = new Date(event.startsAt).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(event.allDay ? { timeZone: "UTC" } : {}),
  });

  async function respond(partstat: "accepted" | "tentative" | "declined") {
    if (!event) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rsvpEvent(event.id, partstat);
      setMyStatus(res.partstat);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send your response");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-slate-800 bg-slate-900/80 px-4 py-3">
      <div className="flex items-start gap-2">
        <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-sm font-medium",
              cancelled ? "text-slate-400 line-through" : "text-slate-100",
            )}
          >
            {event.summary || "(no title)"}
          </p>
          <p className="text-xs text-slate-400">
            {dateLabel} · {formatEventTime(event)}
          </p>
          {event.location && (
            <p className="truncate text-xs text-slate-500">{event.location}</p>
          )}
          {event.rrule && (
            <p className="text-xs text-slate-500">Recurring</p>
          )}

          {cancelled ? (
            <p className="mt-2 text-xs font-medium text-red-400">
              This event was cancelled.
            </p>
          ) : self ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {RSVP_CHOICES.map((choice) => (
                <Button
                  key={choice.value}
                  variant={myStatus === choice.value ? "default" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() => respond(choice.value)}
                >
                  {choice.label}
                </Button>
              ))}
              {myStatus && (
                <span className="ml-1 text-xs text-slate-400">
                  You responded: {PARTSTAT_LABELS[myStatus] ?? myStatus}
                </span>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              You are not an attendee of this invite.
            </p>
          )}
          {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function MessageBody({
  message,
  bgMode,
}: {
  message: MessageDetail;
  bgMode: EmailBgMode;
}) {
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
        srcDoc={buildEmailSrcdoc(full.html, { allowRemoteImages, bgMode })}
        // Match the element bg to the srcdoc body so there's no flash of the
        // wrong color before the document paints, and no seam around the edges.
        className={cn(
          "h-[60vh] w-full rounded-b-lg",
          bgMode === "blended" ? "bg-slate-900" : "bg-white",
        )}
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
