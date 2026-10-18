// Worker process entry. BullMQ wiring lives ONLY here (untested by design; the
// handlers it calls are plain functions with their own tests).
import { Queue, Worker } from "bullmq";
// named export: ioredis's default has no construct signature under NodeNext
import { Redis as IORedis } from "ioredis";
import pino from "pino";
import type { SourceId, SourceInfo } from "@retrowatchdog/shared";
import { createDb } from "../db/index.js";
import { buildSourceRuntime, type PluginPacingStore } from "../sources/registry.js";
import { config } from "../config.js";
import {
  runBootCatchUp,
  runCatalogSyncAll,
  runCatalogSyncUnit,
  runTrackedRefresh,
} from "./jobs.js";
import { defaultJobOptions } from "./queueOptions.js";
import { ensureSchedulers, reconcileSchedulers, runPluginHealth } from "./pluginHealth.js";
import type { PriceSourceAdapter } from "../adapters/types.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const QUEUE = "cex-sync";

async function main(): Promise<void> {
  const { db } = createDb(config.DATABASE_URL);
  // Limiters and breakers outlive the per-tick rebuild; otherwise every tick
  // would reset a 30-minute breaker hold to 5 minutes.
  const pluginPacing: PluginPacingStore = new Map();
  // These `let`s are REASSIGNED by the plugin-health tick, so a plugin
  // approved after boot gets scheduled, refreshed and given roles without a
  // restart. Boot needs a migrated DB (compose waits on a healthy api).
  const initialRuntime = await buildSourceRuntime(db, [], pluginPacing);
  let registry: PriceSourceAdapter[] = initialRuntime.adapters;
  let syncAdapters = registry.filter((a) => a.catalogSync);
  let sourceRoles: Record<SourceId, SourceInfo> = initialRuntime.registry.byId;
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  // see queueOptions.ts: finished jobs must release their fixed jobIds
  const queue = new Queue(QUEUE, { connection, defaultJobOptions });

  const worker = new Worker(
    QUEUE,
    async (job) => {
      // Rebuild BEFORE any queue write: a failing DB must throw here rather
      // than hand `reconcileSchedulers` a short list (it removes schedulers).
      if (job.name === "plugin-health") {
        await runPluginHealth(db);
        const runtime = await buildSourceRuntime(db, [], pluginPacing);
        registry = runtime.adapters;
        syncAdapters = registry.filter((a) => a.catalogSync);
        sourceRoles = runtime.registry.byId;
        await reconcileSchedulers(queue, syncAdapters);
        return;
      }
      const adapter = syncAdapters.find((a) => a.source === job.data.source);
      if (!adapter) throw new Error(`unknown sync source ${job.data.source}`);
      if (job.name === "catalog-sync") await runCatalogSyncAll(db, adapter);
      else if (job.name === "catalog-sync-unit") await runCatalogSyncUnit(db, adapter, job.data.unit);
      else if (job.name === "tracked-refresh") await runTrackedRefresh(db, registry, adapter, sourceRoles);
      else throw new Error(`unknown job ${job.name}`);
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => log.error({ job: job?.name, err: err.message }, "job failed"));

  // Registered before the catch-up so it exists even if a catch-up throws.
  // An unconditional upsert is safe for `every` (re-added at the same instant).
  await queue.upsertJobScheduler(
    "plugin-health",
    { every: config.PLUGIN_HEALTH_INTERVAL_MS },
    { name: "plugin-health", data: {} },
  );

  // Schedulers for EVERY catalog source, enabled or not (handlers re-read the
  // setting), so enabling a market needs no restart. Only catch-up is gated.
  await ensureSchedulers(queue, syncAdapters);
  await runBootCatchUp(db, queue, syncAdapters);
}

main().catch((err: unknown) => {
  // a boot failure is logged and exits non-zero; compose restarts it, and the
  // log says why instead of a silent crash loop
  log.error({ err: err instanceof Error ? err.message : String(err) }, "worker failed to start");
  process.exit(1);
});
