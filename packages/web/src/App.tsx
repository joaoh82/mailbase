import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchMe, type User } from "./api";
import { LoginScreen } from "./components/LoginScreen";
import { MailApp } from "./components/MailApp";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authed"; user: User };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    fetchMe()
      .then((user) => setAuth({ status: "authed", user }))
      .catch(() => setAuth({ status: "anonymous" }));
  }, []);

  const handleSignedOut = useCallback(() => {
    setAuth({ status: "anonymous" });
  }, []);

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
