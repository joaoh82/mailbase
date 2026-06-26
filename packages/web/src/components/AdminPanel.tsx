import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  addDomain,
  type AddDomainResult,
  addDomainAddress,
  addDomainMailbox,
  type AdminDomain,
  type ApexMxConflict,
  ApiError,
  deleteDomainAddress,
  deleteDomainMailbox,
  type DomainDetail,
  type DomainStatus,
  getDomainDetail,
  getDomainStatus,
  listDomains,
  provisionDomain,
  type ProvisionResult,
  resolveMxConflict,
  setDomainPolicy,
  verifyDomain,
} from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type View =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "detail"; domainId: string };

const errMsg = (e: unknown) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);

// Admin-only domain management (Phase 5). One overlay with three views: the
// domain list, the add-domain wizard (which surfaces the manual nameserver
// step), and a per-domain detail page for mailboxes/addresses/catch-all and the
// live Cloudflare + Resend verification status.
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: "list" });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-3xl space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Globe className="h-5 w-5 text-sky-400" /> Domains
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {view.kind === "list" && (
          <DomainList
            onAdd={() => setView({ kind: "add" })}
            onOpen={(domainId) => setView({ kind: "detail", domainId })}
          />
        )}
        {view.kind === "add" && (
          <AddDomain
            onBack={() => setView({ kind: "list" })}
            onManage={(domainId) => setView({ kind: "detail", domainId })}
          />
        )}
        {view.kind === "detail" && (
          <DomainDetailView
            domainId={view.domainId}
            onBack={() => setView({ kind: "list" })}
          />
        )}
      </div>
    </div>
  );
}

function DomainList({
  onAdd,
  onOpen,
}: {
  onAdd: () => void;
  onOpen: (id: string) => void;
}) {
  const [domains, setDomains] = useState<AdminDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDomains()
      .then(({ domains }) => setDomains(domains))
      .catch((e) => setError(errMsg(e)));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          Every domain, mailbox and address is a database row — adding one never
          redeploys.
        </p>
        <Button size="sm" onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add domain
        </Button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {!domains && !error && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      <ul className="space-y-1">
        {domains?.map((d) => (
          <li key={d.id}>
            <button
              onClick={() => onOpen(d.id)}
              className="flex w-full items-center gap-3 rounded-md border border-slate-800 bg-slate-800/40 px-3 py-2 text-left text-sm hover:bg-slate-800"
            >
              <span className="flex-1 font-medium">{d.name}</span>
              <span className="text-xs text-slate-500">
                {d.mailboxCount} mailbox{d.mailboxCount === 1 ? "" : "es"} ·{" "}
                {d.addressCount} address{d.addressCount === 1 ? "" : "es"}
              </span>
              {d.managed ? (
                d.resendVerified ? (
                  <Badge tone="ok">verified</Badge>
                ) : (
                  <Badge tone="pending">pending</Badge>
                )
              ) : (
                <Badge tone="muted">manual</Badge>
              )}
            </button>
          </li>
        ))}
        {domains?.length === 0 && (
          <li className="text-sm text-slate-500">No domains yet.</li>
        )}
      </ul>
    </div>
  );
}

function AddDomain({
  onBack,
  onManage,
}: {
  onBack: () => void;
  onManage: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [mailbox, setMailbox] = useState("hello");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddDomainResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setResult(await addDomain(name.trim(), mailbox.trim()));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        <BackLink onClick={onBack} label="All domains" />
        <div className="rounded-md border border-emerald-900 bg-emerald-950/30 p-3 text-sm">
          <p className="font-medium text-emerald-300">
            {result.domain.name} added.
          </p>
          <p className="text-slate-400">
            Default mailbox and a send-as identity were created and assigned to
            you.
          </p>
        </div>

        {result.simulated && <SimulatedBanner />}

        <NameserverInstructions nameServers={result.nameServers} />

        <div>
          <h4 className="text-sm font-medium text-slate-300">
            DNS records for Resend (added automatically when you provision)
          </h4>
          <RecordsTable records={result.records} />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            Done
          </Button>
          <Button size="sm" onClick={() => onManage(result.domain.id)}>
            Manage &amp; provision
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink onClick={onBack} label="All domains" />
      <p className="text-sm text-slate-400">
        Creates (or reuses) the Cloudflare zone, registers the domain with
        Resend, and inserts the domain row with a default mailbox. You then
        delegate nameservers at your registrar and provision the mail records.
      </p>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Domain
          </label>
          <Input
            placeholder="example.com"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Default mailbox
          </label>
          <Input
            placeholder="hello"
            value={mailbox}
            onChange={(e) => setMailbox(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            Creates {mailbox.trim() || "hello"}@{name.trim() || "example.com"}{" "}
            and makes you its owner.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex justify-end">
        <Button size="sm" disabled={busy || !name.trim()} onClick={submit}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add domain
        </Button>
      </div>
    </div>
  );
}

function DomainDetailView({
  domainId,
  onBack,
}: {
  domainId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<DomainDetail | null>(null);
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [provision, setProvision] = useState<ProvisionResult | null>(null);
  // True once the operator chooses to remove the conflicting apex MX themselves,
  // so we hide the prompt until the next provision attempt.
  const [mxManual, setMxManual] = useState(false);

  const refreshDetail = useCallback(
    () => getDomainDetail(domainId).then(setDetail),
    [domainId],
  );

  const refreshStatus = useCallback(
    () => getDomainStatus(domainId).then(setStatus),
    [domainId],
  );

  useEffect(() => {
    refreshDetail().catch((e) => setError(errMsg(e)));
    refreshStatus().catch((e) => setError(errMsg(e)));
  }, [refreshDetail, refreshStatus]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  if (!detail) {
    return (
      <div className="space-y-4">
        <BackLink onClick={onBack} label="All domains" />
        {error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
      </div>
    );
  }

  const zoneActive = status?.zone?.status === "active";

  return (
    <div className="space-y-5">
      <BackLink onClick={onBack} label="All domains" />

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-base font-semibold">{detail.domain.name}</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => act("status", refreshStatus)}
        >
          {busy === "status" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}{" "}
          Status
        </Button>
        {detail.domain.managed && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act("provision", async () => {
                  setMxManual(false);
                  setProvision(await provisionDomain(domainId));
                  await refreshStatus();
                })
              }
            >
              {busy === "provision" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}{" "}
              Provision
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act("verify", async () => setStatus(await verifyDomain(domainId)))
              }
            >
              {busy === "verify" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}{" "}
              Verify
            </Button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {status?.simulated && <SimulatedBanner />}
      {!detail.domain.managed && (
        <p className="rounded-md border border-slate-800 bg-slate-800/40 p-3 text-xs text-slate-400">
          This domain was set up manually (no Cloudflare/Resend handles), so
          there is nothing to provision here — you can still manage its
          mailboxes, addresses and catch-all policy below.
        </p>
      )}

      {detail.domain.managed && (
        <StatusSection status={status} zoneActive={zoneActive} />
      )}

      {provision && (
        <div className="space-y-1 rounded-md border border-slate-800 bg-slate-800/40 p-3 text-xs">
          <p className="font-medium text-slate-300">Provisioning result</p>
          {provision.steps.map((s) => (
            <p key={s.step} className="flex items-start gap-2">
              {s.ok ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              ) : (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
              )}
              <span className="text-slate-400">
                {s.step} — {s.detail}
              </span>
            </p>
          ))}
          <MxConflictPrompt
            conflict={
              provision.steps.find((s) => !s.ok && s.conflict?.kind === "apex_mx")
                ?.conflict ?? null
            }
            manual={mxManual}
            busy={busy}
            onRemove={() =>
              act("resolve-mx", async () => {
                setMxManual(false);
                setProvision(await resolveMxConflict(domainId));
                await refreshStatus();
              })
            }
            onManual={() => setMxManual(true)}
          />
        </div>
      )}

      <MailboxManager
        detail={detail}
        busy={busy}
        onRefresh={refreshDetail}
        act={act}
      />

      <CatchAllPolicy
        detail={detail}
        busy={busy}
        onRefresh={refreshDetail}
        act={act}
      />
    </div>
  );
}

function StatusSection({
  status,
  zoneActive,
}: {
  status: DomainStatus | null;
  zoneActive: boolean;
}) {
  if (!status) return <p className="text-sm text-slate-500">Checking status…</p>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <StatusCell
          label="Cloudflare zone"
          value={status.zone?.status ?? "unknown"}
          ok={zoneActive}
        />
        <StatusCell
          label="Email Routing"
          value={status.emailRouting?.status ?? "—"}
          ok={status.emailRouting?.enabled ?? false}
        />
        <StatusCell
          label="Resend"
          value={status.resend?.status ?? "—"}
          ok={status.resend?.status === "verified"}
        />
      </div>

      {status.zone && !zoneActive && (
        <NameserverInstructions nameServers={status.zone.nameServers} />
      )}

      {status.resend && status.resend.records.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-slate-300">DNS records</h4>
          <RecordsTable records={status.resend.records} />
        </div>
      )}
    </div>
  );
}

// Shown when "Enable Email Routing" fails because a non-Cloudflare MX record
// sits at the zone apex (Cloudflare error 2008). Offers to remove the offending
// record(s) and retry, or to step aside while the operator removes them by hand.
function MxConflictPrompt({
  conflict,
  manual,
  busy,
  onRemove,
  onManual,
}: {
  conflict: ApexMxConflict | null;
  manual: boolean;
  busy: string | null;
  onRemove: () => void;
  onManual: () => void;
}) {
  if (!conflict) return null;
  const n = conflict.records.length;
  const them = n === 1 ? "it" : "them";

  if (manual) {
    return (
      <p className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200/90">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Remove the apex MX record{n === 1 ? "" : "s"} in your Cloudflare DNS
          panel, then click <strong>Provision</strong> again.
        </span>
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200/90">
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          We detected {n === 1 ? "a conflicting" : `${n} conflicting`} apex MX
          record{n === 1 ? "" : "s"} blocking Email Routing — Cloudflare will not
          enable routing while {them} exist:
        </span>
      </p>
      <ul className="ml-6 list-disc space-y-0.5 font-mono text-amber-100/80">
        {conflict.records.map((r) => (
          <li key={r.id}>
            {r.name} MX {r.content || "."}
          </li>
        ))}
      </ul>
      <p>Want me to remove {them} and retry, or will you do it manually?</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy !== null} onClick={onRemove}>
          {busy === "resolve-mx" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}{" "}
          Remove {them} &amp; retry
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={onManual}
        >
          I&apos;ll do it manually
        </Button>
      </div>
    </div>
  );
}

function MailboxManager({
  detail,
  busy,
  onRefresh,
  act,
}: {
  detail: DomainDetail;
  busy: string | null;
  onRefresh: () => void;
  act: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [newMailbox, setNewMailbox] = useState("");
  const [newMailboxDisplay, setNewMailboxDisplay] = useState("");
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [alias, setAlias] = useState("");
  const id = detail.domain.id;

  return (
    <div className="space-y-3 border-t border-slate-800 pt-4">
      <h4 className="text-sm font-medium text-slate-300">Mailboxes</h4>
      <ul className="space-y-2">
        {detail.mailboxes.map((m) => (
          <li
            key={m.id}
            className="space-y-2 rounded-md border border-slate-800 bg-slate-800/40 p-3"
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm font-medium">
                {m.name}
                {m.displayName ? (
                  <span className="ml-2 text-xs font-normal text-slate-400">
                    “{m.displayName}”
                  </span>
                ) : (
                  <span className="ml-2 text-xs font-normal italic text-slate-500">
                    no From name
                  </span>
                )}
              </span>
              <button
                title="Delete mailbox"
                className="text-slate-500 hover:text-red-400"
                onClick={() =>
                  act(`del-mbx-${m.id}`, async () => {
                    await deleteDomainMailbox(id, m.id);
                    onRefresh();
                  })
                }
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {m.addresses.map((a) => (
                <span
                  key={a.id}
                  className="flex items-center gap-1 rounded bg-slate-700/70 px-2 py-0.5 text-xs"
                >
                  {a.address}
                  <button
                    title="Remove address"
                    className="text-slate-400 hover:text-red-300"
                    onClick={() =>
                      act(`del-addr-${a.id}`, async () => {
                        await deleteDomainAddress(id, a.id);
                        onRefresh();
                      })
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {aliasFor === m.id ? (
                <span className="flex items-center gap-1">
                  <input
                    autoFocus
                    className="w-24 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs"
                    placeholder="alias"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                  />
                  <button
                    className="text-xs text-sky-400 hover:text-sky-300"
                    disabled={busy !== null || !alias.trim()}
                    onClick={() =>
                      act(`add-addr-${m.id}`, async () => {
                        await addDomainAddress(id, alias.trim(), m.id);
                        setAlias("");
                        setAliasFor(null);
                        onRefresh();
                      })
                    }
                  >
                    add
                  </button>
                  <button
                    className="text-xs text-slate-500 hover:text-slate-300"
                    onClick={() => {
                      setAliasFor(null);
                      setAlias("");
                    }}
                  >
                    cancel
                  </button>
                </span>
              ) : (
                <button
                  className="rounded border border-dashed border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:border-slate-600 hover:text-slate-200"
                  onClick={() => {
                    setAliasFor(m.id);
                    setAlias("");
                  }}
                >
                  + alias
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Input
          placeholder="mailbox name (e.g. support)"
          value={newMailbox}
          onChange={(e) => setNewMailbox(e.target.value)}
          className="flex-1"
        />
        <Input
          placeholder="From name (e.g. Painel News)"
          value={newMailboxDisplay}
          onChange={(e) => setNewMailboxDisplay(e.target.value)}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !newMailbox.trim() || !newMailboxDisplay.trim()}
          onClick={() =>
            act("add-mailbox", async () => {
              await addDomainMailbox(
                id,
                newMailbox.trim(),
                newMailboxDisplay.trim(),
              );
              setNewMailbox("");
              setNewMailboxDisplay("");
              onRefresh();
            })
          }
        >
          <Plus className="h-4 w-4" /> Add mailbox
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        The From name appears on outgoing mail from this mailbox (e.g.{" "}
        <span className="text-slate-400">Painel News &lt;support@…&gt;</span>) for
        everyone who sends from it.
      </p>
    </div>
  );
}

function CatchAllPolicy({
  detail,
  busy,
  onRefresh,
  act,
}: {
  detail: DomainDetail;
  busy: string | null;
  onRefresh: () => void;
  act: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const reject = detail.domain.rejectUnknown;
  const [mode, setMode] = useState<"catchall" | "reject">(
    reject ? "reject" : "catchall",
  );
  const [mailboxId, setMailboxId] = useState<string>(
    detail.domain.catchAllMailboxId ?? detail.mailboxes[0]?.id ?? "",
  );
  const id = detail.domain.id;

  return (
    <div className="space-y-3 border-t border-slate-800 pt-4">
      <h4 className="text-sm font-medium text-slate-300">
        Unknown recipients
      </h4>
      <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={mode === "catchall"}
            onChange={() => setMode("catchall")}
          />
          <span>Deliver to</span>
          <select
            disabled={mode !== "catchall"}
            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm disabled:opacity-50"
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
          >
            {detail.mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={mode === "reject"}
            onChange={() => setMode("reject")}
          />
          <span>Reject unknown addresses</span>
        </label>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || (mode === "catchall" && !mailboxId)}
          onClick={() =>
            act("policy", async () => {
              await setDomainPolicy(id, {
                rejectUnknown: mode === "reject",
                catchAllMailboxId: mode === "catchall" ? mailboxId : null,
              });
              onRefresh();
            })
          }
        >
          Save policy
        </Button>
      </div>
    </div>
  );
}

// --- small presentational helpers ------------------------------------------

function BackLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "ok" | "pending" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "bg-emerald-900/60 text-emerald-300"
      : tone === "pending"
        ? "bg-amber-900/50 text-amber-300"
        : "bg-slate-700 text-slate-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>{children}</span>
  );
}

function StatusCell({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-800/40 p-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="flex items-center gap-1 text-sm">
        {ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <CircleDashed className="h-3.5 w-3.5 text-amber-400" />
        )}
        {value}
      </p>
    </div>
  );
}

function SimulatedBanner() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Simulation mode — <code>CLOUDFLARE_API_TOKEN</code> and/or{" "}
        <code>RESEND_API_KEY</code> are not set, so nothing was provisioned on
        Cloudflare or Resend. Set them as Worker secrets to provision for real.
      </span>
    </div>
  );
}

function NameserverInstructions({ nameServers }: { nameServers: string[] }) {
  if (nameServers.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-sky-900 bg-sky-950/30 p-3 text-sm">
      <p className="font-medium text-sky-300">
        Delegate DNS at your registrar (manual step)
      </p>
      <p className="text-xs text-slate-400">
        At your domain registrar (e.g. GoDaddy), replace the domain's
        nameservers with these two, then come back and refresh status. The zone
        stays "pending" until this propagates (minutes to hours).
      </p>
      <ul className="space-y-1">
        {nameServers.map((ns) => (
          <li
            key={ns}
            className="select-all rounded bg-slate-800 px-2 py-1 font-mono text-xs text-sky-200"
          >
            {ns}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecordsTable({
  records,
}: {
  records: {
    record: string;
    name: string;
    type: string;
    value: string;
    status?: string;
  }[];
}) {
  return (
    <div className="mt-1 overflow-x-auto rounded-md border border-slate-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-800/60 text-slate-400">
          <tr>
            <th className="px-2 py-1 font-medium">Type</th>
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Value</th>
            <th className="px-2 py-1 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={`${r.type}-${r.name}-${i}`} className="border-t border-slate-800">
              <td className="px-2 py-1 font-mono">{r.type}</td>
              <td className="px-2 py-1 font-mono">{r.name}</td>
              <td className="max-w-[16rem] truncate px-2 py-1 font-mono" title={r.value}>
                {r.value}
              </td>
              <td className="px-2 py-1">{r.status ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
