import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { AgentEnv } from "../lib/context";
import type { SendQuota, ServiceContext } from "../services/context";

/** Service context for an agent request, plus what only agents carry. */
export interface AgentContext extends ServiceContext {
  /** The token's daily send cap, applied to every agent send path. */
  quota: SendQuota;
  /** Public origin of this request, for absolute signed attachment URLs. */
  origin: string;
}

export function agentContext(c: Context<AgentEnv>): AgentContext {
  const token = c.get("apiToken");
  return {
    db: drizzle(c.env.DB),
    env: c.env,
    userId: c.get("user").id,
    quota: { tokenId: token.id, dailySendCap: token.dailySendCap },
    // The web worker forwards the original request over the service binding,
    // so this is the webmail's public origin in production.
    origin: new URL(c.req.url).origin,
  };
}
