# mailbase

Self-hosted, multi-domain, multi-account webmail on Cloudflare's developer platform.
One deployment serves every domain — domains, mailboxes, and users are database rows,
never infrastructure. Runs for ~$0–5/month at personal/small-team volume.

> **Status: early development.** Phase 0 (foundations) is complete: the monorepo,
> database schema, CI/CD pipeline, and three deployable workers. Receiving and reading
> mail comes in the next phases — see the [development plan](docs/DESIGN.md#9-development-plan).

## How it works

```
Internet (SMTP) → Cloudflare Email Routing → Email Worker → R2 (raw .eml) + D1 (metadata)
                                                                  ↑
React SPA (webmail) ←——— HTTPS/JSON ———→ API Worker (Hono) ———————┘
                                              ↓
                                           Resend (outbound)
```

- **Raw email is the source of truth** — full RFC 5322 messages live in R2; D1 holds
  parsed metadata and full-text search (SQLite FTS5).
- **Domains and accounts are data** — adding a domain or mailbox never touches code.
- **Web client first** — no IMAP/SMTP server; see [docs/DESIGN.md](docs/DESIGN.md) for
  architecture, data model, and the phased roadmap.

## Repository layout

```
packages/email-worker/   # inbound Email Routing handler
packages/api/            # Hono REST API, auth, send
packages/web/            # React SPA (Vite + Tailwind)
packages/shared/         # types, Drizzle schema, MailSender interface
migrations/              # D1 SQL migrations (numbered, append-only)
docs/                    # DESIGN.md, SELF_HOSTING.md
```

## Host your own

mailbase is built to be self-hosted on your own Cloudflare account. The full
walkthrough — account prerequisites, creating the D1 database and R2 bucket,
deploying, and wiring up CI — lives in **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

The short version:

```sh
git clone https://github.com/joaoh82/mailbase && cd mailbase
make install          # npm install across workspaces
npx wrangler login
make setup            # creates the D1 database + R2 bucket (one-time)
# paste your database_id into the three wrangler.jsonc files (see guide)
make migrate-remote   # apply the schema to your D1 database
make deploy           # deploy all three workers
```

## Developing

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `make install`       | Install all workspace dependencies                      |
| `make dev`           | Run the API worker locally (Miniflare D1/R2 bindings)   |
| `make dev-web`       | Run the web SPA dev server (Vite, port 5173)            |
| `make test`          | Vitest across all workspaces (Workers runtime via Miniflare) |
| `make typecheck`     | `tsc --noEmit` across all workspaces                    |
| `make migrate-local` | Apply D1 migrations to the local dev database           |
| `make build`         | Build the web SPA                                       |

Tests and typecheck must pass before any PR; CI enforces both and deploys `main`
automatically. Read [CLAUDE.md](CLAUDE.md) for project conventions and
[docs/DESIGN.md](docs/DESIGN.md) before non-trivial changes.

## License

[MIT](LICENSE)
