import { useState, type FormEvent } from "react";
import { ApiError, login, type User } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(email, password));
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
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-8"
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">mailbase</h1>
          <p className="mt-1 text-sm text-slate-400">
            Sign in to your webmail
          </p>
        </div>
        <Input
          type="email"
          required
          autoFocus
          autoComplete="username"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
