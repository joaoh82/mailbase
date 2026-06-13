import { useState } from "react";
import { ApiError, type Identity, updateIdentitySignature } from "../api";
import { RichTextEditor } from "./RichTextEditor";
import { Button } from "./ui/button";

// Per-user settings: edit the signature on each of your send-as identities
// (MAIL-4). A signature is appended to the bottom of outgoing mail sent from
// that address; leave it empty to fall back to the mailbox's default signature.
export function SettingsModal({
  identities,
  onClose,
  onSaved,
}: {
  identities: Identity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selectedId, setSelectedId] = useState(identities[0]?.id ?? "");
  const selected = identities.find((i) => i.id === selectedId);
  const [html, setHtml] = useState(selected?.signature ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function select(nextId: string) {
    setSelectedId(nextId);
    setHtml(identities.find((i) => i.id === nextId)?.signature ?? "");
    setSaved(false);
    setError(null);
  }

  async function handleSave() {
    if (!selected) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await updateIdentitySignature(selected.id, html);
      // Reflect the server-sanitized result locally and refresh the parent.
      selected.signature = res.signature;
      setHtml(res.signature);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold">Signature</h2>
          <p className="text-sm text-slate-400">
            Added to the bottom of mail you send. Set one per send-as address;
            an empty signature falls back to the mailbox's default.
          </p>
        </div>

        {identities.length === 0 ? (
          <p className="rounded-md bg-amber-950 px-3 py-2 text-xs text-amber-300">
            You don't have a send-as address yet, so there's no signature to
            set.
          </p>
        ) : (
          <>
            {identities.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span>Address</span>
                <select
                  className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                  value={selectedId}
                  onChange={(e) => select(e.target.value)}
                >
                  {identities.map((id) => (
                    <option key={id.id} value={id.id}>
                      {id.displayName
                        ? `${id.displayName} <${id.address}>`
                        : id.address}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Remount the editor when the selected identity changes so it
                re-seeds from that identity's stored signature. */}
            <RichTextEditor
              key={selectedId}
              initialContent={selected?.signature ?? ""}
              onChange={(next) => {
                setHtml(next);
                setSaved(false);
              }}
            />

            {error && <p className="text-sm text-red-400">{error}</p>}
          </>
        )}

        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-xs text-emerald-400">Saved</span>}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            disabled={busy || !selected}
            onClick={handleSave}
          >
            {busy ? "Saving…" : "Save signature"}
          </Button>
        </div>
      </div>
    </div>
  );
}
