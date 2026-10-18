import { and, desc, eq } from "drizzle-orm";
import pino from "pino";
import type { Condition, ItemGrade, Platform, PriceKind, PriceMode, PricePointDto, PriceRole, Region, SourceBlock, SourceId } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { gameNames, pricePoints, sourceFetches } from "../db/schema.js";
import {
  kindForRole,
  type NormalizedListing,
  type PriceSourceAdapter,
  type RawPrice,
  type SnapshotStrategy,
} from "../adapters/types.js";
import type { SourceRegistry } from "../sources/registry.js";
import { resolveListing } from "../matching/matcher.js";
import { median, trimOutliers } from "./median.js";
import { config } from "../config.js";
import { loadEnabledSources } from "../settings/markets.js";
import { ratesToUsd } from "./fx.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });

/** Cheapest per-listing rows persisted for display; not a signal threshold. */
const CHEAPEST_KEPT = 10;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`adapter timeout after ${ms}ms`)), ms);
      t.unref();
    }),
  ]);
}

type NewPoint = typeof pricePoints.$inferInsert;

export function toDto(row: typeof pricePoints.$inferSelect): PricePointDto {
  return {
    source: row.source as SourceId,
    kind: row.kind as PricePointDto["kind"],
    region: row.region as Region,
    condition: row.condition as Condition,
    grade: row.grade as ItemGrade | null,
    priceUsd: Number(row.priceUsd),
    priceOriginal: Number(row.priceOriginal),
    currencyOriginal: row.currencyOriginal,
    sampleSize: row.sampleSize,
    url: row.sourceUrl,
    listingTitle: row.listingTitle,
    available: row.available,
  };
}

/**
 * "We fetched this (game, source)", even when it matched nothing: a zero-match
 * fetch writes no price_points, so without this the TTL never sees it fresh.
 */
async function loadFetchMarker(db: Db, gameId: number, source: SourceId): Promise<Date | null> {
  const [row] = await db
    .select({ fetchedAt: sourceFetches.fetchedAt })
    .from(sourceFetches)
    .where(and(eq(sourceFetches.gameId, gameId), eq(sourceFetches.source, source)));
  return row?.fetchedAt ?? null;
}

async function markFetched(db: Db, gameId: number, source: SourceId, fetchedAt: Date): Promise<void> {
  await db
    .insert(sourceFetches)
    .values({ gameId, source, fetchedAt })
    .onConflictDoUpdate({
      target: [sourceFetches.gameId, sourceFetches.source],
      set: { fetchedAt },
    });
}

/**
 * The game's other names (game_names minus the canonical title), in catalog
 * order. A keyword-query source widens its search with them (eBay: subtitle
 * and alternative-name phrases); catalog-backed sources ignore them.
 */
async function loadAlternativeNames(db: Db, game: { id: number; title: string }): Promise<string[]> {
  const rows = await db
    .select({ name: gameNames.name })
    .from(gameNames)
    .where(eq(gameNames.gameId, game.id))
    .orderBy(gameNames.id);
  return rows.map((r) => r.name).filter((name) => name !== game.title);
}

/**
 * The kinds this source may still speak for, or null for "do not narrow".
 *
 * A row outlives an approval: a stored value is read back under TODAY's
 * approval, so a kind the user unticked stops being served. A source the
 * registry does not describe returns null (narrow nothing), not an empty set
 * (which would hide every row).
 */
function servedKinds(
  registry: SourceRegistry | undefined,
  source: SourceId,
): ReadonlySet<PriceKind> | null {
  const info = registry?.get(source);
  if (info === undefined) return null;
  return new Set(Object.keys(info.kindRoles) as PriceKind[]);
}

/**
 * The latest stored batch for one (game, source), narrowed to what that source
 * may claim today. Omitting `registry` narrows nothing (the worker discards
 * the blocks anyway).
 */
export async function loadStoredBlock(
  db: Db,
  gameId: number,
  source: SourceId,
  registry?: SourceRegistry,
): Promise<{ points: PricePointDto[]; fetchedAt: Date; observedAt: Date | null } | null> {
  const [latest] = await db
    .select({ fetchedAt: pricePoints.fetchedAt })
    .from(pricePoints)
    .where(and(eq(pricePoints.gameId, gameId), eq(pricePoints.source, source)))
    .orderBy(desc(pricePoints.fetchedAt))
    .limit(1);
  if (!latest) return null;
  const allowed = servedKinds(registry, source);
  const fetchedRows = await db
    .select()
    .from(pricePoints)
    .where(
      and(
        eq(pricePoints.gameId, gameId),
        eq(pricePoints.source, source),
        eq(pricePoints.fetchedAt, latest.fetchedAt),
      ),
    );
  const rows = fetchedRows.filter((row) => allowed === null || allowed.has(row.kind as PriceKind));
  // the one place that says rows were dropped
  if (allowed !== null && rows.length < fetchedRows.length) {
    const droppedKinds = [
      ...new Set(fetchedRows.filter((row) => !allowed.has(row.kind as PriceKind)).map((row) => row.kind)),
    ];
    log.warn({ source, gameId, droppedKinds }, "narrowed stored price points to the source's declared roles");
  }
  // from the SURVIVING rows: the time shown belongs to the readings shown
  const observedTimes = rows
    .map((r) => r.observedAt)
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  const observedAt = observedTimes.length > 0 ? new Date(Math.min(...observedTimes)) : null;
  return { points: rows.map(toDto), fetchedAt: latest.fetchedAt, observedAt };
}

/** Display timestamp: honest source-observation time when known. */
export function displayTime(stored: { fetchedAt: Date; observedAt: Date | null } | null): string | undefined {
  if (!stored) return undefined;
  return (stored.observedAt ?? stored.fetchedAt).toISOString();
}

function perListingPointsFrom(
  source: SourceId,
  listings: NormalizedListing[],
  gameId: number,
  fetchedAt: Date,
  rates: Map<string, number>,
): NewPoint[] {
  return listings.flatMap((l) =>
    l.prices.map((p) => ({
      gameId,
      source,
      region: l.regionGuess,
      condition: l.conditionGuess,
      grade: l.gradeGuess ?? null,
      kind: p.kind,
      // frozen at write time with that day's X->USD rate; the original stays verbatim
      priceUsd: String(p.amount * (rates.get(p.currency) ?? 1)),
      priceOriginal: String(p.amount),
      currencyOriginal: p.currency,
      sourceUrl: l.url,
      // what the stale-point invalidation keys on (schema.ts says why)
      sourceProductId: l.sourceProductId,
      listingTitle: l.title,
      // the signal engine decides per role what an unavailable price means
      available: l.available ?? null,
      fetchedAt,
      observedAt: l.observedAt ?? null,
      // the SOURCE's own sample for an amount it aggregated itself
      sampleSize: p.sampleSize ?? null,
    })),
  );
}

/**
 * For a `median_of_listings` source: a reference median per (region,
 * condition) plus the cheapest buy_listing rows, written under the source's
 * OWN kinds from `kindRoles` (never `prices[0]`: a row can carry several
 * prices). Any other-role price is stored per-listing. Throws if either role
 * is missing, rather than writing under an undeclared kind.
 */
export function medianPointsFrom(
  source: SourceId,
  kindRoles: Partial<Record<PriceKind, PriceRole>>,
  listings: NormalizedListing[],
  gameId: number,
  fetchedAt: Date,
  rates: Map<string, number>,
): NewPoint[] {
  const buyListingKind = kindForRole(kindRoles, "buy_listing");
  const referenceKind = kindForRole(kindRoles, "reference");
  if (buyListingKind === undefined || referenceKind === undefined) {
    throw new Error(
      `medianPointsFrom called for "${source}" without both a buy_listing and a reference role in its kindRoles`,
    );
  }
  // fair/poor listings ("spares or repairs") are not comparables: they would
  // drag the median down and then surface as fake bargains against it.
  // Other grades share one sample: splitting per grade starves minSample.
  const comparables = listings.filter((l) => l.gradeGuess !== "fair" && l.gradeGuess !== "poor");
  const groups = new Map<
    string,
    { region: Region; condition: Condition; usdAmounts: number[]; originalAmounts: number[]; currencies: Set<string> }
  >();
  for (const l of comparables) {
    const price = l.prices.find((p) => p.kind === buyListingKind);
    if (price === undefined) continue;
    const usd = price.amount * (rates.get(price.currency) ?? 1);
    const key = `${l.regionGuess}|${l.conditionGuess}`;
    const group =
      groups.get(key) ??
      { region: l.regionGuess, condition: l.conditionGuess, usdAmounts: [], originalAmounts: [], currencies: new Set<string>() };
    group.usdAmounts.push(usd);
    group.originalAmounts.push(price.amount);
    group.currencies.add(price.currency);
    groups.set(key, group);
  }
  const medianPoints: NewPoint[] = [];
  for (const g of groups.values()) {
    const usdValue = median(trimOutliers(g.usdAmounts));
    if (usdValue === null) continue;
    // Evidence rule (see computeSignals): a single-currency group's original
    // is the median of the verbatim amounts; a mixed one's is the USD value.
    const single = g.currencies.size === 1 ? [...g.currencies][0] : null;
    const originalValue = single !== null ? median(trimOutliers(g.originalAmounts)) : usdValue;
    medianPoints.push({
      gameId,
      source,
      region: g.region,
      condition: g.condition,
      kind: referenceKind,
      priceUsd: String(usdValue),
      priceOriginal: String(originalValue ?? usdValue),
      currencyOriginal: single ?? "USD",
      sampleSize: g.usdAmounts.length,
      // an aggregate is not a listing anyone can buy: availability is unknown
      available: null,
      fetchedAt,
    });
  }
  // usd computed once so the sort and priceUsd agree
  const cheapest = comparables
    .flatMap((l) => {
      const price = l.prices.find((p) => p.kind === buyListingKind);
      return price
        ? [
            {
              listing: l,
              amount: price.amount,
              currency: price.currency,
              usd: price.amount * (rates.get(price.currency) ?? 1),
            },
          ]
        : [];
    })
    .sort((a, b) => a.usd - b.usd)
    .slice(0, CHEAPEST_KEPT)
    .map(({ listing, amount, currency, usd }) => ({
      gameId,
      source,
      region: listing.regionGuess,
      condition: listing.conditionGuess,
      grade: listing.gradeGuess ?? null,
      kind: buyListingKind,
      priceUsd: String(usd),
      priceOriginal: String(amount),
      currencyOriginal: currency,
      sourceUrl: listing.url,
      sourceProductId: listing.sourceProductId,
      listingTitle: listing.title,
      available: listing.available ?? null,
      fetchedAt,
      observedAt: listing.observedAt ?? null,
    }));
  // Every other price (bid, buy_store, guide) is stored per-listing, from
  // `listings` not `comparables`: the grade exclusion is for the median only.
  const otherRolePoints = perListingPointsFrom(
    source,
    listings
      .map((l) => ({
        ...l,
        prices: l.prices.filter((p) => p.kind !== buyListingKind && p.kind !== referenceKind),
      }))
      .filter((l) => l.prices.length > 0),
    gameId,
    fetchedAt,
    rates,
  );
  return [...medianPoints, ...cheapest, ...otherRolePoints];
}

/** Kinds with a `reference` role that some listing priced WITHOUT a sample. Empty for a median_of_listings source: the app derives that reference itself. */
export function unsampledReferenceKinds(
  listings: ReadonlyArray<{ prices: ReadonlyArray<RawPrice> }>,
  kindRoles: Partial<Record<PriceKind, PriceRole>>,
  strategy: SnapshotStrategy,
): PriceKind[] {
  if (strategy === "median_of_listings") return [];
  const found = new Set<PriceKind>();
  for (const listing of listings) {
    for (const price of listing.prices) {
      if (kindRoles[price.kind] === "reference" && price.sampleSize === undefined) found.add(price.kind);
    }
  }
  return [...found];
}

export async function getPricesForGame(
  db: Db,
  registry: PriceSourceAdapter[],
  game: { id: number; title: string; platform: Platform },
  // `sources` narrows stored kinds (see `loadStoredBlock`)
  opts: { ttlHours?: number; mode?: PriceMode; sources?: SourceRegistry } = {},
): Promise<SourceBlock[]> {
  const mode: PriceMode = opts.mode ?? "cached_auto";
  // loaded lazily, only when some adapter goes live
  let alternativeNames: Promise<string[]> | undefined;
  const loadNames = (): Promise<string[]> => (alternativeNames ??= loadAlternativeNames(db, game));

  // A disabled market produces NO block: an empty one would read as "we
  // looked and found nothing".
  const enabled = await loadEnabledSources(db);
  const activeRegistry = registry.filter((adapter) => enabled.has(adapter.source));

  const blocks = await Promise.all(
    activeRegistry.map(async (adapter): Promise<SourceBlock> => {
      if (!adapter.isConfigured()) {
        return { source: adapter.source, status: "not_configured", points: [] };
      }
      const ttlMs = (opts.ttlHours ?? adapter.ttlHours ?? config.PRICE_TTL_HOURS) * 3_600_000;
      const stored = await loadStoredBlock(db, game.id, adapter.source, opts.sources);
      if (mode === "cached_only") {
        // never touch external services; serve stored data (maybe none)
        return {
          source: adapter.source,
          status: "ok",
          fetchedAt: displayTime(stored),
          points: stored?.points ?? [],
        };
      }
      // falls back to the price_points timestamp for pre-marker data
      const marker = await loadFetchMarker(db, game.id, adapter.source);
      const effectiveFetchedAt = marker ?? stored?.fetchedAt ?? null;
      const isFresh = effectiveFetchedAt !== null && Date.now() - effectiveFetchedAt.getTime() < ttlMs;
      if (mode === "cached_auto" && isFresh) {
        if (stored) {
          return {
            source: adapter.source,
            status: "ok",
            fetchedAt: displayTime(stored),
            points: stored.points,
          };
        }
        return {
          source: adapter.source,
          status: "ok",
          fetchedAt: effectiveFetchedAt.toISOString(),
          points: [],
        };
      }
      try {
        // the budget for the whole fetch, however many calls the adapter makes
        const raw = await withTimeout(
          adapter.search(game.title, game.platform, { alternativeNames: await loadNames() }),
          config.ADAPTER_TIMEOUT_MS,
        );
        const matched: NormalizedListing[] = [];
        for (const listing of raw) {
          const normalized = adapter.normalize(listing);
          // another console's copy (Xbox, Switch…): never matched, never mapped
          if (normalized.foreignPlatform) continue;
          const resolved = await resolveListing(db, adapter.source, normalized);
          // only a CONFIRMED mapping attributes a listing; needs_review stays
          // out of prices and signals
          if (resolved?.status === "confirmed" && resolved.gameId === game.id) matched.push(normalized);
        }
        const fetchedAt = new Date();
        // db-aware: manual fx_overrides apply to snapshot conversions too
        const rates = await ratesToUsd(db, matched.flatMap((l) => l.prices.map((p) => p.currency)));
        const unsampled = unsampledReferenceKinds(matched, adapter.kindRoles ?? {}, adapter.snapshotStrategy);
        if (unsampled.length > 0) {
          // tells the plugin author why their baseline is never compared against
          log.warn(
            { source: adapter.source, gameId: game.id, kinds: unsampled },
            "reference prices arrived without a sampleSize; they are stored but never used as a baseline",
          );
        }
        const newPoints =
          adapter.snapshotStrategy === "median_of_listings"
            ? medianPointsFrom(adapter.source, adapter.kindRoles ?? {}, matched, game.id, fetchedAt, rates)
            : perListingPointsFrom(adapter.source, matched, game.id, fetchedAt, rates);
        if (newPoints.length > 0) await db.insert(pricePoints).values(newPoints);
        await markFetched(db, game.id, adapter.source, fetchedAt);
        const fresh = await loadStoredBlock(db, game.id, adapter.source, opts.sources);
        return {
          source: adapter.source,
          status: "ok",
          fetchedAt: newPoints.length > 0 ? displayTime(fresh) : fetchedAt.toISOString(),
          points: fresh && newPoints.length > 0 ? fresh.points : [],
        };
      } catch {
        // stale-if-error: serve old data honestly labeled
        return {
          source: adapter.source,
          status: "error",
          fetchedAt: displayTime(stored),
          points: stored?.points ?? [],
        };
      }
    }),
  );
  return blocks;
}
