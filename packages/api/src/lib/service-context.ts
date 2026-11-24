import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { ServiceContext } from "../services/context";
import type { AppEnv } from "./context";

/** Service context for a cookie-session request (the signed-in user). */
export function sessionServiceContext(c: Context<AppEnv>): ServiceContext {
  return { db: drizzle(c.env.DB), env: c.env, userId: c.get("user").id };
}
