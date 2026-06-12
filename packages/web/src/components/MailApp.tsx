import { useCallback, useEffect, useRef, useState } from "react";
import {
  listMailboxes,
  listMessages,
  logout,
  moveMessage,
  searchMessages,
  setRead,
  setStarred,
  type Folder,
  type Mailbox,
  type MessageListItem,
  type User,
} from "../api";
import { isAuthError } from "../App";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { ThreadView } from "./ThreadView";

export interface Selection {
  messageId: string;
  threadId: string | null;
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

  // (Re)load page one whenever mailbox, folder, or active search changes.
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
  }, [mailboxId, folder, activeQuery, fail]);

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

  const selectedMailbox = mailboxes.find((m) => m.id === mailboxId) ?? null;

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100">
      <Sidebar
        user={user}
        mailboxes={mailboxes}
        selectedMailboxId={mailboxId}
        folder={folder}
        searching={activeQuery !== ""}
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
      />
    </div>
  );
}
