import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  MarketSettingsResponse,
  PluginManifest,
  SourcesResponse,
} from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { buildApp } from "../../src/app.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";
import { runPluginHealth, type PluginProbe } from "../../src/worker/pluginHealth.js";
import { loadEnabledSources } from "../../src/settings/markets.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const manifest = (): PluginManifest => ({
  protocol: 2,
  plugin: { name: "shop", version: "1.0.0" },
  requiredSecrets: ["SHOP_API_KEY"],
  sources: [
    {
      id: "shop_gb",
      kind: "live",
      label: "Shop GB",
      family: "shop",
      familyLabel: "Shop",
      country: "GB",
      reach: "local",
      defaultRegion: "PAL",
      expectedCurrencies: ["GBP"],
      kindRoles: { sell: "buy_store" },
      kindLabels: { sell: "Shop GB sells for" },
    },
  ],
});

/**
 * The whole sequence a user lives when a plugin they imported was missing its
 * key, driven against the real handlers.
 *
 * The two halves of this app do not speak: the WORKER polls each plugin and
 * writes `plugins.last_health`, and the API decides `configured` from that
 * column through a registry it caches. Before these reads rebuilt, a user who
 * gave a plugin its key and restarted that container watched the worker learn
 * it within PLUGIN_HEALTH_INTERVAL_MS and watched Settings -> Markets go on
 * refusing to enable the source — not for five minutes, but until the API
 * process restarted or some plugin happened to be approved, disabled or
 * deleted.
 *
 * So the health row here is written the way the worker writes it — by calling
 * the worker's own pass with a probe that answers — and NOTHING tells the API.
 * No `reloadSources()` is called anywhere in these tests: if the endpoints did
 * not rebuild, every assertion after the worker's tick would still be reading
 * the registry this app booted with.
 */
describe.skipIf(ctx === null)("a plugin the WORKER learns is configured", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  /** A probe that answers for every plugin, with the health the test wants. */
  const probe = (configured: boolean): PluginProbe => ({
    health: async () => ({ status: "ok", protocol: 2, configured }),
    manifest: async () => manifest(),
  });

  /**
   * Import and approve one plugin whose container is NOT yet configured: it
   * answered /health at import and said so, which is the state a user reaches
   * by importing before setting the secret.
   */
  const approvedButUnconfigured = async (): Promise<number> => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: false },
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    expect(await approvePlugin(ctx!.db, row.id, { shop_gb: ["sell"] }, reviewed)).toEqual({
      ok: true,
    });
    return row.id;
  };

  const markets = async (
    app: Awaited<ReturnType<typeof buildApp>>,
  ): Promise<MarketSettingsResponse> => {
    const res = await app.inject({ method: "GET", url: "/api/settings/markets" });
    expect(res.statusCode).toBe(200);
    return res.json() as MarketSettingsResponse;
  };

  it("becomes enableable in Settings without a restart of the API", async () => {
    const app = await buildApp({ db: ctx!.db, registry: [stubAdapter({ source: "cex" })] });
    await approvedButUnconfigured();

    // The cached registry has not moved: nothing in this test has told the API
    // anything, which is exactly the position it is in on a real deployment
    // while the worker is doing the learning.
    expect(app.deps.sources.has("shop_gb")).toBe(false);

    // ...and the read rebuilds, so the screen already knows the source exists
    // and knows, honestly, that it cannot answer yet
    const offered = (await markets(app)).available.find((m) => m.source === "shop_gb");
    expect(offered).toEqual({
      source: "shop_gb",
      label: "Shop GB",
      family: "shop",
      country: "GB",
      configured: false,
    });

    // enabling it now is refused, and the refusal names it
    const tooEarly = await app.inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "shop_gb"] },
    });
    expect(tooEarly.statusCode).toBe(400);
    expect((tooEarly.json() as { error: string }).error).toContain("shop_gb");

    // The user gives the container its key and restarts it; the worker's next
    // tick asks and writes the row. This is the worker's own pass, against the
    // same database, with the API told nothing at all.
    await runPluginHealth(ctx!.db, probe(true));

    const after = (await markets(app)).available.find((m) => m.source === "shop_gb");
    expect(after?.configured).toBe(true);

    // and the PUT beside it accepts what that screen now offers
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "shop_gb"] },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as MarketSettingsResponse).enabled).toEqual(["shop_gb", "cex"]);
    expect([...(await loadEnabledSources(ctx!.db))]).toEqual(["shop_gb", "cex"]);
    await app.close();
  });

  it("says the same thing through GET /api/sources", async () => {
    // The other endpoint that reports `configured`. The web will describe a
    // plugin source from this list, so an answer that lags the table here is
    // the same lie told in a different place.
    const app = await buildApp({ db: ctx!.db, registry: [stubAdapter({ source: "cex" })] });
    await approvedButUnconfigured();

    const before = await app.inject({ method: "GET", url: "/api/sources" });
    expect(before.statusCode).toBe(200);
    expect(
      (before.json() as SourcesResponse).sources.find((s) => s.id === "shop_gb")?.configured,
    ).toBe(false);

    await runPluginHealth(ctx!.db, probe(true));

    const after = await app.inject({ method: "GET", url: "/api/sources" });
    expect(after.statusCode).toBe(200);
    const shop = (after.json() as SourcesResponse).sources.find((s) => s.id === "shop_gb");
    expect(shop).toMatchObject({ configured: true, origin: "plugin", label: "Shop GB" });
    await app.close();
  });

  it("goes back to unconfigured when the worker learns the plugin lost its key", async () => {
    // The freshness is not one-way. A container redeployed without its secret
    // answers /health saying so, and the screen must stop offering to enable
    // it rather than keeping the last cheerful answer it happened to cache.
    const app = await buildApp({ db: ctx!.db, registry: [stubAdapter({ source: "cex" })] });
    await approvedButUnconfigured();
    await runPluginHealth(ctx!.db, probe(true));
    expect((await markets(app)).available.find((m) => m.source === "shop_gb")?.configured).toBe(
      true,
    );

    await runPluginHealth(ctx!.db, probe(false));
    expect((await markets(app)).available.find((m) => m.source === "shop_gb")?.configured).toBe(
      false,
    );
    await app.close();
  });

  it("keeps a test's injected adapters across the rebuild these reads do", async () => {
    // The seam every route test depends on: an injected adapter list is that
    // test's fixture, and a rebuild — now reachable from a plain GET, not only
    // from approve/disable/delete — must not swap it for the real adapters,
    // which on this machine would mean real credentials deciding what a test
    // asserts.
    const injected = [stubAdapter({ source: "shop_zz" })];
    const app = await buildApp({ db: ctx!.db, registry: injected });
    await markets(app);
    await app.inject({ method: "GET", url: "/api/sources" });
    expect(app.deps.registry).toBe(injected);
    // ...and the rebuild did not turn that fixture into a MARKET: the registry
    // is approved manifests only, and an injected adapter is not one.
    expect(app.deps.sources.get("shop_zz")).toBeUndefined();
    await app.close();
  });
});
