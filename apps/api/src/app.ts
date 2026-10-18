import Fastify, { type FastifyInstance } from "fastify";
import { guardRequests, listOf } from "./security/requestGuard.js";
import { healthRoutes } from "./routes/health.js";
import { searchRoutes } from "./routes/search.js";
import { pricesRoutes } from "./routes/prices.js";
import { historyRoutes } from "./routes/history.js";
import { gameSettingsRoutes } from "./routes/gameSettings.js";
import { collectionRoutes } from "./routes/collection.js";
import { collectionImportRoutes } from "./routes/collectionImport.js";
import { watchlistRoutes } from "./routes/watchlist.js";
import { csvExportRoutes } from "./routes/csvExport.js";
import { csvImportRoutes } from "./routes/csvImport.js";
import { fxRoutes } from "./routes/fx.js";
import { signalSettingsRoutes } from "./routes/signalSettings.js";
import { marketRoutes } from "./routes/markets.js";
import { sourceRoutes } from "./routes/sources.js";
import { pluginRoutes } from "./routes/plugins.js";
import { clearInsightsCache, insightsRoutes, warmInsights } from "./routes/insights.js";
import { rowHistoryRoutes } from "./routes/rowHistory.js";
import { getDb, type Db } from "./db/index.js";
import { IgdbClient } from "./catalog/igdb.js";
import type { PriceSourceAdapter } from "./adapters/types.js";
import {
  buildSourceRuntime,
  type PluginPacingStore,
  type SourceRegistry,
} from "./sources/registry.js";
import { defaultFetchPage, type PageFetcher } from "./importers/pricecharting/index.js";
import { config } from "./config.js";

export interface AppDeps {
  db: Db;
  igdb: IgdbClient;
  registry: PriceSourceAdapter[];
  /**
   * Every approved plugin's sources. Replaced, not mutated, by `reloadSources()`,
   * so read it off `app.deps` inside the request, never capture it at module level.
   */
  sources: SourceRegistry;
  /**
   * Rebuild the registry from the `plugins` table (an injected test `registry`
   * is kept). Called after plugin writes, and before the endpoints that report
   * `configured`, because the worker's health tick can change it in the table.
   */
  reloadSources(): Promise<void>;
  /** PriceCharting page fetcher; tests inject a fixture-backed one */
  pcFetchPage: PageFetcher;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildApp(overrides: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "warn" },
    // The CSV import routes accept up to 2,000,000 chars; Fastify's default
    // 1 MiB limit would 413 a large exported collection.
    bodyLimit: 8 * 1024 * 1024,
  });
  // A 5xx body never carries the error's message: drizzle's wraps the failed
  // SQL and its parameters, and Fastify's default handler would send it.
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
      return reply.code(500).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });
  // A 5xx body never carries the error's message: drizzle's wraps the failed
  // SQL and its parameters, and Fastify's default handler would send it.
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
      return reply.code(500).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });
  // A 5xx body never carries the error's message: drizzle's wraps the failed
  // SQL and its parameters, and Fastify's default handler would send it.
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
      return reply.code(500).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });
  const db = overrides.db ?? getDb().db;
  // Building the app reads the database (approved plugins), so a migrated DB
  // is a boot precondition. One pacing store for the process lifetime: a
  // rebuild must not reset a plugin's rate limiter or force its breaker closed.
  const builtinAdapters = overrides.registry ?? [];
  const pluginPacing: PluginPacingStore = new Map();
  // No seeding here: building an app is not deploying one (see server.ts).
  const runtime = await buildSourceRuntime(db, builtinAdapters, pluginPacing);
  const deps: AppDeps = {
    db,
    igdb:
      overrides.igdb ??
      new IgdbClient({ clientId: config.IGDB_CLIENT_ID, secret: config.IGDB_SECRET }),
    registry: overrides.registry ?? runtime.adapters,
    sources: runtime.registry,
    pcFetchPage: overrides.pcFetchPage ?? defaultFetchPage,
    reloadSources: () => {
      // Serialised so the last CALLER wins, not the last to resolve. Both arms
      // are the rebuild so a failure cannot wedge the chain.
      chain = chain.then(rebuild, rebuild);
      return chain;
    },
  };
  const rebuild = async (): Promise<void> => {
    const next = await buildSourceRuntime(db, builtinAdapters, pluginPacing);
    if (!overrides.registry) deps.registry = next.adapters;
    deps.sources = next.registry;
  };
  let chain: Promise<void> = Promise.resolve();
  app.decorate("deps", deps);
  // before every route: no plugin, no rebinding domain, no cross-site write
  guardRequests(app, { publicHosts: listOf(config.PUBLIC_HOST), deniedSubnets: listOf(config.API_DENY_SUBNETS) });
  // any write can change a recommendation or a sparkline: drop the cached bodies and re-warm insights
  app.addHook("onResponse", async (req) => {
    if (req.method === "GET" || req.method === "HEAD") return;
    clearInsightsCache();
    if (process.env.NODE_ENV !== "test") warmInsights(app.deps, app.log);
  });
  await app.register(healthRoutes);
  await app.register(searchRoutes);
  await app.register(pricesRoutes);
  await app.register(historyRoutes);
  await app.register(gameSettingsRoutes);
  await app.register(collectionRoutes);
  await app.register(collectionImportRoutes);
  await app.register(watchlistRoutes);
  await app.register(csvExportRoutes);
  await app.register(csvImportRoutes);
  await app.register(fxRoutes);
  await app.register(marketRoutes);
  await app.register(signalSettingsRoutes);
  await app.register(sourceRoutes);
  await app.register(pluginRoutes);
  await app.register(insightsRoutes);
  await app.register(rowHistoryRoutes);
  return app;
}
