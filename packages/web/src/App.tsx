import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchMe, type User } from "./api";
import { AcceptInviteScreen } from "./components/AcceptInviteScreen";
import { LoginScreen } from "./components/LoginScreen";
import { MailApp } from "./components/MailApp";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authed"; user: User };

/** Reads (and strips) an ?invite=<token> query param if present. */
function readInviteToken(): string | null {
  return new URLSearchParams(window.location.search).get("invite");
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [inviteToken, setInviteToken] = useState<string | null>(readInviteToken);

  useEffect(() => {
    // An invite link onboards a brand-new account; skip the session probe.
    if (inviteToken) {
      setAuth({ status: "anonymous" });
      return;
    }
    fetchMe()
      .then((user) => setAuth({ status: "authed", user }))
      .catch(() => setAuth({ status: "anonymous" }));
  }, [inviteToken]);

  // Drop ?invite from the URL once we leave the accept flow, so a reload (or
  // sign-out) doesn't reopen it.
  const clearInvite = useCallback(() => {
    setInviteToken(null);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const handleSignedOut = useCallback(() => {
    setAuth({ status: "anonymous" });
  }, []);

  if (inviteToken) {
    return (
      <AcceptInviteScreen
        token={inviteToken}
        onAccepted={(user) => {
          clearInvite();
          setAuth({ status: "authed", user });
        }}
        onCancel={clearInvite}
      />
    );
  }

  if (auth.status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        Loading…
      </main>
    );
  }
  if (auth.status === "anonymous") {
    return (
      <LoginScreen onLogin={(user) => setAuth({ status: "authed", user })} />
    );
  }
  return <MailApp user={auth.user} onSignedOut={handleSignedOut} />;
}

/** True for errors that mean the session is gone and login must reappear. */
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
