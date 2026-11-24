import { Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  type ApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  updateApiToken,
} from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Personal API tokens (Phase 8): connect an agent (MCP client or any REST
// caller) to your mail. A token acts as you on mail, drafts, sending and the
// calendar — never on admin, mailbox management or tokens — within its own
// request limit and daily send cap. The token is shown exactly once.

const EXPIRY_OPTIONS = [
  { label: "Never", days: 0 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function ApiTokensSection({ origin = window.location.origin }: { origin?: string }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState(0);
  const [rateLimit, setRateLimit] = useState(120);
  const [sendCap, setSendCap] = useState(100);
  // The freshly created token — displayed once, then gone for good.
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRate, setEditRate] = useState(0);
  const [editCap, setEditCap] = useState(0);

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : String(err));

  const refresh = useCallback(() => {
    listApiTokens()
      .then(({ tokens }) => setTokens(tokens))
      .catch(fail);
  }, []);

  useEffect(refresh, [refresh]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await createApiToken({
        name: name.trim(),
        expiresInDays: expiryDays || undefined,
        rateLimitPerMinute: rateLimit,
        dailySendCap: sendCap,
      });
      setCreated(res.token);
      setCopied(false);
      setName("");
      refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    setError(null);
    try {
      await revokeApiToken(id);
      refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function handleSaveLimits(id: string) {
    setError(null);
    try {
      await updateApiToken(id, { rateLimitPerMinute: editRate, dailySendCap: editCap });
      setEditingId(null);
      refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
  }

  const mcpUrl = `${origin}/api/mcp`;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">API tokens</h2>
        <p className="text-sm text-slate-400">
          Let an AI agent read your mail, write drafts and send as you. Connect an
          MCP client to <code className="text-slate-300">{mcpUrl}</code> (or call the
          REST API at <code className="text-slate-300">{origin}/api/v1</code>) with
          the header <code className="text-slate-300">Authorization: Bearer &lt;token&gt;</code>.
          Tokens can't reach admin, mailbox management or token settings.
        </p>
      </div>

      {created && (
        <div className="space-y-1 rounded-md border border-emerald-800 bg-emerald-950 p-3">
          <p className="text-xs text-emerald-300">
            Copy this token now — it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code
              data-testid="new-token"
              className="flex-1 break-all rounded bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              {created}
            </code>
            <Button size="sm" variant="outline" onClick={() => copy(created)}>
              <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <button
            className="text-xs text-slate-400 hover:text-slate-200"
            onClick={() => setCreated(null)}
          >
            Done
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs text-slate-400">
        <label className="col-span-2 flex items-center gap-2">
          <span className="w-24">Name</span>
          <Input
            placeholder="e.g. grokbot"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Expires</span>
          <select
            className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
            value={expiryDays}
            onChange={(e) => setExpiryDays(Number(e.target.value))}
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Requests/min</span>
          <Input
            type="number"
            min={1}
            value={rateLimit}
            onChange={(e) => setRateLimit(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Sends/day</span>
          <Input
            type="number"
            min={0}
            value={sendCap}
            onChange={(e) => setSendCap(Number(e.target.value))}
          />
        </label>
        <div className="flex items-center justify-end">
          <Button size="sm" disabled={busy || !name.trim()} onClick={handleCreate}>
            <KeyRound className="h-3.5 w-3.5" /> {busy ? "Creating…" : "Create token"}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {tokens.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
          {tokens.map((t) => (
            <li key={t.id} className="space-y-1 p-2 text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-200">{t.name}</span>
                <code className="text-slate-500">{t.prefix}…</code>
                <span
                  className={
                    t.status === "active" ? "text-emerald-400" : "text-slate-500"
                  }
                >
                  {t.status}
                </span>
                <span className="flex-1" />
                {t.status === "active" && (
                  <>
                    <button
                      className="text-sky-400 hover:text-sky-300"
                      onClick={() => {
                        setEditingId(t.id);
                        setEditRate(t.rateLimitPerMinute);
                        setEditCap(t.dailySendCap);
                      }}
                    >
                      Edit limits
                    </button>
                    <button
                      className="text-red-400 hover:text-red-300"
                      onClick={() => handleRevoke(t.id)}
                    >
                      Revoke
                    </button>
                  </>
                )}
              </div>
              <div>
                Created {formatDate(t.createdAt)} · Last used {formatDate(t.lastUsedAt)} ·
                Expires {t.expiresAt ? formatDate(t.expiresAt) : "never"} ·{" "}
                {t.rateLimitPerMinute}/min · {t.dailySendCap} sends/day
              </div>
              {editingId === t.id && (
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Requests per minute"
                    type="number"
                    min={1}
                    value={editRate}
                    onChange={(e) => setEditRate(Number(e.target.value))}
                  />
                  <Input
                    aria-label="Sends per day"
                    type="number"
                    min={0}
                    value={editCap}
                    onChange={(e) => setEditCap(Number(e.target.value))}
                  />
                  <Button size="sm" onClick={() => handleSaveLimits(t.id)}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
