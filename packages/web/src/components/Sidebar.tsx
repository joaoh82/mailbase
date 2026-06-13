import {
  Archive,
  Globe,
  Inbox,
  LogOut,
  OctagonAlert,
  PenSquare,
  Send,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import type { Folder, Mailbox, User } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Logo } from "./ui/Logo";

/** Sentinel mailbox id for the unified "all inboxes" view (Phase 5). */
export const ALL_INBOXES = "all";
/** Sentinel domain value for "show mailboxes from every domain". */
export const ALL_DOMAINS = "all";

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
  domains,
  domainFilter,
  selectedMailboxId,
  folder,
  searching,
  canManage,
  totalUnread,
  onCompose,
  onSelectDomain,
  onSelectMailbox,
  onSelectFolder,
  onManage,
  onOpenAdmin,
  onOpenSettings,
  onLogout,
}: {
  user: User;
  mailboxes: Mailbox[];
  domains: string[];
  domainFilter: string;
  selectedMailboxId: string | null;
  folder: Folder;
  searching: boolean;
  canManage: boolean;
  totalUnread: number;
  onCompose: () => void;
  onSelectDomain: (domain: string) => void;
  onSelectMailbox: (id: string) => void;
  onSelectFolder: (folder: Folder) => void;
  onManage: () => void;
  onOpenAdmin: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const isAll = selectedMailboxId === ALL_INBOXES;
  const selected = mailboxes.find((m) => m.id === selectedMailboxId);
  const inboxBadge = isAll ? totalUnread : (selected?.unread ?? 0);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900 p-3">
      <div className="flex items-center gap-2 px-2">
        <Logo className="h-5 w-5" />
        <h1 className="text-lg font-semibold tracking-tight">mailbase</h1>
      </div>

      <Button className="mt-4 w-full" onClick={onCompose}>
        <PenSquare className="h-4 w-4" /> Compose
      </Button>

      {domains.length > 1 && (
        <>
          <label className="mt-4 block px-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            Domain
          </label>
          <select
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            value={domainFilter}
            onChange={(e) => onSelectDomain(e.target.value)}
          >
            <option value={ALL_DOMAINS}>All domains</option>
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </>
      )}

      <div className="mt-4 flex items-center justify-between px-2">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Mailbox
        </label>
        {canManage && (
          <button
            onClick={onManage}
            title="Manage members & invites"
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
          >
            <Users className="h-3.5 w-3.5" /> Manage
          </button>
        )}
      </div>
      <select
        className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
        value={selectedMailboxId ?? ""}
        onChange={(e) => onSelectMailbox(e.target.value)}
      >
        <option value={ALL_INBOXES}>📥 All inboxes</option>
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
            {id === "inbox" && inboxBadge > 0 && (
              <span className="rounded-full bg-sky-600 px-1.5 text-xs font-semibold text-white">
                {inboxBadge}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-auto space-y-1 border-t border-slate-800 pt-3">
        {user.isAdmin && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={onOpenAdmin}
          >
            <Globe className="h-3.5 w-3.5" /> Domains
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={onOpenSettings}
        >
          <Settings className="h-3.5 w-3.5" /> Signature
        </Button>
        <p className="truncate px-2 text-xs text-slate-500" title={user.email}>
          {user.displayName || user.email}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={onLogout}
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </Button>
      </div>
    </aside>
  );
}
