import { useEffect, useState, type FormEvent } from "react";
import {
  acceptInvite,
  ApiError,
  getInvite,
  type InvitePreview,
  type User,
} from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Accept-invite flow: the invitee opens mail.../?invite=<token>, sets a
// password, and lands signed in. Reached from App when the URL carries ?invite.
export function AcceptInviteScreen({
  token,
  onAccepted,
  onCancel,
}: {
  token: string;
  onAccepted: (user: User) => void;
  onCancel: () => void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getInvite(token)
      .then(setPreview)
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : "Could not load this invite",
        ),
      );
  }, [token]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAccepted(await acceptInvite(token, password, displayName));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not reach the server",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">mailbase</h1>
          <p className="mt-1 text-sm text-slate-400">
            {preview
              ? `You've been invited to ${preview.mailbox ?? "a mailbox"}.`
              : "Set up your account"}
          </p>
        </div>

        {loadError ? (
          <>
            <p className="text-sm text-red-400">{loadError}</p>
            <Button variant="ghost" className="w-full" onClick={onCancel}>
              Back to sign in
            </Button>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                Email
              </label>
              <p className="mt-1 truncate text-sm text-slate-300">
                {preview?.email ?? "…"}
              </p>
            </div>
            <Input
              type="text"
              autoComplete="name"
              placeholder="Your name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <Input
              type="password"
              required
              autoFocus
              autoComplete="new-password"
              placeholder="Choose a password (8+ characters)"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Button
              type="submit"
              disabled={busy || !preview}
              className="w-full"
            >
              {busy ? "Setting up…" : "Create account"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
