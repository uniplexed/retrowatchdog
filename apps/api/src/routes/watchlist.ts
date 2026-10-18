import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type {
  Condition, GameSummary, Platform, PriceRole, PricePointDto, Region, Signal, SignalType, SourceId,
  StoreQuoteDto, SupportedCurrency, WatchlistItemDto, WatchlistResponse,
} from "@retrowatchdog/shared";
import { CONDITIONS, kindDisplayLabel, REGIONS, SUPPORTED_CURRENCIES } from "@retrowatchdog/shared";
import { games, watchlist } from "../db/schema.js";
import { isUniqueViolation } from "../db/errors.js";
import { displayTime, loadStoredBlock } from "../pricing/service.js";
import { buildSignalInputs, computeSignals, type SignalConfig } from "../signals/computeSignals.js";
import type { AppDeps } from "../app.js";
import { loadSignalConfig } from "../settings/signals.js";
import { loadSignalHistory, type SignalHistory } from "../signals/history.js";
import { watchTarget } from "../signals/target.js";
import { ratesToUsd } from "../pricing/fx.js";
import { enabledSourceIds } from "../settings/markets.js";

const addSchema = z
  .object({
    gameId: z.number().int().positive(),
    region: z.enum(["PAL", "NTSC_U", "NTSC_J", "unknown"]).optional(),
    // shared runtime list, so a new tier cannot be rejected only here
    condition: z.enum(CONDITIONS).optional(),
    // an amount travels with its currency; USD conversion happens at write time
    targetPriceOriginal: z.number().nonnegative().optional(),
    targetCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
  })
  .refine((d) => (d.targetPriceOriginal === undefined) === (d.targetCurrency === undefined), {
    message: "targetPriceOriginal and targetCurrency go together",
  });

const updateSchema = z
  .object({
    region: z.enum(REGIONS).nullable().optional(),
    condition: z.enum(CONDITIONS).nullable().optional(),
    targetPriceOriginal: z.number().nonnegative().nullable().optional(),
    targetCurrency: z.enum(SUPPORTED_CURRENCIES).nullable().optional(),
  })
  .strict()
  .refine((d) => (d.targetPriceOriginal === undefined) === (d.targetCurrency === undefined), {
    message: "targetPriceOriginal and targetCurrency go together",
  })
  .refine((d) => (d.targetPriceOriginal === null) === (d.targetCurrency === null), {
    message: "clear targetPriceOriginal and targetCurrency together",
  });

/** The signals whose price is what you would pay, so a buy target can gate them. */
const BUY_SIGNALS: ReadonlySet<SignalType> = new Set<SignalType>([
  "UNDERPRICED",
  "FLIP",
  "PRICE_DROP",
  "NEW_LOW",
  "BACK_IN_STOCK",
  "TARGET_HIT",
]);

/**
 * A buy signal is within the target when its price is at or under it: in the
 * quoted currency when both share one (no FX drift), in frozen USD otherwise.
 */
export function withinTarget(
  signal: Signal,
  target: { original: number | null; currency: string | null; usd: number | null },
): boolean {
  if (!BUY_SIGNALS.has(signal.type) || signal.price === undefined || target.usd === null) return true;
  if (target.original !== null && target.currency === signal.price.currency) {
    return signal.price.original <= target.original;
  }
  return signal.price.usd <= target.usd;
}

/** NULL dimension = "any" (spec: watchlist NULL semantics). */
function matches(p: PricePointDto, region: string | null, condition: string | null): boolean {
  return (region === null || p.region === region) && (condition === null || p.condition === condition);
}

/**
 * Every watch with its shop quote and signals under `cfg`. GET /api/watchlist
 * passes the stored configuration; the settings preview passes a draft one.
 */
export async function computeWatchlistItems(
  deps: Pick<AppDeps, "db" | "registry" | "sources">,
  cfg: SignalConfig,
): Promise<WatchlistItemDto[]> {
  const { db, registry, sources: registeredSources } = deps;
  const rows = await db
    .select({ watch: watchlist, game: games })
    .from(watchlist)
    .innerJoin(games, eq(games.id, watchlist.gameId));

  // Enabled markets only: a switched-off market must stop raising barks.
  const sources = await enabledSourceIds(db, registry);
  const storedByGame = new Map<
    number,
    { points: PricePointDto[]; displayAtBySource: Map<SourceId, string | null>; history: Map<Region, SignalHistory> }
  >();
  // concurrent per game; the pg pool bounds how many run at once
  await Promise.all(
    [...new Set(rows.map((r) => r.game.id))].map(async (id) => {
      const points: PricePointDto[] = [];
      // freshness per source: the date belongs to the shop that supplied the numbers
      const displayAtBySource = new Map<SourceId, string | null>();
      for (const source of sources) {
        // a stored row of a kind the registry declares no role for is not read
        const block = await loadStoredBlock(db, id, source, registeredSources);
        points.push(...(block?.points ?? []));
        displayAtBySource.set(source, displayTime(block) ?? null);
      }
      const history = await loadSignalHistory(db, id, sources, registeredSources.byId, cfg);
      storedByGame.set(id, { points, displayAtBySource, history });
    }),
  );

  return rows.map(({ watch, game }) => {
    const stored = storedByGame.get(game.id);
    const matching = (stored?.points ?? []).filter((p) => matches(p, watch.region, watch.condition));
    const roleOf = (p: PricePointDto): PriceRole | undefined =>
      registeredSources.byId[p.source]?.kindRoles[p.kind];
    // Offer = cheapest in-stock buy_store price (NULL stock counts as in stock).
    const offers = matching
      .filter((p) => roleOf(p) === "buy_store" && p.available !== false)
      .sort((a, b) => a.priceUsd - b.priceUsd);
    const offer = offers[0] ?? null;
    // Payouts from the same shop and grade (null included) as the offer: pairing
    // across shops or with a graded SKU's voucher quotes a spread nobody offers.
    // No availability gate: CeX keeps buying an out-of-stock box.
    const bids =
      offer === null
        ? []
        : matching
            .filter(
              (p) =>
                roleOf(p) === "bid" &&
                p.source === offer.source &&
                p.region === offer.region &&
                p.condition === offer.condition &&
                p.grade === offer.grade,
            )
            // A per_listing shop can hold several boxes per slice: keep the highest
            // bid per kind, as computeSignals.ts does.
            .reduce<PricePointDto[]>((deduped, p) => {
              const i = deduped.findIndex((b) => b.kind === p.kind);
              if (i === -1) deduped.push(p);
              else if (p.priceUsd > deduped[i].priceUsd) deduped[i] = p;
              return deduped;
            }, [])
            .sort((a, b) => a.kind.localeCompare(b.kind));
    const quote = (p: PricePointDto): StoreQuoteDto => ({
      kind: p.kind,
      label: kindDisplayLabel(registeredSources.byId, p.source, p.kind),
      priceUsd: p.priceUsd,
      priceOriginal: p.priceOriginal,
      currencyOriginal: p.currencyOriginal,
    });
    const summary: GameSummary = {
      id: game.id, title: game.title, platform: game.platform as Platform,
      year: game.year, coverUrl: game.coverUrl,
    };
    // Pass the registry: an approved plugin's roles live only there.
    const watchedTarget = watchTarget(watch);
    const signals = buildSignalInputs(matching, registeredSources.byId, stored?.history).flatMap((input) =>
      computeSignals({ ...input, targets: watchedTarget === undefined ? [] : [watchedTarget] }, cfg, registeredSources.byId),
    );
    const target = {
      original: watch.targetPriceOriginal === null ? null : Number(watch.targetPriceOriginal),
      currency: watch.targetCurrency,
      usd: watch.targetPriceUsd === null ? null : Number(watch.targetPriceUsd),
    };
    return {
      id: watch.id,
      game: summary,
      region: watch.region as Region | null,
      condition: watch.condition as Condition | null,
      targetPriceOriginal: watch.targetPriceOriginal === null ? null : Number(watch.targetPriceOriginal),
      targetCurrency: watch.targetCurrency as SupportedCurrency | null,
      targetPriceUsd: watch.targetPriceUsd === null ? null : Number(watch.targetPriceUsd),
      storeOffer: offer === null ? null : quote(offer),
      storeBids: bids.map(quote),
      storeSource: offer?.source ?? null,
      // the offering shop's batch time; an empty slice has no date
      priceDisplayAt:
        offer === null ? null : (stored?.displayAtBySource.get(offer.source) ?? null),
      signals: signals.filter((s) => withinTarget(s, target)),
      signalsAboveTarget: signals.filter((s) => !withinTarget(s, target)).length,
    };
  });
}

export async function watchlistRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/watchlist", async (req, reply) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { db } = app.deps;
    const [game] = await db.select().from(games).where(eq(games.id, parsed.data.gameId));
    if (!game) return reply.code(404).send({ error: "game not found" });
    // freeze the USD twin at write time; FX down = clean 503, never a guess
    let targetPriceUsd: number | undefined;
    if (parsed.data.targetPriceOriginal !== undefined && parsed.data.targetCurrency !== undefined) {
      try {
        const rate = (await ratesToUsd(db, [parsed.data.targetCurrency])).get(parsed.data.targetCurrency);
        if (rate === undefined) throw new Error("no rate");
        targetPriceUsd = Math.round(parsed.data.targetPriceOriginal * rate * 100) / 100;
      } catch {
        return reply.code(503).send({
          error: `FX rate for ${parsed.data.targetCurrency} is unavailable — cannot convert to USD right now, try again later`,
        });
      }
    }
    try {
      const [row] = await db
        .insert(watchlist)
        .values({
          gameId: parsed.data.gameId,
          region: parsed.data.region,
          condition: parsed.data.condition,
          targetPriceOriginal:
            parsed.data.targetPriceOriginal !== undefined ? String(parsed.data.targetPriceOriginal) : undefined,
          targetCurrency: parsed.data.targetCurrency,
          targetPriceUsd: targetPriceUsd !== undefined ? String(targetPriceUsd) : undefined,
        })
        .returning({ id: watchlist.id });
      return reply.code(201).send({ id: row.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: "already watching this combination" });
      }
      throw err;
    }
  });

  app.get("/api/watchlist", async (): Promise<WatchlistResponse> => {
    // Read per request: `sources` is replaced when a plugin is approved or removed.
    return { items: await computeWatchlistItems(app.deps, await loadSignalConfig(app.deps.db)) };
  });

  app.patch("/api/watchlist/:id", async (req, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { db } = app.deps;
    const patch = parsed.data;
    const set: Partial<typeof watchlist.$inferInsert> = {};
    if (patch.region !== undefined) set.region = patch.region;
    if (patch.condition !== undefined) set.condition = patch.condition;
    if (patch.targetPriceOriginal !== undefined) {
      if (patch.targetPriceOriginal === null || patch.targetCurrency == null) {
        set.targetPriceOriginal = null;
        set.targetCurrency = null;
        set.targetPriceUsd = null;
      } else {
        // freeze the USD twin at write time; FX down = clean 503, never a guess
        const rate = await ratesToUsd(db, [patch.targetCurrency])
          .then((r) => r.get(patch.targetCurrency!))
          .catch(() => undefined);
        if (rate === undefined) {
          return reply.code(503).send({
            error: `FX rate for ${patch.targetCurrency} is unavailable — cannot convert to USD right now, try again later`,
          });
        }
        set.targetPriceOriginal = String(patch.targetPriceOriginal);
        set.targetCurrency = patch.targetCurrency;
        set.targetPriceUsd = String(Math.round(patch.targetPriceOriginal * rate * 100) / 100);
      }
    }
    if (Object.keys(set).length === 0) return reply.code(400).send({ error: "nothing to update" });
    try {
      const updated = await db
        .update(watchlist)
        .set(set)
        .where(eq(watchlist.id, params.data.id))
        .returning({ id: watchlist.id });
      if (updated.length === 0) return reply.code(404).send({ error: "watch not found" });
      return { id: updated[0].id };
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: "already watching this combination" });
      }
      throw err;
    }
  });

  // Deletes every watch; the UI confirms, the count reports "Removed N".
  app.delete("/api/watchlist", async (req, reply) => {
    // .strict(): a scoped-delete attempt (?gameId=7) must 400, not wipe everything.
    const parsed = z.object({}).strict().safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "this endpoint takes no query parameters" });
    }
    const { db } = app.deps;
    const deleted = await db.delete(watchlist).returning({ id: watchlist.id });
    return { deleted: deleted.length };
  });

  app.delete("/api/watchlist/:id", async (req, reply) => {
    const parsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid id" });
    const { db } = app.deps;
    const deleted = await db
      .delete(watchlist)
      .where(eq(watchlist.id, parsed.data.id))
      .returning({ id: watchlist.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "watch not found" });
    return reply.code(204).send();
  });
}
