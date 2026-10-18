import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AcquiredSource, Authenticity, CollectionHistoryResponse, CollectionResponse, Condition, CopyStatus, GameSummary, ItemGrade, MatchBasis, OwnedCopyDto, Platform, PricePointDto, Region, SourceId, SupportedCurrency, ValuationBasis, ValuationMarkets, ValueBasis, WorkingState } from "@retrowatchdog/shared";
import { ACQUIRED_SOURCES, CONDITIONS, COUNTRY_CODES, DEFAULT_VALUATION_MARKETS, SUPPORTED_CURRENCIES, VALUATION_BASES, realizedUsd, returnedUsd, valuesCopies } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { acquisitions, collectionValueDaily, games, ownedCopies } from "../db/schema.js";
import { enabledSourceIds } from "../settings/markets.js";
import { displayTime, loadStoredBlock } from "../pricing/service.js";
import { estimateCopyValue } from "../collection/valuation.js";
import { admitsCopyPoint, copyRegionInput, type CopyDimensions } from "../collection/copySlice.js";
import { buildSignalInputs, computeSignals, type AcquiredCopy, type SignalConfig } from "../signals/computeSignals.js";
import { loadSignalConfig } from "../settings/signals.js";
import { loadSignalHistory, type SignalHistory } from "../signals/history.js";
import type { SourceRegistry } from "../sources/registry.js";
import type { AppDeps } from "../app.js";
import { ratesToUsd } from "../pricing/fx.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** FX down and no manual override covers the currency: the write must fail (503), never store a guess. */
class FxUnavailableError extends Error {
  constructor(currency: string) {
    super(`FX rate for ${currency} is unavailable — cannot convert to USD right now, try again later`);
    this.name = "FxUnavailableError";
  }
}

/** X->USD rate at write time; any FX failure becomes FxUnavailableError (503). */
async function usdRateFor(db: Db, currency: string): Promise<number> {
  let rate: number | undefined;
  try {
    rate = (await ratesToUsd(db, [currency])).get(currency);
  } catch {
    throw new FxUnavailableError(currency);
  }
  if (rate === undefined) throw new FxUnavailableError(currency);
  return rate;
}

const currencyEnum = z.enum(SUPPORTED_CURRENCIES);
// a link the UI may one day render: http(s) only, never javascript:
const httpUrl = z.string().max(500).refine((u) => u === "" || /^https?:\/\//i.test(u), "must be an http(s) URL");

const addSchema = z
  .object({
    gameId: z.number().int().positive(),
    region: z.enum(["PAL", "NTSC_U", "NTSC_J", "unknown"]),
    condition: z.enum(CONDITIONS),
    notes: z.string().max(500).optional(),
    acquiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    acquiredPriceOriginal: z.number().nonnegative().optional(),
    acquiredCurrency: currencyEnum.optional(),
    status: z.enum(["incoming", "owned", "listed"]).optional(),
    itemGrade: z.enum(["mint", "near_mint", "very_good", "good", "fair", "poor"]).optional(),
    // "pricecharting_import" included so importer-created copies PATCH-round-trip cleanly
    acquiredSource: z.enum(["ebay", "cex", "car_boot", "charity_shop", "store", "trade", "marketplace", "gift", "other", "pricecharting_import"]).optional(),
    acquiredUrl: httpUrl.optional(),
  })
  .refine((d) => (d.acquiredPriceOriginal === undefined) === (d.acquiredCurrency === undefined), {
    message: "acquiredPriceOriginal and acquiredCurrency go together",
  });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = z.number().nonnegative();
const updateSchema = z
  .object({
    status: z.enum(["incoming", "owned", "listed", "sold", "returned"]).optional(),
    region: z.enum(["PAL", "NTSC_U", "NTSC_J", "unknown"]).optional(),
    condition: z.enum(CONDITIONS).optional(),
    notes: z.string().max(500).nullable().optional(),
    itemGrade: z.enum(["mint", "near_mint", "very_good", "good", "fair", "poor"]).nullable().optional(),
    workingState: z.enum(["working", "partial", "untested", "faulty"]).nullable().optional(),
    authenticity: z.enum(["genuine", "suspect", "counterfeit"]).nullable().optional(),
    acquiredAt: z.string().regex(DATE_RE).nullable().optional(),
    acquiredPriceOriginal: money.nullable().optional(),
    acquiredCurrency: currencyEnum.nullable().optional(),
    acquiredSource: z.enum(["ebay", "cex", "car_boot", "charity_shop", "store", "trade", "marketplace", "gift", "other", "pricecharting_import"]).nullable().optional(),
    acquiredUrl: httpUrl.nullable().optional(),
    acquisitionId: z.number().int().positive().nullable().optional(),
    soldAt: z.string().regex(DATE_RE).nullable().optional(),
    soldPriceOriginal: money.nullable().optional(),
    soldFeesOriginal: money.nullable().optional(),
    soldCurrency: currencyEnum.nullable().optional(),
    soldVenue: z.string().max(100).nullable().optional(),
    returnedAt: z.string().regex(DATE_RE).nullable().optional(),
    refundOriginal: money.nullable().optional(),
    returnCostsOriginal: money.nullable().optional(),
  })
  .strict();

// Valuation basis and markets are per-request choices (preferences live client-side).
const valuationQuerySchema = z.object({
  valuation: z.enum(VALUATION_BASES).default("market"),
  country: z.enum(COUNTRY_CODES).default(DEFAULT_VALUATION_MARKETS.country),
  // NOT z.coerce.boolean(): that coerces the string "false" to true
  includeForeign: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

type CopyRow = typeof ownedCopies.$inferSelect;
type GameRow = typeof games.$inferSelect;

interface StoredForGame {
  points: PricePointDto[];
  displayAtBySource: Map<string, string | null>;
  /** the past slices the time-based signals compare against */
  history: Map<Region, SignalHistory>;
}

/**
 * Latest stored point batch per ENABLED source for one game (never a live
 * fetch), so a disabled market cannot keep barking from its last snapshot.
 * `sources` says which markets to READ; `registeredSources` what each may
 * still CLAIM (see `loadStoredBlock`).
 */
async function loadStoredForGame(
  db: Db,
  sources: SourceId[],
  gameId: number,
  registeredSources: SourceRegistry,
  cfg: SignalConfig,
): Promise<StoredForGame> {
  const points: PricePointDto[] = [];
  const displayAtBySource = new Map<string, string | null>();
  for (const source of sources) {
    const block = await loadStoredBlock(db, gameId, source, registeredSources);
    points.push(...(block?.points ?? []));
    displayAtBySource.set(source, displayTime(block) ?? null);
  }
  const history = await loadSignalHistory(db, gameId, sources, registeredSources.byId, cfg);
  return { points, displayAtBySource, history };
}

const asNumber = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Single place a copy row becomes its DTO: valuation, per-copy signals,
 * provenance. `sources` is read off `app.deps` per request: a rebuild REPLACES it.
 */
function toOwnedCopyDto(
  copy: CopyRow,
  game: GameRow,
  stored: StoredForGame | undefined,
  signalCfg: SignalConfig,
  valuationBasis: ValuationBasis,
  valuationMarkets: ValuationMarkets,
  sources: SourceRegistry,
): OwnedCopyDto {
  const excludedBasis: ValueBasis | null =
    copy.authenticity === "counterfeit"
      ? { readAs: "excluded", reason: "counterfeit" }
      : copy.workingState === "faulty"
        ? { readAs: "excluded", reason: "faulty" }
        : null;
  const dimensions: CopyDimensions = {
    region: copy.region as Region,
    condition: copy.condition as Condition,
    itemGrade: copy.itemGrade as ItemGrade | null,
  };
  // Shares the signal engine's sample floor: a median too thin to anchor a
  // bark is too thin to be a collection value.
  const estimate = excludedBasis
    ? null
    : estimateCopyValue(stored?.points ?? [], dimensions, valuationBasis, {
        minSample: signalCfg.minSample,
        markets: valuationMarkets,
        sources: sources.byId,
      });
  // freshness travels with the value: the batch time of the source whose point was used
  const valueFetchedAt = estimate ? (stored?.displayAtBySource.get(estimate.source) ?? null) : null;
  // Blamed on the markets setting only when points exist and NOT ONE comes
  // from a market allowed to value a copy.
  const storedPoints = stored?.points ?? [];
  const outsideValuationMarkets: ValueBasis | null =
    excludedBasis === null &&
    estimate === null &&
    storedPoints.length > 0 &&
    !storedPoints.some((p) => valuesCopies(p.source, valuationMarkets, sources.byId))
      ? { readAs: "excluded", reason: "outside_valuation_markets" }
      : null;
  // Per-copy signals from STORED points, sliced by the copy's dimensions like
  // the watchlist route. Hiding UNDERPRICED on owned items is the web's choice.
  const matchingPoints = (stored?.points ?? []).filter((p) =>
    admitsCopyPoint(dimensions, p, sources.byId),
  );
  // guaranteedGrade: the slice only admitted grade-matched points, so no
  // grade-asymmetry downgrade. acquired: PROFIT's input; only a complete paid
  // leg qualifies, and this route is its only caller.
  const acquiredPriceUsd = asNumber(copy.acquiredPriceUsd);
  const acquiredPriceOriginal = asNumber(copy.acquiredPriceOriginal);
  const acquired: AcquiredCopy | undefined =
    acquiredPriceUsd !== null && acquiredPriceOriginal !== null && copy.acquiredCurrency !== null
      ? {
          usd: acquiredPriceUsd,
          original: acquiredPriceOriginal,
          currency: copy.acquiredCurrency,
          condition: copy.condition as Condition,
        }
      : undefined;
  // Judged in ITS region's input only; undeclared-region points are the
  // ladder's fallback, synthesized in when the region has no exact points.
  const engineSignals = computeSignals(
    {
      ...copyRegionInput(buildSignalInputs(matchingPoints, sources.byId, stored?.history), dimensions.region),
      // a region with no stored points today still has its past
      history: stored?.history.get(dimensions.region),
      guaranteedGrade: dimensions.itemGrade,
      acquired,
      owned: { condition: copy.condition as Condition },
    },
    signalCfg,
    sources.byId,
  );
  // An unconfirmed candidate link may be the wrong game: force "potential".
  const signals =
    copy.matchBasis === "candidate"
      ? engineSignals.map((s) =>
          s.type === "INSUFFICIENT_DATA"
            ? s
            : {
                ...s,
                confidence: "potential" as const,
                caveats: [...(s.caveats ?? []), "match not confirmed — review the link"],
              },
        )
      : engineSignals;
  const summary: GameSummary = {
    id: game.id, title: game.title, platform: game.platform as Platform,
    year: game.year, coverUrl: game.coverUrl,
  };
  return {
    id: copy.id,
    game: summary,
    region: copy.region as Region,
    condition: copy.condition as Condition,
    notes: copy.notes,
    acquiredAt: copy.acquiredAt,
    acquiredPriceOriginal: asNumber(copy.acquiredPriceOriginal),
    acquiredCurrency: copy.acquiredCurrency as SupportedCurrency | null,
    acquiredPriceUsd: asNumber(copy.acquiredPriceUsd),
    status: copy.status as CopyStatus,
    itemGrade: copy.itemGrade as ItemGrade | null,
    workingState: copy.workingState as WorkingState | null,
    authenticity: copy.authenticity as Authenticity | null,
    acquiredSource: copy.acquiredSource as AcquiredSource | null,
    acquiredUrl: copy.acquiredUrl,
    acquisitionId: copy.acquisitionId,
    soldAt: copy.soldAt,
    soldPriceOriginal: asNumber(copy.soldPriceOriginal),
    soldFeesOriginal: asNumber(copy.soldFeesOriginal),
    soldCurrency: copy.soldCurrency as SupportedCurrency | null,
    soldPriceUsd: asNumber(copy.soldPriceUsd),
    soldFeesUsd: asNumber(copy.soldFeesUsd),
    soldVenue: copy.soldVenue,
    returnedAt: copy.returnedAt,
    refundOriginal: asNumber(copy.refundOriginal),
    returnCostsOriginal: asNumber(copy.returnCostsOriginal),
    refundUsd: asNumber(copy.refundUsd),
    returnCostsUsd: asNumber(copy.returnCostsUsd),
    estimatedValueUsd: estimate?.value ?? null,
    valueBasis: excludedBasis ?? estimate?.basis ?? outsideValuationMarkets,
    valueFetchedAt,
    signals,
    matchBasis: copy.matchBasis as MatchBasis | null,
    matchScore: copy.matchScore,
  };
}

/** Every copy as its DTO (valuation, signals) from stored prices: GET /api/collection and the insights engine. */
export async function loadCollectionItems(
  deps: Pick<AppDeps, "db" | "registry" | "sources">,
  signalCfg: SignalConfig,
  valuationBasis: ValuationBasis,
  valuationMarkets: ValuationMarkets,
): Promise<OwnedCopyDto[]> {
  const { db, registry, sources: registeredSources } = deps;
  const rows = await db
    .select({ copy: ownedCopies, game: games })
    .from(ownedCopies)
    .innerJoin(games, eq(games.id, ownedCopies.gameId));

  // ponytail: ~(sources * games) indexed queries; fine for a 200-item collection.
  const sources = await enabledSourceIds(db, registry);
  const gameIds = [...new Set(rows.map((r) => r.game.id))];
  // concurrent per game; the pg pool bounds how many run at once
  const storedByGame = new Map<number, StoredForGame>(
    await Promise.all(
      gameIds.map(async (id) => [id, await loadStoredForGame(db, sources, id, registeredSources, signalCfg)] as const),
    ),
  );
  return rows.map(({ copy, game }) =>
    toOwnedCopyDto(copy, game, storedByGame.get(game.id), signalCfg, valuationBasis, valuationMarkets, registeredSources),
  );
}

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/acquisitions", async (req, reply) => {
    const schema = z.object({
      totalPriceOriginal: z.number().nonnegative(),
      totalCurrency: currencyEnum,
      source: z.enum(["ebay", "cex", "car_boot", "charity_shop", "store", "trade", "marketplace", "gift", "other"]).optional(),
      url: z.string().max(500).optional(),
      acquiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      notes: z.string().max(500).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { db } = app.deps;
    let totalPriceUsd: number;
    try {
      const rate = await usdRateFor(db, parsed.data.totalCurrency);
      totalPriceUsd = round2(parsed.data.totalPriceOriginal * rate);
    } catch (err) {
      if (err instanceof FxUnavailableError) return reply.code(503).send({ error: err.message });
      throw err;
    }
    const [row] = await db
      .insert(acquisitions)
      .values({
        totalPriceOriginal: String(parsed.data.totalPriceOriginal),
        totalCurrency: parsed.data.totalCurrency,
        totalPriceUsd: String(totalPriceUsd),
        source: parsed.data.source,
        url: parsed.data.url,
        acquiredAt: parsed.data.acquiredAt,
        notes: parsed.data.notes,
      })
      .returning({ id: acquisitions.id });
    return reply.code(201).send({ id: row.id });
  });

  app.post("/api/collection", async (req, reply) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { db } = app.deps;
    const [game] = await db.select().from(games).where(eq(games.id, parsed.data.gameId));
    if (!game) return reply.code(404).send({ error: "game not found" });
    let acquiredPriceUsd: number | undefined;
    if (parsed.data.acquiredPriceOriginal !== undefined && parsed.data.acquiredCurrency !== undefined) {
      try {
        const rate = await usdRateFor(db, parsed.data.acquiredCurrency);
        acquiredPriceUsd = round2(parsed.data.acquiredPriceOriginal * rate);
      } catch (err) {
        if (err instanceof FxUnavailableError) return reply.code(503).send({ error: err.message });
        throw err;
      }
    }
    const [row] = await db
      .insert(ownedCopies)
      .values({
        gameId: parsed.data.gameId,
        region: parsed.data.region,
        condition: parsed.data.condition,
        notes: parsed.data.notes,
        acquiredAt: parsed.data.acquiredAt,
        acquiredPriceOriginal:
          parsed.data.acquiredPriceOriginal !== undefined ? String(parsed.data.acquiredPriceOriginal) : undefined,
        acquiredCurrency: parsed.data.acquiredCurrency,
        acquiredPriceUsd: acquiredPriceUsd !== undefined ? String(acquiredPriceUsd) : undefined,
        status: parsed.data.status,
        itemGrade: parsed.data.itemGrade,
        acquiredSource: parsed.data.acquiredSource,
        acquiredUrl: parsed.data.acquiredUrl,
      })
      .returning({ id: ownedCopies.id });
    return reply.code(201).send({ id: row.id });
  });

  app.patch("/api/collection/:id", async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    const body = updateSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const { db } = app.deps;
    const [current] = await db.select().from(ownedCopies).where(eq(ownedCopies.id, params.data.id));
    if (!current) return reply.code(404).send({ error: "copy not found" });

    const patch = body.data;
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: "empty patch" });
    }
    if (typeof patch.acquisitionId === "number") {
      const [acquisition] = await db
        .select()
        .from(acquisitions)
        .where(eq(acquisitions.id, patch.acquisitionId));
      if (!acquisition) return reply.code(400).send({ error: "acquisition not found" });
    }
    const effectiveStatus = patch.status ?? (current.status as CopyStatus);
    const effectiveSoldPrice =
      patch.soldPriceOriginal !== undefined ? patch.soldPriceOriginal : current.soldPriceOriginal;
    const effectiveSoldAt = patch.soldAt !== undefined ? patch.soldAt : current.soldAt;
    // 'sold' must carry the sale facts; disposal fields need their status
    if (effectiveStatus === "sold" && (effectiveSoldPrice == null || effectiveSoldAt == null)) {
      return reply.code(400).send({ error: "status 'sold' requires soldAt and soldPriceOriginal" });
    }
    const setsSoldFields =
      patch.soldAt != null ||
      patch.soldPriceOriginal != null ||
      patch.soldFeesOriginal != null ||
      patch.soldCurrency != null ||
      patch.soldVenue != null;
    if (setsSoldFields && effectiveStatus !== "sold") {
      return reply.code(400).send({ error: "sold_* fields require status 'sold'" });
    }
    const setsReturnedFields =
      patch.returnedAt != null || patch.refundOriginal != null || patch.returnCostsOriginal != null;
    if (setsReturnedFields && effectiveStatus !== "returned") {
      return reply.code(400).send({ error: "returned_* fields require status 'returned'" });
    }

    // A USD twin is re-frozen ONLY when its original is patched or its
    // denominating currency CHANGES (an echo is not a change). soldCurrency
    // denominates price, fees, refund and return costs. An untouched original
    // is never re-derived at today's rate.
    const fromNumeric = (v: string | null): number | null => (v === null ? null : Number(v));
    const resolve = <T>(patched: T | undefined, stored: T): T => (patched !== undefined ? patched : stored);

    const set: Partial<typeof ownedCopies.$inferInsert> = {
      status: patch.status,
      region: patch.region,
      condition: patch.condition,
      notes: patch.notes,
      itemGrade: patch.itemGrade,
      workingState: patch.workingState,
      authenticity: patch.authenticity,
      acquiredAt: patch.acquiredAt,
      acquiredSource: patch.acquiredSource,
      acquiredUrl: patch.acquiredUrl,
      acquisitionId: patch.acquisitionId,
      soldAt: patch.soldAt,
      soldVenue: patch.soldVenue,
      returnedAt: patch.returnedAt,
    };

    try {
      // acquisition leg
      const acquiredCurrencyChanges =
        patch.acquiredCurrency !== undefined && patch.acquiredCurrency !== current.acquiredCurrency;
      const touchesAcquired = patch.acquiredPriceOriginal !== undefined || acquiredCurrencyChanges;
      const nextAcquiredCurrency = resolve(
        patch.acquiredCurrency,
        current.acquiredCurrency as SupportedCurrency | null,
      );
      // an echo freezes nothing (and keeps the update set non-empty)
      if (patch.acquiredCurrency !== undefined && !acquiredCurrencyChanges) {
        set.acquiredCurrency = patch.acquiredCurrency;
      }
      if (touchesAcquired) {
        const nextOriginal = resolve(patch.acquiredPriceOriginal, fromNumeric(current.acquiredPriceOriginal));
        if (nextOriginal === null) {
          // no amount, no leg: clearing the price clears the whole unit
          set.acquiredPriceOriginal = null;
          set.acquiredCurrency = null;
          set.acquiredPriceUsd = null;
        } else {
          if (nextAcquiredCurrency === null) {
            return reply.code(400).send({ error: "acquiredCurrency is required when acquiredPriceOriginal is set" });
          }
          const rate = await usdRateFor(db, nextAcquiredCurrency);
          set.acquiredPriceOriginal = String(nextOriginal);
          set.acquiredCurrency = nextAcquiredCurrency;
          set.acquiredPriceUsd = String(round2(nextOriginal * rate));
        }
      }

      // sale leg: ONE currency covers price+fees
      const soldCurrencyChanges =
        patch.soldCurrency !== undefined && patch.soldCurrency !== current.soldCurrency;
      const touchesSale =
        patch.soldPriceOriginal !== undefined || patch.soldFeesOriginal !== undefined || soldCurrencyChanges;
      const nextSoldCurrency = resolve(patch.soldCurrency, current.soldCurrency as SupportedCurrency | null);
      // same echo rule as the acquisition leg
      if (patch.soldCurrency !== undefined && !soldCurrencyChanges) {
        set.soldCurrency = patch.soldCurrency;
      }
      if (touchesSale) {
        const nextPrice = resolve(patch.soldPriceOriginal, fromNumeric(current.soldPriceOriginal));
        const nextFees = resolve(patch.soldFeesOriginal, fromNumeric(current.soldFeesOriginal));
        if (nextPrice === null && nextFees === null) {
          set.soldPriceOriginal = null;
          set.soldFeesOriginal = null;
          set.soldPriceUsd = null;
          set.soldFeesUsd = null;
          // the currency may outlive cleared amounts: the return leg reuses it
          set.soldCurrency = nextSoldCurrency;
        } else {
          if (nextSoldCurrency === null) {
            return reply.code(400).send({ error: "soldCurrency is required when sold amounts are set" });
          }
          // an untouched component's USD twin is left out of `set`
          const refreezePrice = patch.soldPriceOriginal !== undefined || soldCurrencyChanges;
          const refreezeFees = patch.soldFeesOriginal !== undefined || soldCurrencyChanges;
          const rate = await usdRateFor(db, nextSoldCurrency);
          set.soldCurrency = nextSoldCurrency;
          set.soldPriceOriginal = nextPrice === null ? null : String(nextPrice);
          set.soldFeesOriginal = nextFees === null ? null : String(nextFees);
          if (refreezePrice) set.soldPriceUsd = nextPrice === null ? null : String(round2(nextPrice * rate));
          if (refreezeFees) set.soldFeesUsd = nextFees === null ? null : String(round2(nextFees * rate));
        }
      }

      // return leg: reuses soldCurrency; a purchase returned unsold falls back
      // to the acquisition currency (whose change does not re-freeze this leg).
      const touchesReturn =
        patch.refundOriginal !== undefined ||
        patch.returnCostsOriginal !== undefined ||
        soldCurrencyChanges;
      if (touchesReturn) {
        const nextRefund = resolve(patch.refundOriginal, fromNumeric(current.refundOriginal));
        const nextCosts = resolve(patch.returnCostsOriginal, fromNumeric(current.returnCostsOriginal));
        if (nextRefund === null && nextCosts === null) {
          // a bare currency change has nothing to re-freeze; only explicit clears write
          if (patch.refundOriginal !== undefined || patch.returnCostsOriginal !== undefined) {
            set.refundOriginal = null;
            set.returnCostsOriginal = null;
            set.refundUsd = null;
            set.returnCostsUsd = null;
          }
        } else {
          const returnCurrency = nextSoldCurrency ?? nextAcquiredCurrency;
          if (returnCurrency === null) {
            return reply.code(400).send({
              error: "return amounts need a currency: set soldCurrency (or acquiredCurrency for a purchase returned to the seller)",
            });
          }
          const refreezeRefund = patch.refundOriginal !== undefined || soldCurrencyChanges;
          const refreezeCosts = patch.returnCostsOriginal !== undefined || soldCurrencyChanges;
          const rate = await usdRateFor(db, returnCurrency);
          set.refundOriginal = nextRefund === null ? null : String(nextRefund);
          set.returnCostsOriginal = nextCosts === null ? null : String(nextCosts);
          if (refreezeRefund) set.refundUsd = nextRefund === null ? null : String(round2(nextRefund * rate));
          if (refreezeCosts) set.returnCostsUsd = nextCosts === null ? null : String(round2(nextCosts * rate));
        }
      }
    } catch (err) {
      if (err instanceof FxUnavailableError) return reply.code(503).send({ error: err.message });
      throw err;
    }

    await db.update(ownedCopies).set(set).where(eq(ownedCopies.id, params.data.id));
    return reply.code(204).send();
  });

  // Re-link a copy. Existence-only validation: cross-platform re-links are deliberate.
  app.patch("/api/collection/:id/link", async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    const body = z.object({ gameId: z.number().int().positive() }).strict().safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid request" });
    const { db, registry, sources } = app.deps;
    const [current] = await db.select().from(ownedCopies).where(eq(ownedCopies.id, params.data.id));
    if (!current) return reply.code(404).send({ error: "copy not found" });
    const [game] = await db.select().from(games).where(eq(games.id, body.data.gameId));
    if (!game) return reply.code(404).send({ error: "game not found" });
    const [updated] = await db
      .update(ownedCopies)
      // the old link's fuzzy score no longer applies
      .set({ gameId: body.data.gameId, matchBasis: "manual", matchScore: null })
      .where(eq(ownedCopies.id, params.data.id))
      .returning();
    const signalCfg = await loadSignalConfig(db);
    const stored = await loadStoredForGame(db, await enabledSourceIds(db, registry), game.id, sources, signalCfg);
    // link/confirm return one DTO the web discards before reloading the list,
    // so the defaults are enough here
    return toOwnedCopyDto(updated, game, stored, signalCfg, "market", DEFAULT_VALUATION_MARKETS, sources);
  });

  // The score stays as evidence of how the link was made.
  app.post("/api/collection/:id/confirm-link", async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const { db, registry, sources } = app.deps;
    const [current] = await db.select().from(ownedCopies).where(eq(ownedCopies.id, params.data.id));
    if (!current) return reply.code(404).send({ error: "copy not found" });
    const [updated] = await db
      .update(ownedCopies)
      .set({ matchBasis: "confirmed" })
      .where(eq(ownedCopies.id, params.data.id))
      .returning();
    const [game] = await db.select().from(games).where(eq(games.id, updated.gameId));
    const signalCfg = await loadSignalConfig(db);
    const stored = await loadStoredForGame(db, await enabledSourceIds(db, registry), game.id, sources, signalCfg);
    // link/confirm return one DTO the web discards before reloading the list,
    // so the defaults are enough here
    return toOwnedCopyDto(updated, game, stored, signalCfg, "market", DEFAULT_VALUATION_MARKETS, sources);
  });

  app.get("/api/collection", async (req, reply) => {
    const query = valuationQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: `valuation must be one of ${VALUATION_BASES.join(", ")}` });
    }
    const valuationBasis = query.data.valuation;
    const valuationMarkets: ValuationMarkets = {
      country: query.data.country,
      includeForeign: query.data.includeForeign,
    };
    const { db } = app.deps;
    const items = await loadCollectionItems(app.deps, await loadSignalConfig(db), valuationBasis, valuationMarkets);

    const isActive = (i: OwnedCopyDto): boolean => i.status !== "sold" && i.status !== "returned";
    const active = items.filter(isActive);
    // a lot's total counts once while any member is active
    const activeLotIds = [...new Set(active.map((i) => i.acquisitionId).filter((id): id is number => id !== null))];
    // a lot none of whose copies is active is closed: its cost moves to realized
    const allLotIds = [...new Set(items.map((i) => i.acquisitionId).filter((id): id is number => id !== null))];
    const lots =
      allLotIds.length === 0 ? [] : await db.select().from(acquisitions).where(inArray(acquisitions.id, allLotIds));
    const lotSum = (active: boolean): number =>
      lots
        .filter((a) => activeLotIds.includes(a.id) === active)
        .reduce((sum, a) => sum + Number(a.totalPriceUsd), 0);
    const lotTotals = lotSum(true);
    const body: CollectionResponse = {
      items,
      valuationBasis,
      valuationMarkets,
      totalEstimatedUsd: active.reduce((sum, i) => sum + (i.estimatedValueUsd ?? 0), 0),
      totalPaidUsd:
        lotTotals +
        active.filter((i) => i.acquisitionId === null).reduce((sum, i) => sum + (i.acquiredPriceUsd ?? 0), 0),
      // realized P&L nets the FROZEN USD legs, each at its own date's rate
      totalRealizedUsd: items.reduce((sum, i) => sum + realizedUsd(i), 0) - lotSum(false),
      totalReturnedUsd: items.reduce((sum, i) => sum + returnedUsd(i), 0),
    };
    // today's point on the value chart: the last computation of the day wins
    const snapshot = {
      estimatedUsd: body.totalEstimatedUsd.toFixed(2),
      paidUsd: body.totalPaidUsd.toFixed(2),
      updatedAt: new Date(),
    };
    await db
      .insert(collectionValueDaily)
      .values({
        day: new Date().toISOString().slice(0, 10),
        basis: valuationBasis,
        country: valuationMarkets.country,
        includeForeign: valuationMarkets.includeForeign,
        ...snapshot,
      })
      .onConflictDoUpdate({
        target: [
          collectionValueDaily.day,
          collectionValueDaily.basis,
          collectionValueDaily.country,
          collectionValueDaily.includeForeign,
        ],
        set: snapshot,
      });
    return body;
  });

  app.get("/api/collection/history", async (req, reply) => {
    const query = valuationQuerySchema
      .extend({ days: z.coerce.number().int().min(1).max(730).default(90) })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid params" });
    const { valuation, country, includeForeign, days } = query.data;
    const { db } = app.deps;
    // whole UTC days, inclusive of today, as the price history does
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await db
      .select()
      .from(collectionValueDaily)
      .where(
        and(
          eq(collectionValueDaily.basis, valuation),
          eq(collectionValueDaily.country, country),
          eq(collectionValueDaily.includeForeign, includeForeign),
          gte(collectionValueDaily.day, from),
        ),
      )
      .orderBy(asc(collectionValueDaily.day));
    const body: CollectionHistoryResponse = {
      valuationBasis: valuation,
      valuationMarkets: { country, includeForeign },
      days,
      from,
      to,
      points: rows.map((r) => ({ day: r.day, estimatedUsd: Number(r.estimatedUsd), paidUsd: Number(r.paidUsd) })),
    };
    return body;
  });

  // Deletes ALL copies, P&L history included (the UI confirms); ?source= narrows it.
  app.delete("/api/collection", async (req, reply) => {
    // .strict(): a typo'd key (?sorce=) must not widen a scoped wipe into a full one.
    const parsed = z.object({ source: z.enum(ACQUIRED_SOURCES).optional() }).strict().safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid source" });
    const { db } = app.deps;
    const deleted = await (parsed.data.source !== undefined
      ? db.delete(ownedCopies).where(eq(ownedCopies.acquiredSource, parsed.data.source))
      : db.delete(ownedCopies)
    ).returning({ id: ownedCopies.id });
    return { deleted: deleted.length };
  });

  app.delete("/api/collection/:id", async (req, reply) => {
    const parsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid id" });
    const { db } = app.deps;
    const [current] = await db.select().from(ownedCopies).where(eq(ownedCopies.id, parsed.data.id));
    if (!current) return reply.code(404).send({ error: "copy not found" });
    if (current.status === "sold" || current.status === "returned") {
      // P&L history is not deletable by misclick; change status first
      return reply.code(409).send({ error: "sold/returned copies carry P&L history - change status first" });
    }
    const deleted = await db
      .delete(ownedCopies)
      .where(eq(ownedCopies.id, parsed.data.id))
      .returning({ id: ownedCopies.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "copy not found" });
    return reply.code(204).send();
  });
}
