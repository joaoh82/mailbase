// Per-browser UI preferences (MAIL-14). The live-update poll cadence is a
// client concern — the polling runs in this browser — so it lives in
// localStorage rather than the database: no migration, no API, no cross-device
// sync to maintain. The preset list also bounds idle cost (no sub-15s loops).

/** Poll-interval choices offered in Settings. 0 = off (manual Refresh only). */
export const POLL_INTERVAL_OPTIONS: { label: string; value: number }[] = [
  { label: "Off", value: 0 },
  { label: "Every 15 seconds", value: 15_000 },
  { label: "Every 30 seconds", value: 30_000 },
  { label: "Every minute", value: 60_000 },
  { label: "Every 5 minutes", value: 300_000 },
];

/** Cadence used when nothing is stored yet. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

const POLL_INTERVAL_KEY = "mailbase:pollIntervalMs";

const ALLOWED = new Set(POLL_INTERVAL_OPTIONS.map((o) => o.value));

/**
 * Coerce a stored poll-interval string to one of the offered values, falling
 * back to the default for anything missing or unrecognized (e.g. an old value
 * no longer in the list, or junk). Pure, so it's unit-testable without a DOM —
 * the storage wrappers below just feed it `localStorage.getItem`.
 */
export function parsePollIntervalMs(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && ALLOWED.has(value)
    ? value
    : DEFAULT_POLL_INTERVAL_MS;
}

/** Read the saved cadence (ms; 0 = off). Safe to call outside a browser. */
export function readPollIntervalMs(): number {
  try {
    return parsePollIntervalMs(localStorage.getItem(POLL_INTERVAL_KEY));
  } catch {
    return DEFAULT_POLL_INTERVAL_MS;
  }
}

/** Persist the chosen cadence; ignores storage failures (e.g. private mode). */
export function writePollIntervalMs(ms: number): void {
  try {
    localStorage.setItem(POLL_INTERVAL_KEY, String(ms));
  } catch {
    // Best-effort: a blocked localStorage just means the choice isn't remembered.
  }
}
