import type { apiTokens, sessions, users } from "@mailbase/shared";

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;

/** Hono environment for every session route: Workers bindings + auth context. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: User;
    session: Session;
  };
}

/**
 * Hono environment for the bearer-only agent routes (/api/v1, /api/mcp, Phase
 * 8). There is deliberately no `session`: a token is not a session, so nothing
 * that depends on one (CSRF, logout, /auth/me) can run here.
 */
export interface AgentEnv {
  Bindings: Env;
  Variables: {
    user: User;
    apiToken: ApiToken;
  };
}
