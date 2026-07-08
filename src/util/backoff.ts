/**
 * Exponential backoff: base * 2^attempt, capped, with 0-20% jitter added ON TOP.
 * Jitter is intentionally one-sided (never subtracted) so `baseMs` is a true floor -
 * callers relying on it as a hard minimum (e.g. F-List's "10 second minimum" reconnect
 * stagger requirement) must not see a value below `baseMs`.
 */
export function computeBackoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const raw = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = raw * 0.2 * Math.random();
  return Math.min(capMs, Math.round(raw + jitter));
}
