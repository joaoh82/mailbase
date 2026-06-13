import { useCallback, useEffect, useState } from "react";
import {
  addMember,
  ApiError,
  createInvite,
  listMembers,
  type Mailbox,
  type MailboxMember,
  type MailboxRole,
  removeMember,
  updateMailboxSignature,
} from "../api";
import { RichTextEditor } from "./RichTextEditor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Owner/admin tool for a shared mailbox: see who's on it, invite a new login,
// add an existing account, or remove a member. Opened from the Sidebar only
// when the current user can manage the selected mailbox.
export function ManageMailboxModal({
  mailbox,
  currentUserId,
  onClose,
}: {
  mailbox: Mailbox;
  currentUserId: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MailboxMember[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MailboxRole>("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sigHtml, setSigHtml] = useState(mailbox.signature);
  const [sigBusy, setSigBusy] = useState(false);
  const [sigSaved, setSigSaved] = useState(false);

  const refresh = useCallback(() => {
    listMembers(mailbox.id)
      .then(({ members }) => setMembers(members))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : String(err)),
      );
  }, [mailbox.id]);

  useEffect(refresh, [refresh]);

  async function handleInvite() {
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    try {
      const res = await createInvite(email, mailbox.id, role);
      // Rebuild the link from this origin so it works regardless of how the API
      // saw the request host.
      setInviteUrl(`${window.location.origin}/?invite=${res.token}`);
      setEmail("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddExisting() {
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    try {
      await addMember(mailbox.id, email, role);
      setEmail("");
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(userId: string) {
    setError(null);
    try {
      await removeMember(mailbox.id, userId);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleSaveSignature() {
    setSigBusy(true);
    setSigSaved(false);
    setError(null);
    try {
      const res = await updateMailboxSignature(mailbox.id, sigHtml);
      setSigHtml(res.signature);
      setSigSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSigBusy(false);
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
          <h2 className="text-lg font-semibold">Manage {mailbox.address}</h2>
          <p className="text-sm text-slate-400">
            Members share this inbox and can send from its addresses.
          </p>
        </div>

        <ul className="space-y-1">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center gap-2 rounded-md bg-slate-800/60 px-3 py-1.5 text-sm"
            >
              <span className="flex-1 truncate">
                {m.displayName || m.email}
                <span className="ml-2 text-xs text-slate-500">{m.email}</span>
              </span>
              <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                {m.role}
              </span>
              {m.userId !== currentUserId && (
                <button
                  className="text-xs text-red-400 hover:text-red-300"
                  onClick={() => handleRemove(m.userId)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="space-y-2 border-t border-slate-800 pt-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            Invite or add someone
          </label>
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="person@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
            />
            <select
              className="rounded-md border border-slate-700 bg-slate-900 px-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as MailboxRole)}
            >
              <option value="member">member</option>
              <option value="owner">owner</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !email}
              onClick={handleInvite}
              className="flex-1"
            >
              Invite new user
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !email}
              onClick={handleAddExisting}
              className="flex-1"
            >
              Add existing account
            </Button>
          </div>
        </div>

        {inviteUrl && (
          <div className="space-y-1 rounded-md border border-sky-900 bg-sky-950/40 p-3">
            <p className="text-xs text-slate-400">
              Send this one-time link to the invitee (expires in 7 days):
            </p>
            <input
              readOnly
              className="w-full select-all rounded bg-slate-800 px-2 py-1 text-xs text-sky-300"
              value={inviteUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        )}

        <div className="space-y-2 border-t border-slate-800 pt-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            Default signature
          </label>
          <p className="text-xs text-slate-500">
            Appended to mail sent from this mailbox when the sending address has
            no signature of its own.
          </p>
          <RichTextEditor
            initialContent={mailbox.signature}
            onChange={(next) => {
              setSigHtml(next);
              setSigSaved(false);
            }}
          />
          <div className="flex items-center justify-end gap-2">
            {sigSaved && (
              <span className="text-xs text-emerald-400">Saved</span>
            )}
            <Button size="sm" disabled={sigBusy} onClick={handleSaveSignature}>
              {sigBusy ? "Saving…" : "Save signature"}
            </Button>
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
