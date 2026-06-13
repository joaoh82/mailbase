import {
  ArrowLeft,
  CheckCircle2,
  Globe,
  Plus,
  X,
} from "lucide-react";
import { EXISTING_DOMAIN, MAILBOX } from "../data";

type View = "list" | "add" | "success";

// The admin Domains overlay, mirroring packages/web AdminPanel.tsx: a list view,
// an add-domain form, and the green success state. Driven entirely by props so a
// scene can step it through list -> typing -> added.
export function DomainsModal({
  view,
  typed,
  caret = 0,
  appear = 1,
  ctaPress = 0,
}: {
  view: View;
  typed: string;
  caret?: number;
  appear?: number;
  ctaPress?: number;
}) {
  return (
    <div className="absolute inset-0 flex items-start justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        style={{ opacity: appear }}
      />
      <div
        className="relative mt-[70px] w-[1080px] space-y-6 rounded-2xl border border-slate-800 bg-slate-900 p-8"
        style={{
          opacity: appear,
          transform: `scale(${0.92 + appear * 0.08})`,
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-3 text-[28px] font-semibold text-slate-100">
            <Globe className="h-7 w-7 text-sky-400" /> Domains
          </h2>
          <X className="h-6 w-6 text-slate-500" />
        </div>

        {view === "list" && <ListView />}
        {view === "add" && (
          <AddView typed={typed} caret={caret} ctaPress={ctaPress} />
        )}
        {view === "success" && <SuccessView typed={typed} />}
      </div>
    </div>
  );
}

function ListView() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-6">
        <p className="text-[19px] text-slate-400">
          Every domain, mailbox and address is a database row — adding one
          never redeploys.
        </p>
        <button className="flex shrink-0 items-center gap-2 rounded-md bg-sky-600 px-5 py-2.5 text-[18px] font-medium text-white">
          <Plus className="h-5 w-5" /> Add domain
        </button>
      </div>
      <div className="flex items-center gap-4 rounded-lg border border-slate-800 bg-slate-800/40 px-5 py-4">
        <span className="flex-1 text-[20px] font-medium text-slate-100">
          {EXISTING_DOMAIN.name}
        </span>
        <span className="text-[16px] text-slate-500">
          {EXISTING_DOMAIN.detail}
        </span>
        <span className="rounded-md bg-emerald-900/60 px-2.5 py-1 text-[15px] text-emerald-300">
          verified
        </span>
      </div>
    </div>
  );
}

function AddView({
  typed,
  caret,
  ctaPress,
}: {
  typed: string;
  caret: number;
  ctaPress: number;
}) {
  const domainShown = typed || "";
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-[16px] text-slate-400">
        <ArrowLeft className="h-4 w-4" /> All domains
      </div>
      <p className="text-[19px] leading-relaxed text-slate-400">
        Creates the Cloudflare zone, registers the domain with Resend, and
        inserts the domain row with a default mailbox. You then delegate
        nameservers and provision the mail records.
      </p>

      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[14px] font-medium uppercase tracking-wide text-slate-500">
            Domain
          </label>
          <div className="flex items-center rounded-md border border-sky-500/70 bg-slate-900 px-4 py-3 text-[20px] text-slate-100">
            {domainShown ? (
              <span>{domainShown}</span>
            ) : (
              <span className="text-slate-600">example.com</span>
            )}
            <span
              className="ml-0.5 inline-block h-6 w-[2px] bg-sky-400"
              style={{ opacity: caret }}
            />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[14px] font-medium uppercase tracking-wide text-slate-500">
            Default mailbox
          </label>
          <div className="rounded-md border border-slate-700 bg-slate-900 px-4 py-3 text-[20px] text-slate-100">
            hello
          </div>
          <p className="mt-1.5 text-[15px] text-slate-500">
            Creates hello@{domainShown || "example.com"} and makes you its
            owner.
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          className="flex items-center gap-2 rounded-md bg-sky-600 px-5 py-2.5 text-[18px] font-medium text-white"
          style={{ transform: `scale(${1 - ctaPress * 0.06})` }}
        >
          <Plus className="h-5 w-5" /> Add domain
        </button>
      </div>
    </div>
  );
}

function SuccessView({ typed }: { typed: string }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-[16px] text-slate-400">
        <ArrowLeft className="h-4 w-4" /> All domains
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-5">
        <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-400" />
        <div>
          <p className="text-[21px] font-medium text-emerald-300">
            {typed} added.
          </p>
          <p className="text-[17px] text-slate-400">
            Default mailbox and a send-as identity were created and assigned to
            you.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-sky-900 bg-sky-950/30 p-5">
        <p className="text-[18px] font-medium text-sky-300">
          Domains are database rows, not infrastructure.
        </p>
        <p className="mt-1 text-[16px] text-slate-400">
          No redeploy, no new Worker — {typed} and {MAILBOX.split("@")[0]}@
          {typed} are live the moment you delegate nameservers.
        </p>
      </div>
    </div>
  );
}
