import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import pino from "pino";
import type { CollectionResponse, Platform, SourceInfo } from "@retrowatchdog/shared";
import { VALUATION_BASES } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { games, sourceMappings } from "../db/schema.js";
import type { PriceSourceAdapter } from "../adapters/types.js";
import { getPricesForGame } from "../pricing/service.js";
import { config } from "../config.js";
import { loadEnabledSources } from "../settings/markets.js";
import { collectionFrom, insightsFrom, ntfySender, runRecommendationAlerts, runWatchlistAlerts, watchlistFrom } from "./alerts.js";
import { runSignalLogStep } from "./signalLog.js";
import { loadSignalConfig } from "../settings/signals.js";
import {
  deleteUnseen, loadRanAt, makeBulkSink, makeDetailSink, markRan, sweepStale,
} from "./catalogSink.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Read once per job. A skipped job writes NO sync_state row, or enabling the
 * market later would find its catalog "fresh" and empty.
 */
async function sourceEnabled(db: Db, adapter: PriceSourceAdapter): Promise<boolean> {
  const enabled = (await loadEnabledSources(db)).has(adapter.source);
  if (!enabled) log.info({ source: adapter.source }, "market disabled; job skipped");
  return enabled;
}

async function syncUnit(db: Db, adapter: PriceSourceAdapter, unit: string): Promise<void> {
  const capability = adapter.catalogSync;
  if (!capability) throw new Error(`${adapter.source} has no catalogSync capability`);
  const runStartedAt = new Date();
  const report = await capability.syncUnit(unit, makeBulkSink(db, adapter.source, unit, runStartedAt));
  if (report.complete) {
    const deleted = await deleteUnseen(db, adapter.source, unit, runStartedAt);
    if (deleted > 0) log.info({ source: adapter.source, unit, deleted }, "delisted boxes removed");
  } else {
    // no silent truncation: an incomplete unit keeps its old rows
    log.warn({ source: adapter.source, unit, notes: report.notes }, "unit sync incomplete; delete-unseen skipped");
  }
  await markRan(db, `catalog-sync:${adapter.source}:${unit}`, runStartedAt);
  log.info({ source: adapter.source, unit, upserted: report.itemsUpserted }, "unit synced");
}

export async function runCatalogSyncUnit(db: Db, adapter: PriceSourceAdapter, unit: string): Promise<void> {
  if (!(await sourceEnabled(db, adapter))) return;
  await syncUnit(db, adapter, unit);
}

/** a bullmq-safe id segment for a sync unit name (no ':' and bounded) */
export const unitJobKey = (unit: string): string => createHash("sha1").update(unit).digest("hex").slice(0, 24);

export async function runCatalogSyncAll(db: Db, adapter: PriceSourceAdapter): Promise<void> {
  const capability = adapter.catalogSync;
  if (!capability) throw new Error(`${adapter.source} has no catalogSync capability`);
  if (!(await sourceEnabled(db, adapter))) return;
  // sequential: a shared client's breaker fast-fail is not queue-ordered
  // under concurrency. Budgeted: the worker has one lane, and a plugin that
  // pages slowly for days would hold the health tick and every other source.
  const deadline = Date.now() + config.CATALOG_SYNC_BUDGET_MINUTES * 60_000;
  const units = await capability.listSyncUnits();
  for (const [i, unit] of units.entries()) {
    if (Date.now() > deadline) {
      log.warn({ source: adapter.source, done: i, units: units.length }, "catalog sync stopped at its time budget; the rest wait for the next run");
      break;
    }
    await syncUnit(db, adapter, unit);
  }
  const swept = await sweepStale(db, adapter.source);
  if (swept > 0) log.info({ source: adapter.source, swept }, "stale rows swept");
}

/**
 * Does THIS tracked-refresh job own this cycle's cross-source snapshot? The
 * snapshot re-fetches every enabled market, so it must run once per cycle,
 * not once per catalog market. The LAST enabled catalog market owns it (the
 * others' detail refreshes have landed by then); an adapter not in the
 * registry owns its own.
 *
 * ponytail: the snapshot cadence is whatever `trackedRefreshHours` the last
 * catalog plugin's manifest declares (1..168). Fine while that is our own CeX
 * plugin; approving a third-party sync plugin is the trigger to give the pass
 * its own repeatable job.
 */
async function ownsSnapshotPass(
  db: Db,
  registry: PriceSourceAdapter[],
  adapter: PriceSourceAdapter,
): Promise<boolean> {
  const enabled = await loadEnabledSources(db);
  const catalogMarkets = registry.filter((a) => a.catalogSync && enabled.has(a.source));
  if (!catalogMarkets.some((a) => a.source === adapter.source)) return true;
  return catalogMarkets[catalogMarkets.length - 1].source === adapter.source;
}

/** Tracked set: owned (not sold/returned) ∪ watchlist; per-game effective-mode guard. */
async function trackedGames(db: Db): Promise<Array<{ id: number; title: string; platform: Platform; priceMode: string | null }>> {
  const rows = await db
    .selectDistinct({ id: games.id, title: games.title, platform: games.platform, priceMode: games.priceMode })
    .from(games)
    .where(
      sql`${games.id} IN (
        SELECT game_id FROM owned_copies WHERE status NOT IN ('sold', 'returned')
        UNION
        SELECT game_id FROM watchlist
      )`,
    );
  return rows.map((r) => ({ ...r, platform: r.platform as Platform }));
}

export async function runTrackedRefresh(
  db: Db,
  registry: PriceSourceAdapter[],
  adapter: PriceSourceAdapter,
  // the registry's role half, rebuilt in step with `registry`
  sources: Record<string, SourceInfo>,
): Promise<void> {
  const capability = adapter.catalogSync;
  if (!capability) throw new Error(`${adapter.source} has no catalogSync capability`);
  if (!(await sourceEnabled(db, adapter))) return;
  const startedAt = new Date();
  const targets = (await trackedGames(db)).filter(
    // cached_only means NO external traffic attributable to this game
    (g) => (g.priceMode ?? config.PRICE_MODE) !== "cached_only",
  );
  if (capability.refreshItems && targets.length > 0) {
    try {
      const mappings = await db
        .select({ sourceProductId: sourceMappings.sourceProductId })
        .from(sourceMappings)
        .where(
          and(
            eq(sourceMappings.source, adapter.source),
            inArray(sourceMappings.gameId, targets.map((g) => g.id)),
          ),
        );
      if (mappings.length > 0) {
        await capability.refreshItems(
          mappings.map((m) => m.sourceProductId),
          makeDetailSink(db, adapter.source),
        );
      }
    } catch (err) {
      // a refreshItems failure must not cancel the snapshot loop or markRan
      log.warn(
        { source: adapter.source, err: err instanceof Error ? err.message : String(err) },
        "refreshItems failed; continuing to snapshot loop",
      );
    }
  }
  const snapshots = await ownsSnapshotPass(db, registry, adapter);
  if (snapshots) {
    for (const game of targets) {
      // live snapshot across ALL configured sources; also creates mappings
      // for never-opened watchlist games
      await getPricesForGame(db, registry, game, { mode: "live" });
    }
    // right after prices got fresh; a failed alert must not fail the refresh
    if (config.NTFY_TOPIC) {
      try {
        const result = await runWatchlistAlerts(db, {
          fetchWatchlist: watchlistFrom(config.API_INTERNAL_URL),
          send: ntfySender(config.NTFY_URL, config.NTFY_TOPIC),
          config: await loadSignalConfig(db),
        });
        log.info(result, "watchlist alerts checked");
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "watchlist alerts failed");
      }
      try {
        const result = await runRecommendationAlerts(db, {
          fetchInsights: insightsFrom(config.API_INTERNAL_URL),
          send: ntfySender(config.NTFY_URL, config.NTFY_TOPIC),
        });
        log.info(result, "recommendation alerts checked");
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "recommendation alerts failed");
      }
    }
    // the collection's value chart gets today's point even if nobody opens the app;
    // the market body is reused by the signal log so the snapshot is written once
    let market: CollectionResponse | null = null;
    for (const basis of VALUATION_BASES) {
      try {
        const res = await fetch(`${config.API_INTERNAL_URL}/api/collection?valuation=${basis}`, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (basis === "market") market = (await res.json()) as CollectionResponse;
      } catch (err) {
        log.warn({ basis, err: err instanceof Error ? err.message : String(err) }, "collection value snapshot failed");
      }
    }
    // every signal of the watchlist and the collection into signal_log, then
    // judge the old ones; independent of alerts, and never fails the refresh
    const marketBody: CollectionResponse | null = market;
    try {
      const result = await runSignalLogStep(db, {
        fetchWatchlist: watchlistFrom(config.API_INTERNAL_URL),
        fetchCollection: marketBody === null ? collectionFrom(config.API_INTERNAL_URL) : async () => marketBody,
        registry: sources,
        config: await loadSignalConfig(db),
      });
      log.info(result, "signal log updated");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "signal log step failed");
    }
  }
  await markRan(db, `tracked-refresh:${adapter.source}`, startedAt);
  log.info(
    { source: adapter.source, games: snapshots ? targets.length : 0, snapshots },
    "tracked refresh done",
  );
}

/** The slice of BullMQ's `Queue` the boot catch-up needs, so tests need no Redis. */
export interface CatchUpQueue {
  add(name: string, data: unknown, opts: { jobId: string }): Promise<unknown>;
}

/**
 * Enqueue, at boot, the work whose scheduled firing was missed while this
 * worker was down. Only ENABLED markets are caught up.
 *
 * `computeCatchUp` calls the plugin (and parses its cron), so it is wrapped:
 * one plugin down at boot costs only its own catch-up. The enqueues are
 * outside that try: an unwritable Redis should end boot loudly.
 */
export async function runBootCatchUp(
  db: Db,
  queue: CatchUpQueue,
  syncAdapters: PriceSourceAdapter[],
): Promise<void> {
  const enabled = await loadEnabledSources(db);
  for (const adapter of syncAdapters) {
    if (!enabled.has(adapter.source)) {
      log.info({ source: adapter.source }, "market disabled; no boot catch-up");
      continue;
    }
    let due: { staleUnits: string[]; trackedDue: boolean };
    try {
      due = await computeCatchUp(db, adapter);
    } catch (err) {
      log.error(
        { source: adapter.source, err: err instanceof Error ? err.message : String(err) },
        "boot catch-up skipped for this source; its schedulers still stand",
      );
      continue;
    }
    // Dedup ids so a second worker cannot double-enqueue a unit. Dots, not
    // colons: bullmq rejects a custom jobId with ':' ("Custom Id cannot
    // contain :") unless it has exactly 3 segments.
    for (const unit of due.staleUnits) {
      await queue.add(
        "catalog-sync-unit",
        { source: adapter.source, unit },
        // the unit's hash, never the name: a ':' in a plugin's unit name is
        // legal for the protocol but refused by bullmq, and that throw here
        // would crash-loop the worker at boot
        { jobId: `catalog-sync-unit.${adapter.source}.${unitJobKey(unit)}` },
      );
    }
    if (due.trackedDue) {
      await queue.add(
        "tracked-refresh",
        { source: adapter.source },
        { jobId: `tracked-refresh.${adapter.source}` },
      );
    }
    log.info(
      { source: adapter.source, staleUnits: due.staleUnits.length, trackedDue: due.trackedDue },
      "boot catch-up enqueued",
    );
  }
}

/** Boot catch-up: stale = a scheduled firing was missed since ran_at. */
export async function computeCatchUp(
  db: Db,
  adapter: PriceSourceAdapter,
  now = new Date(),
): Promise<{ staleUnits: string[]; trackedDue: boolean }> {
  const capability = adapter.catalogSync;
  if (!capability) return { staleUnits: [], trackedDue: false };
  const lastFiring = CronExpressionParser.parse(capability.schedule.catalogCron, {
    currentDate: now,
  })
    .prev()
    .toDate();
  const staleUnits: string[] = [];
  for (const unit of await capability.listSyncUnits()) {
    const ranAt = await loadRanAt(db, `catalog-sync:${adapter.source}:${unit}`);
    if (ranAt === null || ranAt < lastFiring) staleUnits.push(unit);
  }
  const trackedRan = await loadRanAt(db, `tracked-refresh:${adapter.source}`);
  const trackedDue =
    trackedRan === null ||
    now.getTime() - trackedRan.getTime() > capability.schedule.trackedRefreshHours * 3_600_000;
  return { staleUnits, trackedDue };
}
