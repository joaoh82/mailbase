import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listAllMessages,
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
import { AdminPanel } from "./AdminPanel";
import type { ComposeInitial } from "./ComposeModal";
import { MessageList } from "./MessageList";
import { ALL_DOMAINS, ALL_INBOXES, Sidebar } from "./Sidebar";
import { ThreadView } from "./ThreadView";

// These modals pull in Tiptap/ProseMirror (~300 KB) for the rich-text editor,
// which the rest of the app never touches. Load them on demand so the editor
// stays in its own async chunk instead of the initial bundle (MAIL-6/MAIL-4):
// the composer when `compose` is set, the manage/settings modals when opened.
const ComposeModal = lazy(() =>
  import("./ComposeModal").then((m) => ({ default: m.ComposeModal })),
);
const ManageMailboxModal = lazy(() =>
  import("./ManageMailboxModal").then((m) => ({ default: m.ManageMailboxModal })),
);
const SettingsModal = lazy(() =>
  import("./SettingsModal").then((m) => ({ default: m.SettingsModal })),
);

// Shared loading shell for the lazy modals above.
function ModalFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <p className="text-sm text-slate-400">Loading…</p>
    </div>
  );
}

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
  const [domainFilter, setDomainFilter] = useState<string>(ALL_DOMAINS);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [activeQuery, setActiveQuery] = useState("");
  const [items, setItems] = useState<MessageListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [compose, setCompose] = useState<ComposeInitial | null>(null);
  const [managing, setManaging] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadSeq = useRef(0);

  const isAll = mailboxId === ALL_INBOXES;

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
        // Land on the unified view when there's more than one mailbox; a
        // single-mailbox user goes straight to it.
        setMailboxId(
          (current) =>
            current ??
            (mailboxes.length > 1 ? ALL_INBOXES : mailboxes[0]?.id) ??
            null,
        );
      })
      .catch(fail);
  }, [fail]);

  useEffect(refreshMailboxes, [refreshMailboxes]);

  // Send-as identities, with their resolved signatures; the composer and the
  // settings modal need them. Re-fetched after membership/domain/signature
  // changes so a new identity or an edited signature shows up immediately.
  const refreshIdentities = useCallback(() => {
    listIdentities()
      .then(({ identities }) => setIdentities(identities))
      .catch(fail);
  }, [fail]);

  useEffect(refreshIdentities, [refreshIdentities]);

  // (Re)load page one whenever mailbox, folder, active search, or a send change.
  useEffect(() => {
    if (!mailboxId) return;
    const seq = ++loadSeq.current;
    setLoadingList(true);
    setItems([]);
    setNextCursor(null);
    setSelection(null);
    setError(null);
    const load = isAll
      ? listAllMessages(folder)
      : activeQuery
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
  }, [mailboxId, isAll, folder, activeQuery, reloadNonce, fail]);

  const loadMore = useCallback(() => {
    if (!mailboxId || !nextCursor || loadingList || activeQuery) return;
    const seq = loadSeq.current;
    setLoadingList(true);
    const more = isAll
      ? listAllMessages(folder, nextCursor)
      : listMessages(mailboxId, folder, nextCursor);
    more
      .then((page) => {
        if (seq !== loadSeq.current) return;
        setItems((prev) => [...prev, ...page.messages]);
        setNextCursor(page.nextCursor);
      })
      .catch(fail)
      .finally(() => {
        if (seq === loadSeq.current) setLoadingList(false);
      });
  }, [mailboxId, isAll, folder, nextCursor, loadingList, activeQuery, fail]);

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
  const canManage =
    user.isAdmin || selectedMailbox?.role === "owner";

  // Distinct domains and the mailbox list narrowed by the domain switcher
  // (Phase 5). The switcher only filters the individual mailbox list; the
  // "All inboxes" view always spans every mailbox.
  const domains = useMemo(
    () => [...new Set(mailboxes.map((m) => m.domain))].sort(),
    [mailboxes],
  );
  const visibleMailboxes = useMemo(
    () =>
      domainFilter === ALL_DOMAINS
        ? mailboxes
        : mailboxes.filter((m) => m.domain === domainFilter),
    [mailboxes, domainFilter],
  );
  const totalUnread = useMemo(
    () => mailboxes.reduce((sum, m) => sum + m.unread, 0),
    [mailboxes],
  );

  // Keep the mailbox selector and the message list in sync with the domain
  // switcher: if narrowing the domain hides the currently-selected mailbox,
  // fall back to that domain's first mailbox (or the unified view).
  useEffect(() => {
    if (isAll) return;
    if (mailboxId && !visibleMailboxes.some((m) => m.id === mailboxId)) {
      setMailboxId(visibleMailboxes[0]?.id ?? ALL_INBOXES);
      setActiveQuery("");
    }
  }, [isAll, mailboxId, visibleMailboxes]);

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100">
      <Sidebar
        user={user}
        mailboxes={visibleMailboxes}
        domains={domains}
        domainFilter={domainFilter}
        selectedMailboxId={mailboxId}
        folder={folder}
        searching={activeQuery !== ""}
        canManage={Boolean(canManage && selectedMailbox)}
        totalUnread={totalUnread}
        onCompose={handleComposeNew}
        onSelectDomain={setDomainFilter}
        onSelectMailbox={(id) => {
          setMailboxId(id);
          setActiveQuery("");
        }}
        onSelectFolder={(f) => {
          setFolder(f);
          setActiveQuery("");
        }}
        onManage={() => setManaging(true)}
        onOpenAdmin={() => setAdminOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
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
        allInboxes={isAll}
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
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <p className="text-sm text-slate-400">Loading composer…</p>
            </div>
          }
        >
          <ComposeModal
            identities={identities}
            initial={compose}
            onClose={() => setCompose(null)}
            onSent={handleSent}
          />
        </Suspense>
      )}
      {managing && selectedMailbox && (
        <Suspense fallback={<ModalFallback />}>
          <ManageMailboxModal
            mailbox={selectedMailbox}
            currentUserId={user.id}
            onClose={() => {
              setManaging(false);
              // Membership/identity/signature changes may affect this view.
              refreshMailboxes();
              refreshIdentities();
            }}
          />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={<ModalFallback />}>
          <SettingsModal
            identities={identities}
            onClose={() => setSettingsOpen(false)}
            onSaved={refreshIdentities}
          />
        </Suspense>
      )}
      {adminOpen && (
        <AdminPanel
          onClose={() => {
            setAdminOpen(false);
            // A new domain adds a mailbox + identities for this admin.
            refreshMailboxes();
            refreshIdentities();
          }}
        />
      )}
    </div>
  );
}
