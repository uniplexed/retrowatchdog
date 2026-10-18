import { and, gte, inArray, sql } from "drizzle-orm";
import type { Condition, PriceKind, PriceRole, Region, SourceId, SourceInfo } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { pricePoints } from "../db/schema.js";

const DAY_MS = 86_400_000;

type Original = { amount: number; currency: string };

/** One UTC day of one slice of one game: the three readings every rule needs. */
export interface DayReading {
  /** UTC yyyy-mm-dd */
  day: string;
  /** cheapest purchasable price (buy_listing or buy_store) */
  cheapestUsd: number | null;
  cheapestSource: SourceId | null;
  cheapestOriginal: Original | null;
  /** cheapest in-stock store price (the replacement reading) */
  cheapestStoreUsd: number | null;
  /** what a store pays you at best */
  bestBidUsd: number | null;
  bestBidSource: SourceId | null;
  bestBidOriginal: Original | null;
  /** the market reference (median), averaged across the sources that have one */
  referenceUsd: number | null;
}

export type SliceKey = `${string}|${string}`;

export interface GameSeries {
  gameId: number;
  /** days ascending, only days with at least one reading */
  bySlice: Map<SliceKey, DayReading[]>;
}

const empty = (day: string): DayReading => ({
  day,
  cheapestUsd: null,
  cheapestSource: null,
  cheapestOriginal: null,
  cheapestStoreUsd: null,
  bestBidUsd: null,
  bestBidSource: null,
  bestBidOriginal: null,
  referenceUsd: null,
});

/**
 * Daily readings per game and slice over the last `days`, aggregated in SQL
 * (one query for every game). Out-of-stock boxes and zero prices never count;
 * roles come from the registry. An original amount travels only when its
 * group quoted one currency.
 */
export async function loadSeries(
  db: Db,
  gameIds: number[],
  sources: readonly SourceId[],
  registry: Record<string, SourceInfo>,
  days: number,
  now: Date = new Date(),
): Promise<Map<number, GameSeries>> {
  const out = new Map<number, GameSeries>();
  if (gameIds.length === 0 || sources.length === 0) return out;
  // a date key and min = max for "one currency" keep this a hash aggregate (no sort of every listing row)
  const dayExpr = sql`(${pricePoints.fetchedAt} at time zone 'UTC')::date`;
  const groups = await db
    .select({
      gameId: pricePoints.gameId,
      day: sql<string>`(${pricePoints.fetchedAt} at time zone 'UTC')::date::text`,
      region: pricePoints.region,
      condition: pricePoints.condition,
      source: pricePoints.source,
      kind: pricePoints.kind,
      minUsd: sql<string>`min(${pricePoints.priceUsd})`,
      maxUsd: sql<string>`max(${pricePoints.priceUsd})`,
      avgUsd: sql<string>`avg(${pricePoints.priceUsd})`,
      minOriginal: sql<string>`min(${pricePoints.priceOriginal})`,
      maxOriginal: sql<string>`max(${pricePoints.priceOriginal})`,
      single: sql<boolean>`min(${pricePoints.currencyOriginal}) = max(${pricePoints.currencyOriginal})`,
      currency: sql<string>`min(${pricePoints.currencyOriginal})`,
    })
    .from(pricePoints)
    .where(
      and(
        inArray(pricePoints.gameId, gameIds),
        inArray(pricePoints.source, [...sources]),
        gte(pricePoints.fetchedAt, new Date(now.getTime() - days * DAY_MS)),
        sql`${pricePoints.priceUsd} > 0`,
        sql`${pricePoints.available} IS DISTINCT FROM false`,
      ),
    )
    .groupBy(pricePoints.gameId, dayExpr, pricePoints.region, pricePoints.condition, pricePoints.source, pricePoints.kind);

  // (game, slice, day) -> reading, plus the reference values to average
  const cells = new Map<string, { gameId: number; slice: SliceKey; reading: DayReading; refs: number[] }>();
  for (const g of groups) {
    const role: PriceRole | undefined = registry[g.source]?.kindRoles[g.kind as PriceKind];
    if (role === undefined || role === "guide") continue;
    const slice: SliceKey = `${g.region}|${g.condition}`;
    const id = `${g.gameId}|${slice}|${g.day}`;
    let cell = cells.get(id);
    if (cell === undefined) {
      cell = { gameId: g.gameId, slice, reading: empty(g.day), refs: [] };
      cells.set(id, cell);
    }
    const r = cell.reading;
    const single = g.single === true;
    if (role === "buy_listing" || role === "buy_store") {
      const usd = Number(g.minUsd);
      if (r.cheapestUsd === null || usd < r.cheapestUsd) {
        r.cheapestUsd = usd;
        r.cheapestSource = g.source;
        r.cheapestOriginal = single ? { amount: Number(g.minOriginal), currency: g.currency } : null;
      }
      if (role === "buy_store" && (r.cheapestStoreUsd === null || usd < r.cheapestStoreUsd)) r.cheapestStoreUsd = usd;
    } else if (role === "bid") {
      const usd = Number(g.maxUsd);
      if (r.bestBidUsd === null || usd > r.bestBidUsd) {
        r.bestBidUsd = usd;
        r.bestBidSource = g.source;
        r.bestBidOriginal = single ? { amount: Number(g.maxOriginal), currency: g.currency } : null;
      }
    } else if (role === "reference") {
      cell.refs.push(Number(g.avgUsd));
    }
  }
  for (const cell of cells.values()) {
    if (cell.refs.length > 0) cell.reading.referenceUsd = cell.refs.reduce((a, b) => a + b, 0) / cell.refs.length;
    let series = out.get(cell.gameId);
    if (series === undefined) {
      series = { gameId: cell.gameId, bySlice: new Map() };
      out.set(cell.gameId, series);
    }
    const list = series.bySlice.get(cell.slice) ?? [];
    list.push(cell.reading);
    series.bySlice.set(cell.slice, list);
  }
  for (const series of out.values()) {
    for (const list of series.bySlice.values()) list.sort((a, b) => a.day.localeCompare(b.day));
  }
  return out;
}

/**
 * The readings of one slice; a null dimension (a watch's "any") unions every
 * slice along it: the cheapest price, the best bid, the mean reference.
 */
export function sliceFor(series: GameSeries | undefined, region: Region | null, condition: Condition | null): DayReading[] {
  if (series === undefined) return [];
  if (region !== null && condition !== null) return series.bySlice.get(`${region}|${condition}`) ?? [];
  const byDay = new Map<string, { reading: DayReading; refs: number[] }>();
  for (const [key, list] of series.bySlice) {
    const [r, c] = key.split("|");
    if ((region !== null && r !== region) || (condition !== null && c !== condition)) continue;
    for (const d of list) {
      let cell = byDay.get(d.day);
      if (cell === undefined) {
        cell = { reading: empty(d.day), refs: [] };
        byDay.set(d.day, cell);
      }
      const u = cell.reading;
      if (d.cheapestUsd !== null && (u.cheapestUsd === null || d.cheapestUsd < u.cheapestUsd)) {
        u.cheapestUsd = d.cheapestUsd;
        u.cheapestSource = d.cheapestSource;
        u.cheapestOriginal = d.cheapestOriginal;
      }
      if (d.cheapestStoreUsd !== null && (u.cheapestStoreUsd === null || d.cheapestStoreUsd < u.cheapestStoreUsd)) {
        u.cheapestStoreUsd = d.cheapestStoreUsd;
      }
      if (d.bestBidUsd !== null && (u.bestBidUsd === null || d.bestBidUsd > u.bestBidUsd)) {
        u.bestBidUsd = d.bestBidUsd;
        u.bestBidSource = d.bestBidSource;
        u.bestBidOriginal = d.bestBidOriginal;
      }
      if (d.referenceUsd !== null) cell.refs.push(d.referenceUsd);
    }
  }
  return [...byDay.values()]
    .map(({ reading, refs }) => ({ ...reading, referenceUsd: refs.length === 0 ? null : refs.reduce((a, b) => a + b, 0) / refs.length }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
