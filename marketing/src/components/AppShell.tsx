import {
  Archive,
  ChevronDown,
  Forward,
  Globe,
  Image as ImageIcon,
  Inbox,
  LogOut,
  MailOpen,
  OctagonAlert,
  Paperclip,
  PenSquare,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  Star,
  Trash2,
} from "lucide-react";
import type { CSSProperties } from "react";
import { FOLDERS, MAILBOX, type Mail } from "../data";
import { LogoGlyph } from "./Brand";

const ROW_H = 98;

// ---------------------------------------------------------------------------
// Sidebar — folder nav + mailbox switcher, mirroring packages/web Sidebar.tsx
// ---------------------------------------------------------------------------

const FOLDER_ICONS = {
  Inbox,
  Archive,
  Sent: Send,
  Spam: OctagonAlert,
  Trash: Trash2,
} as const;

export function Sidebar({
  unread,
  badgePop = 0,
  highlightDomains = 0,
}: {
  unread: number;
  badgePop?: number;
  highlightDomains?: number;
}) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-r border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2.5 px-1">
        <LogoGlyph className="h-7 w-7 text-sky-500" />
        <h1 className="text-[26px] font-semibold tracking-tight text-slate-100">
          mailbase
        </h1>
      </div>

      <button className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-sky-600 py-2.5 text-[18px] font-medium text-white">
        <PenSquare className="h-5 w-5" /> Compose
      </button>

      <p className="mt-6 px-1 text-[13px] font-medium uppercase tracking-wide text-slate-500">
        Mailbox
      </p>
      <div className="mt-1.5 flex items-center justify-between rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-[17px] text-slate-200">
        {MAILBOX}
        <ChevronDown className="h-4 w-4 text-slate-500" />
      </div>

      <nav className="mt-5 space-y-1">
        {FOLDERS.map((label) => {
          const Icon = FOLDER_ICONS[label];
          const active = label === "Inbox";
          return (
            <div
              key={label}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-[19px] ${
                active
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-300"
              }`}
            >
              <Icon className="h-[22px] w-[22px]" />
              <span className="flex-1">{label}</span>
              {label === "Inbox" && unread > 0 && (
                <span
                  className="rounded-full bg-sky-600 px-2 py-0.5 text-[14px] font-semibold text-white"
                  style={{ transform: `scale(${1 + badgePop * 0.5})` }}
                >
                  {unread}
                </span>
              )}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto space-y-1 border-t border-slate-800 pt-4">
        <SidebarFooterItem
          icon={<Globe className="h-[18px] w-[18px]" />}
          label="Domains"
          highlight={highlightDomains}
        />
        <SidebarFooterItem
          icon={<Settings className="h-[18px] w-[18px]" />}
          label="Signature"
        />
        <p className="px-2 pt-1 text-[15px] text-slate-500">Josh</p>
        <SidebarFooterItem
          icon={<LogOut className="h-[18px] w-[18px]" />}
          label="Sign out"
        />
      </div>
    </aside>
  );
}

function SidebarFooterItem({
  icon,
  label,
  highlight = 0,
}: {
  icon: React.ReactNode;
  label: string;
  highlight?: number;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-2 text-[17px] text-slate-300"
      style={{
        backgroundColor: `rgba(30, 41, 59, ${highlight})`,
        color: highlight > 0.4 ? "rgb(241 245 249)" : undefined,
      }}
    >
      {icon}
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message list — fixed-height rows, optional "incoming" reveal for the top row
// ---------------------------------------------------------------------------

export function MessageList({
  messages,
  selectedId,
  incoming = 1,
}: {
  messages: Mail[];
  selectedId?: string | null;
  // 0..1 reveal applied to messages[0] only (the freshly-arrived mail).
  incoming?: number;
}) {
  return (
    <section className="flex w-[600px] shrink-0 flex-col border-r border-slate-800 bg-slate-950">
      <header className="border-b border-slate-800 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate-500" />
          <div className="rounded-md border border-slate-700 bg-slate-900 py-2.5 pl-11 pr-3 text-[17px] text-slate-500">
            Search {MAILBOX}…
          </div>
        </div>
        <p className="mt-3 px-1 text-[13px] font-medium uppercase tracking-wide text-slate-500">
          Inbox — {MAILBOX}
        </p>
      </header>

      <div className="flex-1 overflow-hidden">
        {messages.map((m, i) => {
          const reveal = i === 0 ? incoming : 1;
          const wrapperStyle: CSSProperties =
            i === 0
              ? {
                  height: ROW_H * reveal,
                  opacity: Math.min(1, reveal * 1.4),
                  overflow: "hidden",
                }
              : {};
          // Fresh-arrival highlight: a sky wash that blooms then fades out.
          const bloom =
            i === 0
              ? Math.max(
                  0,
                  reveal < 0.6
                    ? reveal / 0.6
                    : 1 - (reveal - 0.6) / 0.4,
                )
              : 0;
          return (
            <div key={m.id} style={wrapperStyle}>
              <MessageRow
                mail={m}
                selected={m.id === selectedId}
                bloom={bloom}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MessageRow({
  mail,
  selected,
  bloom,
}: {
  mail: Mail;
  selected: boolean;
  bloom: number;
}) {
  return (
    <div
      className={`relative flex gap-3 border-b border-slate-800/60 px-4 ${
        selected ? "bg-slate-900" : mail.unread ? "bg-slate-900/40" : ""
      }`}
      style={{ height: ROW_H, alignItems: "flex-start", paddingTop: 14 }}
    >
      {bloom > 0 && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            boxShadow: `inset 0 0 0 2px rgba(56, 189, 248, ${0.7 * bloom})`,
            backgroundColor: `rgba(56, 189, 248, ${0.1 * bloom})`,
          }}
        />
      )}
      <Star
        className={`mt-1 h-5 w-5 shrink-0 ${
          mail.starred ? "fill-yellow-400 text-yellow-400" : "text-slate-600"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-[19px] ${
              mail.unread
                ? "font-semibold text-slate-100"
                : "text-slate-400"
            }`}
          >
            {mail.fromName}
          </span>
          <span className="shrink-0 text-[15px] text-slate-500">
            {mail.date}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {mail.attachment && (
            <Paperclip className="h-4 w-4 shrink-0 text-slate-500" />
          )}
          <span
            className={`truncate text-[18px] ${
              mail.unread
                ? "font-medium text-slate-200"
                : "text-slate-400"
            }`}
          >
            {mail.subject}
          </span>
        </div>
        <p className="truncate text-[15px] text-slate-500">{mail.snippet}</p>
      </div>
      {mail.unread && (
        <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-sky-500" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reading pane — rendered message, mirroring packages/web MessageView.tsx
// ---------------------------------------------------------------------------

const ACTION_ICONS = [Reply, ReplyAll, Forward, Star, MailOpen, Archive, Trash2];

export function ReadingPane({
  mail,
  reveal = 1,
}: {
  mail: Mail | null;
  reveal?: number;
}) {
  if (!mail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-slate-950 text-slate-600">
        <LogoGlyph className="mb-4 h-16 w-16 text-slate-700" />
        <p className="text-[20px]">Select a message to read</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden bg-slate-950 p-7">
      <div
        style={{
          opacity: reveal,
          transform: `translateY(${(1 - reveal) * 24}px)`,
        }}
      >
        <h2 className="mb-4 text-[27px] font-semibold text-slate-100">
          {mail.subject}
        </h2>

        <article className="rounded-xl border border-slate-800 bg-slate-900/60">
          <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sky-600 text-[18px] font-semibold text-white">
                {mail.initials}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[20px] font-medium text-slate-100">
                  {mail.fromName}{" "}
                  <span className="text-[16px] font-normal text-slate-500">
                    &lt;{mail.fromEmail}&gt;
                  </span>
                </p>
                <p className="truncate text-[15px] text-slate-500">
                  to {mail.to}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-slate-400">
              {ACTION_ICONS.map((Icon, i) => (
                <div
                  key={i}
                  className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-slate-800"
                >
                  <Icon
                    className={`h-[18px] w-[18px] ${
                      Icon === Star ? "" : ""
                    }`}
                  />
                </div>
              ))}
            </div>
          </header>

          <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-5 py-2 text-[15px] text-slate-400">
            <ImageIcon className="h-4 w-4" />
            Remote images are blocked.
            <span className="rounded-md border border-slate-700 px-3 py-1 text-[14px] text-slate-200">
              Load images
            </span>
          </div>

          <div className="space-y-3 px-6 py-5 text-[18px] leading-relaxed text-slate-200">
            {mail.bodyParas?.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </article>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full three-pane shell
// ---------------------------------------------------------------------------

export type AppState = {
  unread: number;
  badgePop?: number;
  highlightDomains?: number;
  messages: Mail[];
  selectedId?: string | null;
  incoming?: number;
  reading: Mail | null;
  readingReveal?: number;
};

export function AppShell(props: AppState) {
  return (
    <div className="flex h-full w-full bg-slate-950 text-slate-100">
      <Sidebar
        unread={props.unread}
        badgePop={props.badgePop}
        highlightDomains={props.highlightDomains}
      />
      <MessageList
        messages={props.messages}
        selectedId={props.selectedId}
        incoming={props.incoming}
      />
      <ReadingPane mail={props.reading} reveal={props.readingReveal} />
    </div>
  );
}
