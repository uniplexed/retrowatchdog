/**
 * The one date window every history endpoint reads: either `days` (whole UTC
 * days back from today, today included) or an explicit `from` and `to`
 * (YYYY-MM-DD, both inclusive). Refused, never clamped, when it does not
 * make sense; a `to` past today is today, since nothing is stored after it.
 */
export const MAX_WINDOW_DAYS = 730;

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Window = { ok: true; from: string; to: string; days: number } | { ok: false; reason: string };

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

function parseDay(value: unknown): Date | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  // "2026-13-01" parses to Invalid Date; "2026-02-31" rolls over, which the round trip catches
  return Number.isNaN(d.getTime()) || dayOf(d) !== value ? null : d;
}

export function parseWindow(query: Record<string, unknown>, defaultDays: number, now: Date = new Date()): Window {
  const today = new Date(`${dayOf(now)}T00:00:00.000Z`);
  if (query.from !== undefined || query.to !== undefined) {
    const from = parseDay(query.from);
    const to = parseDay(query.to);
    if (from === null || to === null) return { ok: false, reason: "from and to must both be dates, YYYY-MM-DD" };
    const end = to > today ? today : to;
    if (from > end) return { ok: false, reason: "from must not be after to" };
    const days = Math.round((end.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > MAX_WINDOW_DAYS) return { ok: false, reason: `a window spans at most ${MAX_WINDOW_DAYS} days` };
    return { ok: true, from: dayOf(from), to: dayOf(end), days };
  }
  const raw = query.days === undefined ? defaultDays : Number(query.days);
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_WINDOW_DAYS) {
    return { ok: false, reason: `days must be a whole number from 1 to ${MAX_WINDOW_DAYS}` };
  }
  return { ok: true, from: dayOf(new Date(today.getTime() - (raw - 1) * DAY_MS)), to: dayOf(today), days: raw };
}
