// Serves the built SPA and forwards /api/* to the API worker over a service
// binding, so the webmail and its API share one origin and the session
// cookie stays first-party (HttpOnly + SameSite=Lax works unmodified).
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return env.API.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
