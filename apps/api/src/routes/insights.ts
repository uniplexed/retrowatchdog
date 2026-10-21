import type { FastifyInstance } from "fastify";
import { and, gte, isNotNull, min, notInArray, sql } from "drizzle-orm";
import { DEFAULT_VALUATION_MARKETS, compareRecommendations, type GameSummary, type InsightsResponse, type Recommendation, type SourceId, type WatchlistItemDto } from "@retrowatchdog/shared";
import type { AppDeps } from "../app.js";
import { ownedCopies, signalLog, watchlist } from "../db/schema.js";
import { enabledSourceIds } from "../settings/markets.js";
import { loadSignalConfig, onSignalConfigSaved } from "../settings/signals.js";
import type { SignalConfig } from "../signals/computeSignals.js";
import { reliabilityRows } from "../signals/log.js";
import { MAX_WINDOW_DAYS, parseWindow } from "../lib/window.js";
import { loadSeries, sliceFor } from "../insights/series.js";
import { window } from "../insights/money.js";
import { sellNow } from "../insights/sell.js";
import { buyNow } from "../insights/buy.js";
import { targetAdvice } from "../insights/targets.js";
import { quietAdvice } from "../insights/quiet.js";
import { preferSource } from "../insights/sources.js";
import { reviewThresholds } from "../insights/reliability.js";
import { computeWatchlistItems } from "./watchlist.js";
import { loadCollectionItems } from "./collection.js";

const DAY_MS = 86_400_000;
const CACHE_MS = 10 * 60_000;

/** copies and watches get one recommendation each; consoles and signal types may get several */
const subjectKey = (r: Recommendation): string | null =>
  r.subject.kind === "copy" ? `c${r.subject.copyId}` : r.subject.kind === "watch" ? `w${r.subject.watchId}` : null;

/** Every recommendation for this deployment from stored prices, plus the signal reliability table. */
export async function computeInsights(
  deps: Pick<AppDeps, "db" | "registry" | "sources">,
  cfg: SignalConfig,
  now: Date = new Date(),
  /** the watchlist under `cfg` when the caller already computed it (the settings preview) */
  preloaded?: WatchlistItemDto[],
): Promise<InsightsResponse> {
  const { db, registry, sources } = deps;
  const days = Math.max(cfg.sellHighDays, cfg.buyLowDays, cfg.targetWindowDays, cfg.quietDays, cfg.sourceWindowDays);
  // the series query is the slowest read: start it beside the per-game loaders, not after them
  const seriesLoad = Promise.all([
    db.select({ id: watchlist.gameId }).from(watchlist),
    db.select({ id: ownedCopies.gameId }).from(ownedCopies).where(notInArray(ownedCopies.status, ["sold", "returned"])),
    enabledSourceIds(db, registry),
  ]).then(([w, c, enabled]) => loadSeries(db, [...new Set([...w, ...c].map((r) => r.id))], enabled, sources.byId, days, now));
  const [watches, copies, series, reliability, logged, [first]] = await Promise.all([
    preloaded ?? computeWatchlistItems(deps, cfg),
    loadCollectionItems(deps, cfg, "market", DEFAULT_VALUATION_MARKETS),
    seriesLoad,
    reliabilityRows(db),
    db
      .select({ watchId: signalLog.watchId, n: sql<number>`count(*)::int` })
      .from(signalLog)
      .where(and(isNotNull(signalLog.watchId), gte(signalLog.firstSeenAt, new Date(now.getTime() - cfg.quietDays * DAY_MS))))
      .groupBy(signalLog.watchId),
    db.select({ at: min(signalLog.firstSeenAt) }).from(signalLog),
  ]);
  const active = copies.filter((c) => c.status !== "sold" && c.status !== "returned");
  const gamesById = new Map<number, GameSummary>([...watches.map((w) => [w.game.id, w.game] as const), ...active.map((c) => [c.game.id, c.game] as const)]);
  const labels = (id: SourceId): string => sources.byId[id]?.label ?? id;
  const loggedByWatch = new Map(logged.map((r) => [r.watchId!, r.n]));

  const all = [
    ...sellNow(copies, series, cfg, labels, now),
    ...buyNow(watches, series, cfg, labels, now),
    ...targetAdvice(watches, series, cfg, labels, now),
    ...quietAdvice(watches, copies, series, loggedByWatch, cfg, now),
    ...preferSource(
      [...gamesById.values()].map((game) => ({ game, readings: window(sliceFor(series.get(game.id), null, null), cfg.sourceWindowDays, now) })),
      cfg,
      labels,
    ),
    ...reviewThresholds(reliability, cfg, now),
  ].sort(compareRecommendations);
  const seen = new Set<string>();
  const recommendations = all.filter((r) => {
    const key = subjectKey(r);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    recommendations,
    reliability,
    measuredSince: first?.at ? new Date(first.at).toISOString() : null,
    computedAt: now.toISOString(),
  };
}

// ponytail: one cached body per key per process. Prices only move when the worker
// refreshes, so a body lives CACHE_MS; any API write clears it and re-warms insights.
const cache = new Map<string, { at: number; body: unknown }>();
const inflight = new Map<string, { generation: number; body: Promise<unknown> }>();
let generation = 0;
export function clearInsightsCache(): void {
  generation += 1;
  cache.clear();
}
onSignalConfigSaved.push(clearInsightsCache);

/** the body under `key` while fresh; concurrent callers share one computation; a clear discards bodies begun before it */
export async function cachedFor<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.body as T;
  const running = inflight.get(key);
  if (running !== undefined && running.generation === generation) return running.body as Promise<T>;
  const started = generation;
  const body = compute();
  inflight.set(key, { generation: started, body });
  try {
    const value = await body;
    if (started === generation) cache.set(key, { at: Date.now(), body: value });
    return value;
  } finally {
    if (inflight.get(key)?.body === body) inflight.delete(key);
  }
}

/** recompute the insights body in the background (after a write, at boot) so the next read is instant */
export function warmInsights(deps: AppDeps, log: { warn: (o: unknown, m: string) => void }): void {
  cachedFor("insights", async () => computeInsights(deps, await loadSignalConfig(deps.db))).catch((err) => log.warn({ err }, "insights warm-up failed"));
}

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/insights", async () => cachedFor("insights", async () => computeInsights(app.deps, await loadSignalConfig(app.deps.db))));

  // the reliability table for one period: the signals first seen inside it
  app.get("/api/insights/reliability", async (req, reply) => {
    const window = parseWindow(req.query as Record<string, unknown>, MAX_WINDOW_DAYS);
    if (!window.ok) return reply.code(400).send({ error: window.reason });
    const { from, to, days } = window;
    return { from, to, days, reliability: await reliabilityRows(app.deps.db, { from, to }) };
  });
}
