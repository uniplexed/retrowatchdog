import type { DayReading } from "./series.js";

const DAY_MS = 86_400_000;

/** a reading older than this is not "now": a stale price never drives advice */
export const CURRENT_DAYS = 7;

export type Trend = "rising" | "falling" | "flat";

/** the readings of the last `days` days, by UTC day, ending at `now` */
export function window(readings: DayReading[], days: number, now: Date): DayReading[] {
  const from = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return readings.filter((r) => r.day >= from);
}

/** the latest reading carrying `pick`, if it is no older than CURRENT_DAYS */
export function current(readings: DayReading[], pick: (r: DayReading) => number | null, now: Date): DayReading | null {
  const recent = window(readings, CURRENT_DAYS, now);
  for (let i = recent.length - 1; i >= 0; i -= 1) if (pick(recent[i]) !== null) return recent[i];
  return null;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The reference's direction over the last `days`: the mean of the last third
 * against the mean of the first third, ±5 % either way; flat without enough
 * points to tell.
 */
export function trend(readings: DayReading[], days: number, now: Date): Trend {
  const refs = window(readings, days, now)
    .map((r) => r.referenceUsd)
    .filter((x): x is number => x !== null);
  if (refs.length < 3) return "flat";
  const third = Math.max(1, Math.floor(refs.length / 3));
  const first = mean(refs.slice(0, third));
  const last = mean(refs.slice(-third));
  if (first <= 0) return "flat";
  const change = last / first - 1;
  return change >= 0.05 ? "rising" : change <= -0.05 ? "falling" : "flat";
}

/** distinct days in the window carrying `pick` */
export function coverageDays(readings: DayReading[], pick: (r: DayReading) => number | null): number {
  return readings.filter((r) => pick(r) !== null).length;
}

/** the earliest day of the run ending at the latest reading where `holds` is true */
export function since(readings: DayReading[], holds: (r: DayReading) => boolean): string | null {
  let first: string | null = null;
  for (let i = readings.length - 1; i >= 0; i -= 1) {
    if (!holds(readings[i])) break;
    first = readings[i].day;
  }
  return first;
}

/** mean of the non-null values `pick` gives */
export function meanOf(readings: DayReading[], pick: (r: DayReading) => number | null): number | null {
  const xs = readings.map(pick).filter((x): x is number => x !== null);
  return xs.length === 0 ? null : mean(xs);
}
