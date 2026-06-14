// mailbase doctor — onboarding preflight.
//
// Checks the local toolchain and dev state and prints an actionable fix for
// every failure, so an agent (or a human) can tell exactly where setup stands.
// Run it standalone (`make doctor` / `npm run doctor`) or let `make bootstrap`
// use its checks as a gate.
//
// WHY THIS FILE IS .mjs (the repo is otherwise TypeScript-only): the doctor has
// to run on a *bare clone* (before `npm ci`, so `tsx` doesn't exist yet) AND on
// the *wrong* Node — its headline job is to flag "you're on Node 20, switch to
// 24". A `.ts` entry can't do either: it needs `tsx`, and Node < 22 can't strip
// types so it would crash with a parse error before printing the fix. Plain,
// dependency-free Node ESM is the only thing that runs everywhere. Kept to two
// files (this + bootstrap.mjs); bootstrap imports the checks from here.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const isWin = process.platform === "win32";
export const NPM = "npm";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  green: (s) => paint("32", s),
  red: (s) => paint("31", s),
  yellow: (s) => paint("33", s),
  cyan: (s) => paint("36", s),
  bold: (s) => paint("1", s),
  dim: (s) => paint("2", s),
};

/** Absolute path to a locally-installed binary (node_modules/.bin). */
export const binPath = (name) =>
  path.join(ROOT, "node_modules", ".bin", isWin ? `${name}.cmd` : name);

/** Run a command and capture its output. Cross-platform (.cmd needs a shell on Windows). */
export function capture(cmd, args = []) {
  if (isWin) {
    const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
    return spawnSync([cmd, ...args.map(q)].join(" "), {
      shell: true,
      encoding: "utf8",
    });
  }
  return spawnSync(cmd, args, { encoding: "utf8" });
}

/** Run a command, streaming its output; throw on non-zero exit. stdin is closed so child tools stay non-interactive. */
export function runInherit(cmd, args = [], opts = {}) {
  let r;
  if (isWin) {
    const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
    r = spawnSync([cmd, ...args.map(q)].join(" "), {
      shell: true,
      stdio: ["ignore", "inherit", "inherit"],
      cwd: ROOT,
      ...opts,
    });
  } else {
    r = spawnSync(cmd, args, {
      stdio: ["ignore", "inherit", "inherit"],
      cwd: ROOT,
      ...opts,
    });
  }
  if (r.error) throw r.error;
  if (typeof r.status === "number" && r.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed (exit ${r.status})`);
  }
  return r;
}

/** The Node major version the repo pins, from .nvmrc (falls back to 24). */
export function expectedNodeMajor() {
  try {
    return parseInt(readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim(), 10);
  } catch {
    return 24;
  }
}

// --- Individual checks. Each returns { label, status, detail?, fix? }. ----------
// status ∈ 'pass' | 'warn' | 'fail' | 'skip'. Only 'fail' affects the exit code.

export function checkNode() {
  const want = expectedNodeMajor();
  const have = parseInt(process.versions.node.split(".")[0], 10);
  if (have === want) return { label: `Node ${process.versions.node}`, status: "pass" };
  return {
    label: `Node ${process.versions.node}`,
    status: "fail",
    detail: `expected Node ${want} (pinned in .nvmrc). Older Node ships an older npm that silently prunes cross-platform optional deps from package-lock.json — the MAIL-8 footgun.`,
    fix: `Run \`nvm use\` in the repo root (activates the pinned Node ${want}). No nvm? Install Node ${want} from https://nodejs.org.`,
  };
}

export function checkNpm() {
  const r = capture(NPM, ["--version"]);
  if (r.status !== 0 || !r.stdout) {
    return {
      label: "npm",
      status: "fail",
      detail: "could not run npm",
      fix: `Install the pinned Node ${expectedNodeMajor()} via \`nvm use\` (it bundles npm 11).`,
    };
  }
  const v = r.stdout.trim();
  const major = parseInt(v.split(".")[0], 10);
  if (major >= 11) return { label: `npm ${v}`, status: "pass" };
  return {
    label: `npm ${v}`,
    status: "fail",
    detail: "need npm >= 11 (npm 10 corrupts the lockfile by pruning other platforms' native deps)",
    fix: "Run `nvm use` — the pinned Node 24 ships npm 11. The repo enforces this via engine-strict.",
  };
}

export function checkDeps() {
  if (existsSync(path.join(ROOT, "node_modules")) && existsSync(binPath("wrangler"))) {
    return { label: "Dependencies installed", status: "pass" };
  }
  return {
    label: "Dependencies installed",
    status: "fail",
    detail: "node_modules / wrangler is missing (a fresh checkout has no deps — the MAIL-8 build failure)",
    fix: "Run `make bootstrap` (or `make install`).",
  };
}

/** Static integrity of the onboarding path — catches docs/scripts drift (used in CI). */
export function checkOnboardingPath() {
  const problems = [];
  const files = [
    ["packages/api/.dev.vars.example", null],
    ["scripts/create-user.ts", null],
    ["scripts/seed.sql", /__DOMAIN__/],
    ["AGENTS.md", null],
  ];
  for (const [rel, mustContain] of files) {
    const p = path.join(ROOT, rel);
    if (!existsSync(p)) {
      problems.push(`${rel} missing`);
      continue;
    }
    if (mustContain && !mustContain.test(readFileSync(p, "utf8"))) {
      problems.push(`${rel} no longer contains ${mustContain}`);
    }
  }
  try {
    const mk = readFileSync(path.join(ROOT, "Makefile"), "utf8");
    for (const t of ["bootstrap", "doctor"]) {
      if (!new RegExp(`^${t}:`, "m").test(mk)) problems.push(`Makefile has no '${t}' target`);
    }
  } catch {
    problems.push("Makefile missing");
  }
  if (problems.length === 0) return { label: "Onboarding path intact", status: "pass" };
  return {
    label: "Onboarding path intact",
    status: "fail",
    detail: problems.join("; "),
    fix: "A file or target the onboarding path references moved — update scripts/doctor.mjs and the docs in the same change.",
  };
}

export function checkWranglerLogin() {
  if (!existsSync(binPath("wrangler"))) {
    return { label: "wrangler login (remote only)", status: "skip", detail: "deps not installed yet" };
  }
  const r = capture(binPath("wrangler"), ["whoami"]);
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === 0 && !/not authenticated|not logged in/i.test(out)) {
    return { label: "wrangler login", status: "pass", detail: "logged in (remote deploy ready)" };
  }
  return {
    label: "wrangler login",
    status: "warn",
    detail: "not logged in — only needed for remote deploy. Local dev (this bootstrap) needs no Cloudflare account.",
    fix: "When you deploy: `npx wrangler login` (interactive — a [YOU] step).",
  };
}

export function checkDevVars() {
  const f = path.join(ROOT, "packages", "api", ".dev.vars");
  if (existsSync(f)) {
    if (/dev-only-signing-key-change-me/.test(readFileSync(f, "utf8"))) {
      return {
        label: "packages/api/.dev.vars",
        status: "warn",
        detail: "present, but SIGNING_KEY is still the example placeholder",
        fix: "Re-run `make bootstrap`, or set a real key: `openssl rand -hex 32`.",
      };
    }
    return { label: "packages/api/.dev.vars", status: "pass" };
  }
  return {
    label: "packages/api/.dev.vars",
    status: "fail",
    detail: "missing (the local API needs SIGNING_KEY for signed attachment URLs)",
    fix: "Run `make bootstrap` (creates it with a generated key), or `cp packages/api/.dev.vars.example packages/api/.dev.vars`.",
  };
}

export function checkLocalDb() {
  const dir = path.join(ROOT, ".wrangler", "state", "v3", "d1");
  if (existsSync(dir) && sqliteFiles(dir).length > 0) {
    return { label: "Local D1 migrated", status: "pass" };
  }
  return {
    label: "Local D1 migrated",
    status: "fail",
    detail: "no local database found under .wrangler/state",
    fix: "Run `make bootstrap` (or `make migrate-local`).",
  };
}

/** Recursively find non-metadata *.sqlite files (the Miniflare D1 database). */
function sqliteFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sqliteFiles(full));
    else if (entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite") found.push(full);
  }
  return found;
}

// --- CLI ------------------------------------------------------------------------

const ICON = {
  pass: () => c.green("✓"),
  warn: () => c.yellow("⚠"),
  fail: () => c.red("✗"),
  skip: () => c.dim("–"),
};

function printResult(r) {
  console.log(`  ${ICON[r.status]()} ${r.label}${r.detail ? c.dim(` — ${r.detail}`) : ""}`);
  if ((r.status === "fail" || r.status === "warn") && r.fix) {
    console.log(`      ${c.cyan("fix:")} ${r.fix}`);
  }
}

function runDoctor() {
  const ci = process.argv.includes("--ci");
  console.log(c.bold("\nmailbase doctor — onboarding preflight\n"));

  const results = [checkNode(), checkNpm(), checkDeps(), checkOnboardingPath()];
  if (ci) {
    // Dev-local state isn't expected to exist in CI; we only guard against rot.
    results.push(
      { label: "wrangler login", status: "skip", detail: "remote-only — skipped in --ci" },
      { label: "packages/api/.dev.vars", status: "skip", detail: "dev-only — skipped in --ci" },
      { label: "Local D1 migrated", status: "skip", detail: "dev-only — skipped in --ci" },
    );
  } else {
    results.push(checkWranglerLogin(), checkDevVars(), checkLocalDb());
  }

  results.forEach(printResult);

  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  console.log("");
  if (failed === 0) {
    console.log(
      c.green(`All checks passed${warned ? ` (${warned} warning${warned > 1 ? "s" : ""})` : ""}.`) +
        (ci ? "" : " Start it: " + c.bold("make dev") + " + " + c.bold("make dev-web") + "."),
    );
  } else {
    console.log(
      c.red(`${failed} problem${failed > 1 ? "s" : ""}.`) +
        " Run " + c.bold("make bootstrap") + " to fix the automatable ones, then re-run " + c.bold("make doctor") + ".",
    );
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) runDoctor();
