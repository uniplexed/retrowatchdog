import { and, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { PricePointDto, Region, SourceId, SourceInfo } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { pricePoints } from "../db/schema.js";
import { toDto } from "../pricing/service.js";
import { buildSignalInputs, usableRole, type SignalConfig, type SignalInput } from "./computeSignals.js";

/**
 * What the time-based rules compare today's slice against, per region. Built
 * from stored price_points only, through the same gates as today's input
 * (`usableRole`), so history can never hold a price the engine would ignore.
 */
export interface SignalHistory {
  /** the slice as of cfg.priceDropDays ago: each source's newest batch at or before then */
  dropAgo: SignalInput;
  /** how many whole days old each source's batch in `dropAgo` really is */
  dropAgeDays: Record<SourceId, number>;
  /** the slice as of cfg.risingDays ago */
  risingAgo: SignalInput;
  /**
   * lowest purchasable price per `${source}|${condition}` over cfg.newLowDays,
   * today's batch excluded, with how many days of data back it up. `original`
   * is the lowest quoted amount in `currency`, or null when the window mixes
   * currencies (then only the frozen USD can be compared).
   */
  lowest: Record<string, LowestPrice>;
  /** buy_store availability in the batch before the current one, per `${source}|${condition}|${grade ?? ""}` */
  previousAvailability: Record<string, boolean>;
}

export interface LowestPrice {
  usd: number;
  original: number | null;
  currency: string;
  daysCovered: number;
}

const DAY_MS = 86_400_000;

const emptyInput = (region: Region): SignalInput => ({
  region,
  storeOffers: [],
  bids: [],
  listings: [],
  referenceByCondition: {},
});

export const emptyHistory = (region: Region): SignalHistory => ({
  dropAgo: emptyInput(region),
  dropAgeDays: {},
  risingAgo: emptyInput(region),
  lowest: {},
  previousAvailability: {},
});

/** each source's newest batch time at or before `cutoff` */
function batchAtOrBefore(batches: Map<SourceId, number[]>, cutoff: number): Map<SourceId, number> {
  const out = new Map<SourceId, number>();
  for (const [source, times] of batches) {
    const hit = times.find((t) => t <= cutoff);
    if (hit !== undefined) out.set(source, hit);
  }
  return out;
}

/**
 * Three queries per game, none of which ships the whole window to Node: the
 * batch times, the rows of the (at most three) past batches the rules read,
 * and the lowest prices already aggregated in SQL.
 */
export async function loadSignalHistory(
  db: Db,
  gameId: number,
  sources: readonly SourceId[],
  registry: Record<string, SourceInfo>,
  cfg: SignalConfig,
  now: number = Date.now(),
): Promise<Map<Region, SignalHistory>> {
  const history = new Map<Region, SignalHistory>();
  if (sources.length === 0) return history;
  const windowDays = Math.max(cfg.newLowDays, cfg.risingDays, cfg.priceDropDays);
  const inWindow = and(
    eq(pricePoints.gameId, gameId),
    inArray(pricePoints.source, [...sources]),
    gte(pricePoints.fetchedAt, new Date(now - windowDays * DAY_MS)),
  );

  // 1. batch times per source, newest first
  const batchRows = await db
    .selectDistinct({ source: pricePoints.source, fetchedAt: pricePoints.fetchedAt })
    .from(pricePoints)
    .where(inWindow);
  const batches = new Map<SourceId, number[]>();
  for (const r of batchRows) {
    const list = batches.get(r.source) ?? [];
    list.push(r.fetchedAt.getTime());
    batches.set(r.source, list);
  }
  for (const list of batches.values()) list.sort((a, b) => b - a);
  const latest = new Map([...batches].map(([s, times]) => [s, times[0]]));
  const previous = new Map(
    [...batches].filter(([, times]) => times.length > 1).map(([s, times]) => [s, times[1]]),
  );
  const dropAt = batchAtOrBefore(batches, now - cfg.priceDropDays * DAY_MS);
  const risingAt = batchAtOrBefore(batches, now - cfg.risingDays * DAY_MS);

  const entry = (region: Region): SignalHistory => {
    let h = history.get(region);
    if (h === undefined) {
      h = emptyHistory(region);
      history.set(region, h);
    }
    return h;
  };

  // 2. only the past batches the rules read
  const wanted = new Map<SourceId, Set<number>>();
  for (const at of [dropAt, risingAt, previous]) {
    for (const [source, t] of at) wanted.set(source, (wanted.get(source) ?? new Set()).add(t));
  }
  const batchFilters: SQL[] = [...wanted].map(([source, times]) =>
    and(eq(pricePoints.source, source), inArray(pricePoints.fetchedAt, [...times].map((t) => new Date(t))))!,
  );
  const rows =
    batchFilters.length === 0
      ? []
      : await db.select().from(pricePoints).where(and(eq(pricePoints.gameId, gameId), or(...batchFilters)));
  const points = rows.map((r) => ({ source: r.source, at: r.fetchedAt.getTime(), dto: toDto(r) }));
  const sliceAt = (at: Map<SourceId, number>): PricePointDto[] =>
    points.filter((p) => at.get(p.source) === p.at).map((p) => p.dto);

  for (const input of buildSignalInputs(sliceAt(dropAt), registry)) entry(input.region).dropAgo = input;
  for (const input of buildSignalInputs(sliceAt(risingAt), registry)) entry(input.region).risingAgo = input;
  const dropAgeDays: Record<SourceId, number> = Object.fromEntries(
    [...dropAt].map(([source, t]) => [source, Math.floor((now - t) / DAY_MS)]),
  );
  for (const h of history.values()) h.dropAgeDays = dropAgeDays;

  // availability is read off the raw role: usableRole drops the out-of-stock rows this is about
  for (const p of points) {
    if (previous.get(p.source) !== p.at) continue;
    if (registry[p.dto.source]?.kindRoles[p.dto.kind] !== "buy_store") continue;
    entry(p.dto.region).previousAvailability[`${p.dto.source}|${p.dto.condition}|${p.dto.grade ?? ""}`] =
      p.dto.available !== false;
  }

  // 3. the lowest purchasable prices, aggregated in SQL, each source's latest batch excluded
  const beforeLatest: SQL[] = [...latest].map(
    ([source, t]) => and(eq(pricePoints.source, source), lt(pricePoints.fetchedAt, new Date(t)))!,
  );
  if (beforeLatest.length > 0) {
    const lows = await db
      .select({
        source: pricePoints.source,
        region: pricePoints.region,
        condition: pricePoints.condition,
        kind: pricePoints.kind,
        grade: pricePoints.grade,
        currency: pricePoints.currencyOriginal,
        usd: sql<string>`min(${pricePoints.priceUsd})`,
        original: sql<string>`min(${pricePoints.priceOriginal})`,
        firstAt: sql<Date>`min(${pricePoints.fetchedAt})`,
      })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.gameId, gameId),
          gte(pricePoints.fetchedAt, new Date(now - cfg.newLowDays * DAY_MS)),
          sql`${pricePoints.priceUsd} > 0`,
          sql`${pricePoints.available} IS DISTINCT FROM false`,
          or(...beforeLatest),
        ),
      )
      .groupBy(
        pricePoints.source,
        pricePoints.region,
        pricePoints.condition,
        pricePoints.kind,
        pricePoints.grade,
        pricePoints.currencyOriginal,
      );
    for (const g of lows) {
      const usd = Number(g.usd);
      // the same gates as today's input, applied to the group's lowest row
      const role = usableRole(
        { source: g.source, kind: g.kind as PricePointDto["kind"], priceUsd: usd, grade: g.grade as PricePointDto["grade"], available: true, sampleSize: undefined },
        registry,
      );
      if (role !== "buy_listing" && role !== "buy_store") continue;
      const key = `${g.source}|${g.condition}`;
      const lowest = entry(g.region as Region).lowest;
      const daysCovered = Math.floor((now - new Date(g.firstAt).getTime()) / DAY_MS);
      const current = lowest[key];
      if (current === undefined) {
        lowest[key] = { usd, original: Number(g.original), currency: g.currency, daysCovered };
      } else {
        const sameCurrency = current.original !== null && current.currency === g.currency;
        lowest[key] = {
          usd: Math.min(current.usd, usd),
          original: sameCurrency ? Math.min(current.original!, Number(g.original)) : null,
          currency: current.currency,
          daysCovered: Math.max(current.daysCovered, daysCovered),
        };
      }
    }
  }
  return history;
}
