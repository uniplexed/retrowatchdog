import type { Condition, PriceKind, PriceRole, Region, SourceId, SourceInfo } from "@retrowatchdog/shared";
import { usableRole, type RoleCandidate } from "../signals/computeSignals.js";

/**
 * A stored point plus the day it belongs to. The caller must pre-filter to a
 * single (region, condition): the builder does not key by them, so a mixed
 * slice would silently average PAL with NTSC-J.
 */
export type HistoryRow = RoleCandidate & {
  condition: Condition;
  region: Region;
  fetchedAt: Date;
  /**
   * The amount the source actually QUOTED. `priceUsd` drifts with FX even
   * when the price never changed (62 of 515 real windows did).
   */
  original: { amount: number; currency: string };
};

export interface HistorySeries {
  source: SourceId;
  kind: PriceKind;
  role: PriceRole;
  /** one point per day the app actually looked, ascending */
  points: Array<{ day: string; usd: number; original: { amount: number; currency: string } }>;
}

/** UTC day; shared with routes/history.ts so window edges bucket the same way. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** NUL key separator (via fromCharCode so no raw NUL lands in the file). */
const SEP = String.fromCharCode(0);

/**
 * One series per (source, kind), one point per day. Rows are admitted by
 * `usableRole`, the signal engine's own gate. Per day:
 * - `buy_store`: the lowest price asked
 * - `bid`: the highest offered
 * - `reference`: the day's LAST fetch (min/max would invent a number)
 * - `buy_listing`: no series at all
 * A day with no usable row gets no point; the frontend breaks the line.
 */
export function buildHistorySeries(
  rows: readonly HistoryRow[],
  sources: Record<string, SourceInfo>,
): HistorySeries[] {
  const best = new Map<string, { row: HistoryRow; role: PriceRole }>();
  for (const row of rows) {
    const role = usableRole(row, sources);
    if (role === null || role === "buy_listing") continue;
    const day = dayOf(row.fetchedAt);
    const key = `${row.source}${SEP}${row.kind}${SEP}${day}`;
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, { row, role });
      continue;
    }
    const wins =
      role === "buy_store"
        ? row.priceUsd < held.row.priceUsd
        : role === "bid"
          ? row.priceUsd > held.row.priceUsd
          : // reference: the day's last fetch wins; ties keep the first seen
            row.fetchedAt.getTime() > held.row.fetchedAt.getTime();
    if (wins) best.set(key, { row, role });
  }

  const bySeries = new Map<string, HistorySeries>();
  for (const { row, role } of best.values()) {
    const day = dayOf(row.fetchedAt);
    const seriesKey = `${row.source}${SEP}${row.kind}`;
    let series = bySeries.get(seriesKey);
    if (series === undefined) {
      series = { source: row.source, kind: row.kind, role, points: [] };
      bySeries.set(seriesKey, series);
    }
    series.points.push({ day, usd: row.priceUsd, original: row.original });
  }
  for (const series of bySeries.values()) {
    series.points.sort((a, b) => a.day.localeCompare(b.day));
  }
  return [...bySeries.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind),
  );
}
