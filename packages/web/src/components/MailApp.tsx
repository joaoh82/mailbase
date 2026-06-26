import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyLabel,
  listAllMessages,
  listIdentities,
  listLabels,
  listMailboxes,
  listMessages,
  logout,
  moveMessage,
  pollChanges,
  removeLabel,
  searchMessages,
  setRead,
  setStarred,
  type Folder,
  type Identity,
  type Label,
  type Mailbox,
  type MessageDetail,
  type MessageListItem,
  type User,
} from "../api";
import { isAuthError } from "../App";
import { isMessagePresent } from "../lib/messages";
import {
  type EmailBgMode,
  readEmailBgMode,
  readPollIntervalMs,
  writeEmailBgMode,
} from "../lib/preferences";
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
// The labels manager is light (no Tiptap), but lazy-loaded for consistency so
// it stays out of the initial bundle until opened (MAIL-16).
const LabelsModal = lazy(() =>
  import("./LabelsModal").then((m) => ({ default: m.LabelsModal })),
);
// The Calendar surface (MAIL-28) is its own pane, lazy-loaded so its grid/agenda
// code stays out of the initial bundle until the user opens Calendar.
const CalendarView = lazy(() =>
  import("./CalendarView").then((m) => ({ default: m.CalendarView })),
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
  // Which main surface is showing: the mail three-pane or the Calendar (MAIL-28).
  const [view, setView] = useState<"mail" | "calendar">("mail");
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
  // Live-update cadence (MAIL-14), in ms; 0 = off. Per-browser, from Settings.
  const [pollIntervalMs, setPollIntervalMs] = useState(readPollIntervalMs);
  // Reading-pane email background (MAIL-15): white vs blended-with-theme.
  // Per-browser; settable from Settings and the reading-pane header toggle, so
  // the write+setState pair is centralized here and shared with both surfaces.
  const [emailBgMode, setEmailBgMode] = useState(readEmailBgMode);
  // Labels (MAIL-16): the selected mailbox's labels for the sidebar/apply menu,
  // the active label filter (a label id, or null for plain folder view), and
  // the labels-manager modal.
  const [labels, setLabels] = useState<Label[]>([]);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [labelsManaging, setLabelsManaging] = useState(false);
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

  // Labels of the selected mailbox (MAIL-16) for the sidebar nav and the apply
  // menu. Mailbox-scoped, so the unified "all inboxes" view has none. Refetched
  // when the mailbox changes or after the labels manager edits them.
  const refreshLabels = useCallback(() => {
    if (!mailboxId || mailboxId === ALL_INBOXES) {
      setLabels([]);
      return;
    }
    listLabels(mailboxId)
      .then(({ labels }) => setLabels(labels))
      .catch(fail);
  }, [mailboxId, fail]);

  useEffect(refreshLabels, [refreshLabels]);

  // A label belongs to one mailbox, so any mailbox switch clears the filter —
  // this covers manual selection and the domain-switcher auto-fallback alike.
  useEffect(() => setLabelFilter(null), [mailboxId]);

  // Fetch page one for the active view (mailbox + folder, or a search). Shared
  // by the initial-load effect and the manual refresh so the two can't drift;
  // returns null when there's no mailbox selected yet.
  const loadFirstPage = useCallback(():
    | Promise<{ messages: MessageListItem[]; nextCursor: string | null }>
    | null => {
    if (!mailboxId) return null;
    if (isAll) return listAllMessages(folder);
    if (activeQuery)
      return searchMessages(mailboxId, activeQuery).then((r) => ({
        messages: r.messages,
        nextCursor: null as string | null,
      }));
    return listMessages(mailboxId, folder, undefined, labelFilter);
  }, [mailboxId, isAll, folder, activeQuery, labelFilter]);

  // (Re)load page one whenever mailbox, folder, active search, or a send change.
  // This clears the list and selection first (the view is changing under us);
  // the manual refresh path below instead replaces items in place.
  useEffect(() => {
    const load = loadFirstPage();
    if (!load) return;
    const seq = ++loadSeq.current;
    setLoadingList(true);
    setItems([]);
    setNextCursor(null);
    setSelection(null);
    setError(null);
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
  }, [loadFirstPage, reloadNonce, fail]);

  // Manual refresh: re-fetch the current view from the top and replace the list
  // in place — no full page reload. Unlike the effect above we keep the open
  // message selected if it survived the reload, and don't blank the list while
  // the refetch is in flight (so scroll position holds). Bumping loadSeq means a
  // slow in-flight load/loadMore can't clobber the fresh result, and the
  // loadingList guard keeps the button from double-firing.
  const refreshList = useCallback(() => {
    const load = loadFirstPage();
    if (!load || loadingList) return;
    const seq = ++loadSeq.current;
    setLoadingList(true);
    setError(null);
    load
      .then((page) => {
        if (seq !== loadSeq.current) return;
        setItems(page.messages);
        setNextCursor(page.nextCursor);
        setSelection((sel) =>
          isMessagePresent(page.messages, sel?.messageId) ? sel : null,
        );
      })
      .catch(fail)
      .finally(() => {
        if (seq === loadSeq.current) setLoadingList(false);
      });
    // Keep unread counts / folder badges in step with the refreshed list.
    refreshMailboxes();
  }, [loadFirstPage, loadingList, refreshMailboxes, fail]);

  // Press "r" to refresh — but never while typing (search box, composer) or
  // with a modal open, and not when a modifier is held (Cmd+R = reload).
  const anyModalOpen = Boolean(
    compose || managing || adminOpen || settingsOpen || labelsManaging,
  );
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "r" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (anyModalOpen) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA")
      )
        return;
      e.preventDefault();
      refreshList();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anyModalOpen, refreshList]);

  // Live updates (MAIL-14): poll a cheap "changes since" signal and reuse the
  // MAIL-13 refresh path whenever the active view's underlying data moved. This
  // is the polling baseline; the Durable Objects push path (DESIGN.md §8) can
  // layer on later and trigger the same refetch. Idle cost stays bounded — we
  // poll only while the tab is visible, on the user-chosen interval, and
  // immediately on focus / visibility regain. The latest blocking state and
  // refresh fn are read through a ref so the interval never has to reset on
  // every render — only when the cadence itself changes.
  const liveRef = useRef({ anyModalOpen, activeQuery, refreshList });
  liveRef.current = { anyModalOpen, activeQuery, refreshList };
  const lastSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    // "Off" (0) disables auto-updates entirely; the manual Refresh still works.
    if (pollIntervalMs <= 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = () => {
      pollChanges()
        .then(({ mailboxes }) => {
          if (stopped) return;
          const signature = mailboxes
            .map((m) => `${m.id}:${m.latestAt ?? 0}:${m.unread}`)
            .sort()
            .join("|");
          // The first response is just a baseline — the open view already
          // reflects current state, so there's nothing to refetch yet.
          if (lastSignatureRef.current === null) {
            lastSignatureRef.current = signature;
            return;
          }
          if (signature === lastSignatureRef.current) return;
          const { anyModalOpen: blocked, activeQuery: query, refreshList: refresh } =
            liveRef.current;
          // Defer while a modal or an active search would be disrupted; the
          // signature stays "dirty" so the next poll (or a manual refresh) picks
          // the change up once we're unblocked.
          if (blocked || query) return;
          lastSignatureRef.current = signature;
          refresh();
        })
        .catch((err) => {
          // A dead session falls back to login like any other call; transient
          // errors are swallowed so the loop keeps trying next tick.
          if (isAuthError(err)) onSignedOut();
        });
    };

    const start = () => {
      if (timer !== null) return;
      poll();
      timer = setInterval(poll, pollIntervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", poll);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", poll);
    };
    // Re-runs when the cadence changes: the old interval/listeners are torn down
    // and restarted. lastSignatureRef is a ref, so the baseline survives the
    // restart and changing the cadence never triggers a spurious refetch.
  }, [onSignedOut, pollIntervalMs]);

  const loadMore = useCallback(() => {
    if (!mailboxId || !nextCursor || loadingList || activeQuery) return;
    const seq = loadSeq.current;
    setLoadingList(true);
    const more = isAll
      ? listAllMessages(folder, nextCursor)
      : listMessages(mailboxId, folder, nextCursor, labelFilter);
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
  }, [
    mailboxId,
    isAll,
    folder,
    nextCursor,
    loadingList,
    activeQuery,
    labelFilter,
    fail,
  ]);

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

  // Persist + apply the reading-pane background choice (MAIL-15) from either
  // surface (Settings select or the per-message header toggle).
  const handleEmailBgModeChange = useCallback((mode: EmailBgMode) => {
    writeEmailBgMode(mode);
    setEmailBgMode(mode);
  }, []);

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

  // Selecting a label filters the mailbox's inbox to messages carrying it
  // (MAIL-16). Like folder selection, it clears any active search; it pins the
  // folder to inbox so "filter the inbox by label" is the default.
  const handleSelectLabel = useCallback((labelId: string) => {
    setFolder("inbox");
    setLabelFilter(labelId);
    setActiveQuery("");
    setView("mail");
  }, []);

  // Apply / remove a label from the reading pane, mirroring the change onto the
  // list row optimistically so its chips update without a refetch.
  const handleApplyLabel = useCallback(
    (id: string, label: Label) => {
      setItems((prev) =>
        prev.map((m) =>
          m.id === id && !m.labels.some((l) => l.id === label.id)
            ? {
                ...m,
                labels: [...m.labels, label].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              }
            : m,
        ),
      );
      applyLabel(id, label.id).catch(fail);
    },
    [fail],
  );

  const handleRemoveLabel = useCallback(
    (id: string, labelId: string) => {
      setItems((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, labels: m.labels.filter((l) => l.id !== labelId) }
            : m,
        ),
      );
      removeLabel(id, labelId).catch(fail);
    },
    [fail],
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
        calendarActive={view === "calendar"}
        canManage={Boolean(canManage && selectedMailbox)}
        totalUnread={totalUnread}
        labels={labels}
        labelFilter={labelFilter}
        onCompose={handleComposeNew}
        onSelectDomain={setDomainFilter}
        onSelectMailbox={(id) => {
          setMailboxId(id);
          setActiveQuery("");
        }}
        onSelectFolder={(f) => {
          setFolder(f);
          setActiveQuery("");
          setLabelFilter(null);
          setView("mail");
        }}
        onSelectLabel={handleSelectLabel}
        onOpenCalendar={() => setView("calendar")}
        onManageLabels={() => setLabelsManaging(true)}
        onManage={() => setManaging(true)}
        onOpenAdmin={() => setAdminOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={handleLogout}
      />
      {view === "calendar" ? (
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center bg-slate-950">
              <p className="text-sm text-slate-400">Loading calendar…</p>
            </div>
          }
        >
          <CalendarView
            mailboxId={isAll || !mailboxId ? undefined : mailboxId}
            mailboxLabel={
              isAll ? "All inboxes" : (selectedMailbox?.address ?? "Calendar")
            }
            mailboxes={mailboxes}
            onAuthError={onSignedOut}
          />
        </Suspense>
      ) : (
        <>
          <MessageList
            mailbox={selectedMailbox}
            folder={folder}
            items={items}
            loading={loadingList}
            hasMore={nextCursor !== null}
            activeQuery={activeQuery}
            activeLabelName={labels.find((l) => l.id === labelFilter)?.name}
            selectedMessageId={selection?.messageId ?? null}
            error={error}
            allInboxes={isAll}
            onSearch={(q) => {
              setActiveQuery(q);
              if (q) setLabelFilter(null);
            }}
            onRefresh={refreshList}
            onLoadMore={loadMore}
            onSelect={handleSelect}
            onToggleStar={handleToggleStar}
          />
          <ThreadView
            key={
              selection ? `${selection.threadId}:${selection.messageId}` : "none"
            }
            selection={selection}
            onAuthError={onSignedOut}
            onToggleStar={handleToggleStar}
            onSetRead={handleSetRead}
            onMove={handleMove}
            onReply={handleReply}
            onApplyLabel={handleApplyLabel}
            onRemoveLabel={handleRemoveLabel}
            emailBgMode={emailBgMode}
            onEmailBgModeChange={handleEmailBgModeChange}
          />
        </>
      )}
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
            pollIntervalMs={pollIntervalMs}
            onPollIntervalChange={setPollIntervalMs}
            emailBgMode={emailBgMode}
            onEmailBgModeChange={handleEmailBgModeChange}
            onClose={() => setSettingsOpen(false)}
            onSaved={refreshIdentities}
          />
        </Suspense>
      )}
      {labelsManaging && selectedMailbox && (
        <Suspense fallback={<ModalFallback />}>
          <LabelsModal
            mailbox={selectedMailbox}
            onClose={() => setLabelsManaging(false)}
            onChanged={refreshLabels}
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
