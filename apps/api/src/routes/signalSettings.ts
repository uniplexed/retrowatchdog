import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  pickVerdict,
  SIGNAL_TYPES,
  SUPPORTED_CURRENCIES,
  verdictTitle,
  type SignalConfigDto,
  type Platform,
  type SignalPreviewResponse,
  type SourceInfo,
} from "@retrowatchdog/shared";
import {
  loadSignalConfig,
  resetSignalConfig,
  saveSignalConfig,
  toSignalConfigDto,
  withMinGainUsd,
} from "../settings/signals.js";
import { money } from "../signals/computeSignals.js";
import { computeWatchlistItems } from "./watchlist.js";
import { computeInsights } from "./insights.js";
import { suggestThresholds } from "../insights/suggest.js";
import { loadSeries } from "../insights/series.js";
import { enabledSourceIds } from "../settings/markets.js";
import { games, ownedCopies, pricePoints, watchlist } from "../db/schema.js";
import { eq, min, notInArray } from "drizzle-orm";

const factor = z.number().positive().max(100);
const percent = z.number().gt(0).max(100);
const days = z.number().int().min(1).max(365);
/** a percent a rule may set to 0 (no margin), unlike the signal percents */
const share = z.number().min(0).max(100);
const count = z.number().int().min(1).max(1000);

/** The whole object, every field required: a PUT replaces the configuration. */
const configSchema = z
  .object({
    underpricedFactor: factor,
    overpricedFactor: factor,
    flipFactor: factor,
    profitFactor: factor,
    crossStoreFactor: factor,
    minSample: z.number().int().min(1).max(1000),
    priceDropPct: percent,
    priceDropDays: days,
    newLowDays: days,
    risingPct: percent,
    risingDays: days,
    enabledTypes: z.array(z.enum(SIGNAL_TYPES)).max(SIGNAL_TYPES.length),
    excludedSources: z.array(z.string().min(1).max(64)).max(100),
    minGain: z.object({ amount: z.number().nonnegative().max(1_000_000), currency: z.enum(SUPPORTED_CURRENCIES) }).nullable(),
    alertLowConfidence: z.boolean(),
    sellHighDays: days,
    trendDays: days,
    buyLowDays: days,
    buyBelowAvgPct: share,
    targetWindowDays: days,
    targetNearPct: share,
    targetOftenPct: share,
    quietPct: share,
    quietDays: days,
    sourceWindowDays: days,
    sourceDominancePct: share,
    minGamesPerConsole: count,
    reliabilityMinPct: share,
    evalDays: days,
    beatenPct: share,
    logRetentionDays: z.number().int().min(1).max(3650),
    historyDays: days,
  })
  .strict();

const invalid = (error: z.ZodError) => ({ error: `invalid signal configuration: ${error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}` });

export async function signalSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/signals", async (): Promise<SignalConfigDto> => toSignalConfigDto(await loadSignalConfig(app.deps.db)));

  app.put("/api/settings/signals", async (req, reply) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error));
    return toSignalConfigDto(await saveSignalConfig(app.deps.db, parsed.data));
  });

  app.post("/api/settings/signals/reset", async (): Promise<SignalConfigDto> => resetSignalConfig(app.deps.db));

  app.post("/api/settings/signals/preview", async (req, reply) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error));
    const { db, sources } = app.deps;
    const draft = await withMinGainUsd(db, parsed.data);
    const items = await computeWatchlistItems(app.deps, draft);
    const label = (id: string): string => (sources.byId as Record<string, SourceInfo>)[id]?.label ?? id;
    const title = (s: Parameters<typeof verdictTitle>[0]) =>
      verdictTitle(s, label, (a) => money(a.original, a.currency));
    let withSignal = 0;
    let example: SignalPreviewResponse["example"] = null;
    for (const item of items) {
      const verdict = pickVerdict(item.signals, title);
      if (verdict === null) continue;
      withSignal += 1;
      example ??= { title: item.game.title, verdictTitle: verdict.title };
    }
    const { recommendations: recs } = await computeInsights(app.deps, draft, new Date(), items);
    const count = (...actions: string[]) => recs.filter((r) => actions.includes(r.action)).length;
    const body: SignalPreviewResponse = {
      watches: items.length,
      withSignal,
      example,
      recommendations: {
        sellNow: count("sell_now"),
        buyNow: count("buy_now"),
        targets: count("raise_target", "lower_target"),
        cleanUps: count("unwatch", "review_copy"),
      },
    };
    return body;
  });

  app.get("/api/settings/signals/suggested", async () => {
    const { db, registry, sources } = app.deps;
    const watched = await db.select({ gameId: watchlist.gameId, platform: games.platform }).from(watchlist).innerJoin(games, eq(games.id, watchlist.gameId));
    const owned = await db
      .selectDistinct({ gameId: ownedCopies.gameId, platform: games.platform })
      .from(ownedCopies)
      .innerJoin(games, eq(games.id, ownedCopies.gameId))
      .where(notInArray(ownedCopies.status, ["sold", "returned"]));
    const platformOf = new Map([...watched, ...owned].map((g) => [g.gameId, g.platform as Platform]));
    const platformsCount = new Map<Platform, number>();
    for (const p of platformOf.values()) platformsCount.set(p, (platformsCount.get(p) ?? 0) + 1);
    const [{ first }] = await db.select({ first: min(pricePoints.fetchedAt) }).from(pricePoints);
    const coverageDays = first ? Math.floor((Date.now() - new Date(first).getTime()) / 86_400_000) : 0;
    const watchedIds = [...new Set(watched.map((w) => w.gameId))];
    const series = await loadSeries(db, watchedIds, await enabledSourceIds(db, registry), sources.byId, 365);
    return suggestThresholds(series, watched.length, platformsCount, coverageDays);
  });
}

