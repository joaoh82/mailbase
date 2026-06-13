import type { sessions, users } from "@mailbase/shared";

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;

/** Hono environment for every route: Workers bindings + auth context. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: User;
    session: Session;
  };
}
