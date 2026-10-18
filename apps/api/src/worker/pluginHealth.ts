import pino from "pino";
import { CronExpressionParser } from "cron-parser";
import type { PluginManifest } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import type { PriceSourceAdapter } from "../adapters/types.js";
import { fetchPluginHealth, fetchPluginManifest } from "../plugins/client.js";
import { listPlugins, recordPluginHealth, type PluginHealth } from "../plugins/repo.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/** The two questions the tick asks a plugin, injectable so tests need no socket. */
export interface PluginProbe {
  health(baseUrl: string): Promise<PluginHealth>;
  manifest(baseUrl: string): Promise<PluginManifest>;
}

const defaultProbe: PluginProbe = { health: fetchPluginHealth, manifest: fetchPluginManifest };

/**
 * One pass over every non-disabled plugin: poll /health and /manifest and
 * write the answers to the `plugins` table, so `configured` is not frozen at
 * import time. The worker rebuilds its runtime every tick; the API rebuilds
 * via `deps.reloadSources()` when a route reports `configured`.
 *
 * ponytail: no circuit breaker, polls are sequential on a concurrency-1
 * worker. Worst case 2 × N × ADAPTER_TIMEOUT_MS per tick (measured: 3 hung
 * plugins = 24.1 s). Add a skip-after-N-failures (from `last_error`) if the
 * tick nears its interval (~19 plugins at defaults).
 */
export async function runPluginHealth(db: Db, probe: PluginProbe = defaultProbe): Promise<void> {
  for (const plugin of await listPlugins(db)) {
    if (plugin.status === "disabled") continue;
    // Whatever was learned before a failure is still written down. ONLY the
    // plugin's calls are in this try: a failure of our own DB write must not
    // be recorded as the plugin's error.
    let health: PluginHealth | null = null;
    let manifest: PluginManifest | null = null;
    let failure: string | null = null;
    try {
      health = await probe.health(plugin.baseUrl);
      manifest = await probe.manifest(plugin.baseUrl);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      log.warn({ plugin: plugin.id, baseUrl: plugin.baseUrl, err: failure }, "plugin poll failed");
    }
    try {
      // null = "nothing new learned" = keep the last known value, so one
      // unreachable tick doesn't report every plugin unconfigured.
      await recordPluginHealth(db, plugin.id, health, manifest, failure);
    } catch (err) {
      // one unwritable row must not cost the other plugins their poll
      log.error(
        { plugin: plugin.id, err: err instanceof Error ? err.message : String(err) },
        "plugin health could not be written; this app's database failed, not the plugin",
      );
    }
  }
}

/**
 * The two scheduler id shapes this worker owns (and may remove). Built in one
 * place so creation and reconciliation cannot drift apart.
 */
export const CATALOG_SYNC_PREFIX = "catalog-sync:";
export const TRACKED_REFRESH_PREFIX = "tracked-refresh:";
export const catalogSyncSchedulerId = (source: string): string => `${CATALOG_SYNC_PREFIX}${source}`;
export const trackedRefreshSchedulerId = (source: string): string =>
  `${TRACKED_REFRESH_PREFIX}${source}`;

/** A cadence, in the two shapes BullMQ takes: a cron `pattern` or an `every`. */
export interface SchedulerRepeat {
  pattern?: string;
  every?: number;
}

/** The slice of BullMQ's `Queue` used here, so tests need no Redis. */
export interface SchedulerQueue {
  upsertJobScheduler(
    id: string,
    repeat: SchedulerRepeat,
    job: { name: string; data: unknown },
  ): Promise<unknown>;
  removeJobScheduler(id: string): Promise<boolean>;
  getJobSchedulers(): Promise<Array<{ key: string } & SchedulerRepeat>>;
}

/** Same cadence, in the same shape: an absent field and an undefined one agree. */
function sameSchedule(existing: SchedulerRepeat | undefined, wanted: SchedulerRepeat): boolean {
  if (existing === undefined) return false;
  return existing.pattern === wanted.pattern && existing.every === wanted.every;
}

/**
 * Create the schedulers a source needs, touching nothing already right.
 *
 * Never upsert unconditionally: bullmq's upsert deletes the pending job (even
 * one already in `wait`), and for a cron it reschedules to the next occurrence
 * STRICTLY after now, so re-upserting an unchanged nightly cron at 03:00:05
 * silently skips tonight's sweep. Upsert only when missing or changed.
 */
export async function ensureSchedulers(
  queue: SchedulerQueue,
  syncAdapters: PriceSourceAdapter[],
  known?: Array<{ key: string } & SchedulerRepeat>,
): Promise<Set<string>> {
  const existing = new Map<string, SchedulerRepeat>();
  for (const scheduler of known ?? (await readSchedulers(queue))) {
    existing.set(scheduler.key, { pattern: scheduler.pattern, every: scheduler.every });
  }
  const wanted = new Set<string>();
  const upsert = async (id: string, repeat: SchedulerRepeat, name: string, source: string) => {
    if (sameSchedule(existing.get(id), repeat)) return;
    await queue.upsertJobScheduler(id, repeat, { name, data: { source } });
    log.info({ scheduler: id, ...repeat }, "scheduler created or rescheduled");
  };
  for (const adapter of syncAdapters) {
    const schedule = adapter.catalogSync?.schedule;
    if (schedule === undefined) continue;
    // wanted whatever happens below, so removal never unschedules a served source
    wanted.add(adapter.source);
    // Pre-parsed with bullmq's own parser: its parse throws out of the upsert
    // and would fail the whole tick. Reachable, because the manifest validator
    // checks only a cron's shape ("99 99 99 99 99" passes).
    if (parsesAsCron(schedule.catalogCron)) {
      await upsert(
        catalogSyncSchedulerId(adapter.source),
        { pattern: schedule.catalogCron },
        "catalog-sync",
        adapter.source,
      );
    } else {
      log.error(
        { source: adapter.source, cron: schedule.catalogCron.slice(0, 120) },
        "catalog cron cannot be parsed; this source gets no catalog-sync scheduler",
      );
    }
    await upsert(
      trackedRefreshSchedulerId(adapter.source),
      { every: schedule.trackedRefreshHours * 3_600_000 },
      "tracked-refresh",
      adapter.source,
    );
  }
  return wanted;
}

/**
 * What the queue already holds, or nothing — never a throw (boot must not die
 * on e.g. a legacy repeatable key). `reconcileSchedulers` does not use this:
 * it REMOVES, and must never decide that from a list that failed to load.
 */
async function readSchedulers(
  queue: SchedulerQueue,
): Promise<Array<{ key: string } & SchedulerRepeat>> {
  try {
    return await queue.getJobSchedulers();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "could not read the existing schedulers; every scheduler will be upserted",
    );
    return [];
  }
}

/** Would BullMQ's own repeat strategy accept this cron? Asked with its parser. */
function parsesAsCron(pattern: string): boolean {
  try {
    CronExpressionParser.parse(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the queue's repeatable jobs match the registry: every catalog-sync
 * source gets its pair of schedulers, and a pair whose source is gone is
 * removed. Removal rules:
 *   1. Only the two id shapes above are candidates (not `plugin-health`).
 *   2. The caller must pass the adapters of a rebuild that SUCCEEDED; an
 *      empty set then really means "no sync source served".
 * Two workers need no lock (same table, atomic scripts); two DIFFERENT builds
 * flap until the older one stops.
 */
export async function reconcileSchedulers(
  queue: SchedulerQueue,
  syncAdapters: PriceSourceAdapter[],
): Promise<void> {
  // read once, used for both upserts and removals
  const known = await queue.getJobSchedulers();
  const wanted = await ensureSchedulers(queue, syncAdapters, known);
  if (wanted.size === 0) log.warn("no catalog-sync source is served; removing their schedulers");
  for (const scheduler of known) {
    const source = sourceOfSchedulerId(scheduler.key);
    if (source === null) continue;
    if (wanted.has(source)) continue;
    await queue.removeJobScheduler(scheduler.key);
    log.info({ scheduler: scheduler.key, source }, "scheduler removed; source not in the registry");
  }
}

/** The source a scheduler id names, or null when this worker did not create it. */
function sourceOfSchedulerId(key: string): string | null {
  for (const prefix of [CATALOG_SYNC_PREFIX, TRACKED_REFRESH_PREFIX]) {
    if (!key.startsWith(prefix)) continue;
    const source = key.slice(prefix.length);
    // an empty remainder names no source: not ours to remove
    if (source !== "") return source;
  }
  return null;
}
