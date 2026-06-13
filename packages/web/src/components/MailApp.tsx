import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listIdentities,
  listMailboxes,
  listMessages,
  logout,
  moveMessage,
  searchMessages,
  setRead,
  setStarred,
  type Folder,
  type Identity,
  type Mailbox,
  type MessageDetail,
  type MessageListItem,
  type User,
} from "../api";
import { isAuthError } from "../App";
import { ComposeModal, type ComposeInitial } from "./ComposeModal";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { ThreadView } from "./ThreadView";

export interface Selection {
  messageId: string;
  threadId: string | null;
}

export type ComposeKind = "reply" | "replyAll" | "forward";

const reSubject = (s: string) => (/^re:/i.test(s.trim()) ? s : `Re: ${s}`);
const fwdSubject = (s: string) =>
  /^fwd?:/i.test(s.trim()) ? s : `Fwd: ${s}`;

function quoteBody(message: MessageDetail): string {
  const when = new Date(message.date).toLocaleString();
  const quoted = (message.bodyText || "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\nOn ${when}, ${message.fromAddr} wrote:\n${quoted}\n`;
}

export function MailApp({
  user,
  onSignedOut,
}: {
  user: User;
  onSignedOut: () => void;
}) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [activeQuery, setActiveQuery] = useState("");
  const [items, setItems] = useState<MessageListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [compose, setCompose] = useState<ComposeInitial | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadSeq = useRef(0);

  // Any API failure lands here; a dead session falls back to the login form.
  const fail = useCallback(
    (err: unknown) => {
      if (isAuthError(err)) {
        onSignedOut();
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onSignedOut],
  );

  const refreshMailboxes = useCallback(() => {
    listMailboxes()
      .then(({ mailboxes }) => {
        setMailboxes(mailboxes);
        setMailboxId((current) => current ?? mailboxes[0]?.id ?? null);
      })
      .catch(fail);
  }, [fail]);

  useEffect(refreshMailboxes, [refreshMailboxes]);

  // Send-as identities, fetched once; the compose modal needs them.
  useEffect(() => {
    listIdentities()
      .then(({ identities }) => setIdentities(identities))
      .catch(fail);
  }, [fail]);

  // (Re)load page one whenever mailbox, folder, active search, or a send change.
  useEffect(() => {
    if (!mailboxId) return;
    const seq = ++loadSeq.current;
    setLoadingList(true);
    setItems([]);
    setNextCursor(null);
    setSelection(null);
    setError(null);
    const load = activeQuery
      ? searchMessages(mailboxId, activeQuery).then((r) => ({
          messages: r.messages,
          nextCursor: null as string | null,
        }))
      : listMessages(mailboxId, folder);
    load
      .then((page) => {
        if (seq !== loadSeq.current) return;
        setItems(page.messages);
        setNextCursor(page.nextCursor);
      })
      .catch(fail)
      .finally(() => {
        if (seq === loadSeq.current) setLoadingList(false);
      });
  }, [mailboxId, folder, activeQuery, reloadNonce, fail]);

  const loadMore = useCallback(() => {
    if (!mailboxId || !nextCursor || loadingList || activeQuery) return;
    const seq = loadSeq.current;
    setLoadingList(true);
    listMessages(mailboxId, folder, nextCursor)
      .then((page) => {
        if (seq !== loadSeq.current) return;
        setItems((prev) => [...prev, ...page.messages]);
        setNextCursor(page.nextCursor);
      })
      .catch(fail)
      .finally(() => {
        if (seq === loadSeq.current) setLoadingList(false);
      });
  }, [mailboxId, folder, nextCursor, loadingList, activeQuery, fail]);

  const patchItem = useCallback(
    (id: string, patch: Partial<MessageListItem>) => {
      setItems((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  const handleSelect = useCallback(
    (item: MessageListItem) => {
      setSelection({ messageId: item.id, threadId: item.threadId });
      if (!item.isRead) {
        patchItem(item.id, { isRead: true });
        setRead(item.id, true).then(refreshMailboxes).catch(fail);
      }
    },
    [patchItem, refreshMailboxes, fail],
  );

  const handleToggleStar = useCallback(
    (item: { id: string; isStarred: boolean }) => {
      patchItem(item.id, { isStarred: !item.isStarred });
      setStarred(item.id, !item.isStarred).catch(fail);
    },
    [patchItem, fail],
  );

  const handleSetRead = useCallback(
    (id: string, isRead: boolean) => {
      patchItem(id, { isRead });
      setRead(id, isRead).then(refreshMailboxes).catch(fail);
    },
    [patchItem, refreshMailboxes, fail],
  );

  const handleMove = useCallback(
    (id: string, target: "inbox" | "archive" | "trash") => {
      moveMessage(id, target)
        .then(() => {
          // Drop it from the current folder view (searches keep showing it).
          if (!activeQuery && target !== folder) {
            setItems((prev) => prev.filter((m) => m.id !== id));
            setSelection((sel) => (sel?.messageId === id ? null : sel));
          } else {
            patchItem(id, { folder: target });
          }
          refreshMailboxes();
        })
        .catch(fail);
    },
    [activeQuery, folder, patchItem, refreshMailboxes, fail],
  );

  const handleLogout = useCallback(() => {
    logout().catch(() => undefined).finally(onSignedOut);
  }, [onSignedOut]);

  // Refresh the current folder + unread counts after a message is sent (so the
  // Sent folder shows it immediately).
  const handleSent = useCallback(() => {
    setReloadNonce((n) => n + 1);
    refreshMailboxes();
  }, [refreshMailboxes]);

  const ownAddresses = useMemo(
    () => new Set(mailboxes.map((m) => m.address.toLowerCase())),
    [mailboxes],
  );

  const identityForMailbox = useCallback(
    (forMailboxId: string | null): string | undefined => {
      const match = forMailboxId
        ? identities.find((i) => i.mailboxId === forMailboxId)
        : undefined;
      return (match ?? identities[0])?.id;
    },
    [identities],
  );

  const handleComposeNew = useCallback(() => {
    setCompose({ identityId: identityForMailbox(mailboxId) });
  }, [identityForMailbox, mailboxId]);

  // Reply / reply-all / forward, prefilled from a message (it has the body).
  const handleReply = useCallback(
    (message: MessageDetail, kind: ComposeKind) => {
      const identityId = identityForMailbox(message.mailboxId);
      if (kind === "forward") {
        const when = new Date(message.date).toLocaleString();
        const block =
          `\n\n---------- Forwarded message ----------\n` +
          `From: ${message.fromAddr}\nDate: ${when}\n` +
          `Subject: ${message.subject}\nTo: ${message.toAddrs.join(", ")}\n\n` +
          `${message.bodyText || ""}\n`;
        setCompose({
          identityId,
          subject: fwdSubject(message.subject),
          body: block,
        });
        return;
      }
      const cc =
        kind === "replyAll"
          ? message.toAddrs.filter(
              (addr) =>
                !ownAddresses.has(addr.toLowerCase()) &&
                addr.toLowerCase() !== message.fromAddr.toLowerCase(),
            )
          : [];
      setCompose({
        identityId,
        to: message.fromAddr,
        cc: cc.join(", "),
        subject: reSubject(message.subject),
        body: quoteBody(message),
        inReplyTo: message.id,
      });
    },
    [identityForMailbox, ownAddresses],
  );

  const selectedMailbox = mailboxes.find((m) => m.id === mailboxId) ?? null;

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100">
      <Sidebar
        user={user}
        mailboxes={mailboxes}
        selectedMailboxId={mailboxId}
        folder={folder}
        searching={activeQuery !== ""}
        onCompose={handleComposeNew}
        onSelectMailbox={(id) => {
          setMailboxId(id);
          setActiveQuery("");
        }}
        onSelectFolder={(f) => {
          setFolder(f);
          setActiveQuery("");
        }}
        onLogout={handleLogout}
      />
      <MessageList
        mailbox={selectedMailbox}
        folder={folder}
        items={items}
        loading={loadingList}
        hasMore={nextCursor !== null}
        activeQuery={activeQuery}
        selectedMessageId={selection?.messageId ?? null}
        error={error}
        onSearch={setActiveQuery}
        onLoadMore={loadMore}
        onSelect={handleSelect}
        onToggleStar={handleToggleStar}
      />
      <ThreadView
        key={selection ? `${selection.threadId}:${selection.messageId}` : "none"}
        selection={selection}
        onAuthError={onSignedOut}
        onToggleStar={handleToggleStar}
        onSetRead={handleSetRead}
        onMove={handleMove}
        onReply={handleReply}
      />
      {compose && (
        <ComposeModal
          identities={identities}
          initial={compose}
          onClose={() => setCompose(null)}
          onSent={handleSent}
        />
      )}
    </div>
  );
}
