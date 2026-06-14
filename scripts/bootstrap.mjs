// mailbase bootstrap — one idempotent command that takes a fresh clone to a
// working LOCAL dev environment, with no human performing local steps.
//
// It: gates on the toolchain (Node 24 / npm 11), installs deps, creates
// packages/api/.dev.vars with a generated SIGNING_KEY, migrates + seeds the local
// D1 database, and creates a dev login — then prints how to start the app and the
// remaining human-only ([YOU]) steps it deliberately will NOT attempt.
//
// Re-runnable: every step skips or refreshes work that's already done, so a second
// run is a clean no-op. Overridable via env: DOMAIN, MAILBOX, EMAIL, PASSWORD, NAME.
//
// Invoked by `make bootstrap` and `npm run setup` (alias `npm run bootstrap`).
// See scripts/doctor.mjs for why these onboarding scripts are .mjs, not .ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  ROOT,
  NPM,
  c,
  binPath,
  capture,
  runInherit,
  checkNode,
  checkNpm,
} from "./doctor.mjs";

const env = process.env;
const pick = (name, fallback) => (env[name] && env[name].trim()) || fallback;
const DOMAIN = pick("DOMAIN", "example.test");
const MAILBOX = pick("MAILBOX", "josh");
const EMAIL = pick("EMAIL", `${MAILBOX}@${DOMAIN}`);
const PASSWORD = pick("PASSWORD", "devpassword");
const NAME = pick("NAME", "mailbase dev");
const MAILBOX_ID = "seed-mailbox"; // fixed id used by scripts/seed.sql

const step = (s) => console.log(c.cyan("▶ ") + s);
const ok = (s) => console.log(c.green("  ✓ ") + s);
const skip = (s) => console.log(c.dim("  – " + s));

function gate() {
  for (const res of [checkNode(), checkNpm()]) {
    if (res.status === "fail") {
      console.log(c.red(`\n✗ ${res.label} — ${res.detail}`));
      console.log(`  ${c.cyan("fix:")} ${res.fix}\n`);
      console.log(c.dim("Bootstrap needs the pinned toolchain before it can touch the lockfile. Stopping."));
      process.exit(1);
    }
  }
  ok(`Toolchain OK (Node ${process.versions.node})`);
}

function installDeps() {
  if (existsSync(path.join(ROOT, "node_modules")) && existsSync(binPath("wrangler"))) {
    skip("Dependencies already installed — run `make install` to refresh from the lockfile.");
    return;
  }
  step("Installing dependencies (npm ci)…");
  runInherit(NPM, ["ci"], { stdio: "inherit" });
}

function writeDevVars() {
  const devVars = path.join(ROOT, "packages", "api", ".dev.vars");
  if (existsSync(devVars)) {
    skip("packages/api/.dev.vars already exists — leaving your secrets untouched.");
    return;
  }
  const example = readFileSync(path.join(ROOT, "packages", "api", ".dev.vars.example"), "utf8");
  const key = randomBytes(32).toString("hex");
  writeFileSync(devVars, example.replace(/^SIGNING_KEY=.*$/m, `SIGNING_KEY="${key}"`));
  ok("Created packages/api/.dev.vars with a freshly generated SIGNING_KEY.");
}

function migrateLocal() {
  step("Applying D1 migrations (local Miniflare — no Cloudflare account needed)…");
  runInherit(binPath("wrangler"), ["d1", "migrations", "apply", "mailbase", "--local"]);
}

function seedLocal() {
  step(`Seeding local D1 (domain ${c.bold(DOMAIN)}, mailbox ${c.bold(MAILBOX)})…`);
  const sql = readFileSync(path.join(ROOT, "scripts", "seed.sql"), "utf8")
    .replaceAll("__DOMAIN__", DOMAIN)
    .replaceAll("__MAILBOX__", MAILBOX);
  const file = path.join(ROOT, ".wrangler", "seed.generated.sql");
  writeFileSync(file, sql);
  runInherit(binPath("wrangler"), ["d1", "execute", "mailbase", "--local", "--file", file]);
}

function createUser() {
  step(`Creating local login ${c.bold(EMAIL)}…`);
  const gen = capture(binPath("tsx"), ["scripts/create-user.ts", EMAIL, PASSWORD, NAME, MAILBOX_ID]);
  if (gen.status !== 0 || !gen.stdout) {
    throw new Error(`create-user.ts failed:\n${gen.stderr || gen.stdout || "(no output)"}`);
  }
  const file = path.join(ROOT, ".wrangler", "user.generated.sql");
  writeFileSync(file, gen.stdout);
  runInherit(binPath("wrangler"), ["d1", "execute", "mailbase", "--local", "--file", file]);
}

function summary() {
  const L = (s) => console.log(s);
  L(c.green(c.bold("\n✅ Local environment ready.\n")));
  L("Start it (two terminals):");
  L(`  ${c.bold("make dev")}        # API  → http://localhost:8787`);
  L(`  ${c.bold("make dev-web")}    # web  → ${c.cyan("http://localhost:5173")}   ← open this and sign in`);
  L("\nSign in with:");
  L(`  email:    ${c.bold(EMAIL)}`);
  L(`  password: ${c.bold(PASSWORD)}`);
  L(c.dim("\nWhat this set up (all local — no Cloudflare/Resend account, no paid plan):"));
  L(c.dim("  • deps, packages/api/.dev.vars (generated SIGNING_KEY)"));
  L(c.dim(`  • local D1 migrated + seeded (domain ${DOMAIN}, mailbox ${MAILBOX}, hello@ alias)`));
  L(c.dim("  • a webmail login with send-as identities for the seeded addresses"));
  L(c.dim("\nIdempotent — re-run `make bootstrap` any time; it skips/refreshes done steps."));
  L(c.yellow("\nStill requires a human ([YOU]) — only to go to PRODUCTION, not for local dev:"));
  L("  [YOU] Create a Cloudflare account and run `npx wrangler login`");
  L("  [YOU] Enable R2 in the dashboard (one-time activation)");
  L("  [YOU] Add your domain as a Cloudflare zone + delegate nameservers at your registrar");
  L("  [YOU] Upgrade to the Workers Paid plan ($5/mo) — argon2 login exceeds the free 10ms CPU cap");
  L("  [YOU] Create a Resend account for outbound mail");
  L(c.dim("  Once creds exist an agent can finish via API — see AGENTS.md → \"Human vs agent\" and docs/SELF_HOSTING.md.\n"));
}

function main() {
  console.log(c.bold("\nmailbase bootstrap — one-command local setup"));
  gate();
  mkdirSync(path.join(ROOT, ".wrangler"), { recursive: true });
  installDeps();
  writeDevVars();
  migrateLocal();
  seedLocal();
  createUser();
  summary();
}

try {
  main();
} catch (err) {
  console.error(c.red(`\n✗ bootstrap failed: ${err.message}`));
  console.error(c.dim("Fix the error above and re-run `make bootstrap` (it's idempotent), or run `make doctor` to diagnose."));
  process.exit(1);
}
