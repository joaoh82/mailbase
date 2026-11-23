import { Paperclip, RefreshCw } from "lucide-react";
import type { Draft } from "../api";
import { formatListDate } from "./MessageList";

// The Drafts view (Phase 8): your server-side drafts for the selected mailbox
// (or every mailbox), newest edit first — including drafts an agent created
// for you with an API token. Opening one loads it into the composer.

const MODE_LABEL: Record<Draft["mode"], string> = {
  new: "",
  reply: "Reply",
  reply_all: "Reply all",
  forward: "Forward",
};

export function DraftsList({
  drafts,
  loading,
  error,
  onOpen,
  onRefresh,
}: {
  drafts: Draft[];
  loading: boolean;
  error: string | null;
  onOpen: (draft: Draft) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 p-3">
        <p className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Drafts
        </p>
        <button
          aria-label="Refresh drafts"
          className="text-slate-400 hover:text-slate-200"
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </button>
      </header>
      {error && <p className="p-3 text-xs text-red-400">{error}</p>}
      {!loading && drafts.length === 0 && !error && (
        <p className="p-6 text-center text-sm text-slate-500">No drafts.</p>
      )}
      <ul className="flex-1 divide-y divide-slate-800 overflow-y-auto">
        {drafts.map((d) => (
          <li key={d.id}>
            <button
              className="flex w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-slate-900"
              onClick={() => onOpen(d)}
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="truncate text-slate-400">
                  {d.to.length ? `To: ${d.to.join(", ")}` : "(no recipients)"}
                </span>
                <span className="flex-1" />
                {d.attachments.length > 0 && (
                  <Paperclip className="h-3.5 w-3.5 text-slate-500" />
                )}
                <span className="shrink-0 text-xs text-slate-500">
                  {formatListDate(d.updatedAt)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {MODE_LABEL[d.mode] && (
                  <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-400">
                    {MODE_LABEL[d.mode]}
                  </span>
                )}
                <span className="truncate text-sm font-medium text-slate-100">
                  {d.subject || "(no subject)"}
                </span>
              </div>
              <span className="truncate text-xs text-slate-500">
                {d.text.replace(/\s+/g, " ").trim().slice(0, 160)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
