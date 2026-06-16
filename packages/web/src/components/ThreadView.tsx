import { useEffect, useState } from "react";
import {
  fetchMessage,
  fetchThread,
  type Label,
  type MessageDetail,
} from "../api";
import { isAuthError } from "../App";
import type { EmailBgMode } from "../lib/preferences";
import type { ComposeKind, Selection } from "./MailApp";
import { MessageView } from "./MessageView";

export function ThreadView({
  selection,
  onAuthError,
  onToggleStar,
  onSetRead,
  onMove,
  onReply,
  onApplyLabel,
  onRemoveLabel,
  emailBgMode,
  onEmailBgModeChange,
}: {
  selection: Selection | null;
  onAuthError: () => void;
  onToggleStar: (item: { id: string; isStarred: boolean }) => void;
  onSetRead: (id: string, isRead: boolean) => void;
  onMove: (id: string, target: "inbox" | "archive" | "trash") => void;
  onReply: (message: MessageDetail, kind: ComposeKind) => void;
  onApplyLabel: (messageId: string, label: Label) => void;
  onRemoveLabel: (messageId: string, labelId: string) => void;
  emailBgMode: EmailBgMode;
  onEmailBgModeChange: (mode: EmailBgMode) => void;
}) {
  const [messages, setMessages] = useState<MessageDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selection) return;
    const load = selection.threadId
      ? fetchThread(selection.threadId).then((r) => r.messages)
      : fetchMessage(selection.messageId).then((r) => [r.message]);
    load.then(setMessages).catch((err) => {
      if (isAuthError(err)) onAuthError();
      else setError(err instanceof Error ? err.message : String(err));
    });
  }, [selection, onAuthError]);

  if (!selection) {
    return (
      <section className="flex flex-1 items-center justify-center text-sm text-slate-600">
        Select a message to read it.
      </section>
    );
  }
  if (error) {
    return (
      <section className="flex flex-1 items-center justify-center text-sm text-red-400">
        {error}
      </section>
    );
  }
  if (!messages) {
    return (
      <section className="flex flex-1 items-center justify-center text-sm text-slate-600">
        Loading…
      </section>
    );
  }

  return (
    <section className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <h2 className="text-lg font-semibold text-slate-100">
          {messages[messages.length - 1]?.subject || "(no subject)"}
        </h2>
        {messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            // The clicked message opens expanded; earlier ones collapse.
            initiallyExpanded={
              message.id === selection.messageId || messages.length === 1
            }
            onToggleStar={onToggleStar}
            onSetRead={onSetRead}
            onMove={onMove}
            onReply={onReply}
            onApplyLabel={onApplyLabel}
            onRemoveLabel={onRemoveLabel}
            emailBgMode={emailBgMode}
            onEmailBgModeChange={onEmailBgModeChange}
          />
        ))}
      </div>
    </section>
  );
}
