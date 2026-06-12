import {
  Archive,
  Inbox,
  LogOut,
  OctagonAlert,
  Send,
  Trash2,
} from "lucide-react";
import type { Folder, Mailbox, User } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

const FOLDERS: { id: Folder; label: string; icon: typeof Inbox }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "sent", label: "Sent", icon: Send },
  { id: "spam", label: "Spam", icon: OctagonAlert },
  { id: "trash", label: "Trash", icon: Trash2 },
];

export function Sidebar({
  user,
  mailboxes,
  selectedMailboxId,
  folder,
  searching,
  onSelectMailbox,
  onSelectFolder,
  onLogout,
}: {
  user: User;
  mailboxes: Mailbox[];
  selectedMailboxId: string | null;
  folder: Folder;
  searching: boolean;
  onSelectMailbox: (id: string) => void;
  onSelectFolder: (folder: Folder) => void;
  onLogout: () => void;
}) {
  const selected = mailboxes.find((m) => m.id === selectedMailboxId);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900 p-3">
      <h1 className="px-2 text-lg font-semibold tracking-tight">mailbase</h1>

      <label className="mt-4 block px-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        Mailbox
      </label>
      <select
        className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
        value={selectedMailboxId ?? ""}
        onChange={(e) => onSelectMailbox(e.target.value)}
      >
        {mailboxes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.address}
          </option>
        ))}
      </select>

      <nav className="mt-4 space-y-0.5">
        {FOLDERS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onSelectFolder(id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800",
              folder === id && !searching && "bg-slate-800 text-slate-100",
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="flex-1 text-left">{label}</span>
            {id === "inbox" && (selected?.unread ?? 0) > 0 && (
              <span className="rounded-full bg-sky-600 px-1.5 text-xs font-semibold text-white">
                {selected!.unread}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-auto border-t border-slate-800 pt-3">
        <p className="truncate px-2 text-xs text-slate-500" title={user.email}>
          {user.displayName || user.email}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start"
          onClick={onLogout}
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </Button>
      </div>
    </aside>
  );
}
