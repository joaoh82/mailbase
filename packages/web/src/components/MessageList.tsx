import { useVirtualizer } from "@tanstack/react-virtual";
import { Paperclip, Search, Star, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Folder, Mailbox, MessageListItem } from "../api";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";

export function formatListDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return date.toLocaleDateString();
}

export function MessageList({
  mailbox,
  folder,
  items,
  loading,
  hasMore,
  activeQuery,
  selectedMessageId,
  error,
  allInboxes = false,
  onSearch,
  onLoadMore,
  onSelect,
  onToggleStar,
}: {
  mailbox: Mailbox | null;
  folder: Folder;
  items: MessageListItem[];
  loading: boolean;
  hasMore: boolean;
  activeQuery: string;
  selectedMessageId: string | null;
  error: string | null;
  // The unified "all inboxes" view (Phase 5): no single mailbox, so search is
  // hidden and each row is tagged with the mailbox it landed in.
  allInboxes?: boolean;
  onSearch: (q: string) => void;
  onLoadMore: () => void;
  onSelect: (item: MessageListItem) => void;
  onToggleStar: (item: MessageListItem) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => setQuery(activeQuery), [activeQuery]);

  const rowCount = items.length + (hasMore ? 1 : 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    overscan: 10,
  });

  // Infinite scroll: reaching the loader row asks for the next page.
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (last && hasMore && !loading && last.index >= items.length - 1) {
      onLoadMore();
    }
  }, [virtualItems, hasMore, loading, items.length, onLoadMore]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    onSearch(query.trim());
  }

  return (
    <section className="flex w-96 shrink-0 flex-col border-r border-slate-800">
      <header className="border-b border-slate-800 p-3">
        {!allInboxes && (
          <form onSubmit={submitSearch} className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
            <Input
              className="pl-8 pr-8"
              placeholder={`Search ${mailbox?.address ?? "mail"}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {activeQuery && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute right-2 top-2.5 text-slate-400 hover:text-slate-200"
                onClick={() => onSearch("")}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </form>
        )}
        <p
          className={cn(
            "px-1 text-xs font-medium uppercase tracking-wide text-slate-500",
            !allInboxes && "mt-2",
          )}
        >
          {allInboxes
            ? `All inboxes — ${folder}`
            : activeQuery
              ? `Results for “${activeQuery}”`
              : `${folder} — ${mailbox?.address ?? ""}`}
        </p>
      </header>

      {error && (
        <p className="border-b border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {items.length === 0 && !loading ? (
          <p className="p-6 text-center text-sm text-slate-500">
            {activeQuery ? "No results." : "No messages in this folder."}
          </p>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((row) => {
              const item = items[row.index];
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {item ? (
                    <MessageRow
                      item={item}
                      selected={item.id === selectedMessageId}
                      onSelect={onSelect}
                      onToggleStar={onToggleStar}
                    />
                  ) : (
                    <p className="p-3 text-center text-xs text-slate-500">
                      Loading…
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function MessageRow({
  item,
  selected,
  onSelect,
  onToggleStar,
}: {
  item: MessageListItem;
  selected: boolean;
  onSelect: (item: MessageListItem) => void;
  onToggleStar: (item: MessageListItem) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(item)}
      className={cn(
        "flex cursor-pointer gap-2 border-b border-slate-800/60 px-3 py-2.5 hover:bg-slate-900",
        selected && "bg-slate-900",
        !item.isRead && "bg-slate-900/40",
      )}
    >
      <button
        aria-label={item.isStarred ? "Unstar" : "Star"}
        className="mt-0.5 shrink-0 text-slate-500 hover:text-yellow-400"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(item);
        }}
      >
        <Star
          className={cn(
            "h-4 w-4",
            item.isStarred && "fill-yellow-400 text-yellow-400",
          )}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm",
              item.isRead ? "text-slate-400" : "font-semibold text-slate-100",
            )}
          >
            {item.direction === "outbound"
              ? `To ${item.toAddrs.join(", ") || "(no recipient)"}`
              : item.fromAddr}
          </span>
          <span className="shrink-0 text-xs text-slate-500">
            {formatListDate(item.date)}
          </span>
        </div>
        {item.mailboxAddress && (
          <span className="mb-0.5 inline-block rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
            {item.mailboxAddress}
          </span>
        )}
        <div className="flex items-center gap-1.5">
          {item.hasAttachments && (
            <Paperclip className="h-3 w-3 shrink-0 text-slate-500" />
          )}
          <span
            className={cn(
              "truncate text-sm",
              item.isRead ? "text-slate-400" : "font-medium text-slate-200",
            )}
          >
            {item.subject || "(no subject)"}
          </span>
        </div>
        <p className="truncate text-xs text-slate-500">{item.snippet}</p>
      </div>
      {!item.isRead && (
        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-sky-500" />
      )}
    </div>
  );
}
