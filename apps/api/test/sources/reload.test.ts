import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MarketSettingsResponse, PluginManifest } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { buildApp } from "../../src/app.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const manifest = (): PluginManifest => ({
  protocol: 2,
  plugin: { name: "shop", version: "1.0.0" },
  requiredSecrets: [],
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
 * `deps.reloadSources()` REPLACES what `deps.sources` holds, so a module that
 * read the registry once — at import, or at route registration — would keep
 * serving the set this process booted with until the container was recreated.
 *
 * Nothing in the app does that today (every reader destructures `app.deps`
 * inside its handler), and the point of this file is that nothing starts to:
 * approving a plugin between two identical requests is the only way to see
 * the difference, and no test that approves a plugin before building the app
 * ever would.
 */
describe.skipIf(ctx === null)("a registry rebuilt while the app is running", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  const markets = async (
    app: Awaited<ReturnType<typeof buildApp>>,
  ): Promise<MarketSettingsResponse> => {
    const res = await app.inject({ method: "GET", url: "/api/settings/markets" });
    expect(res.statusCode).toBe(200);
    return res.json() as MarketSettingsResponse;
  };

  /**
   * Import and approve one plugin, one source, one kind. `approvedKinds` is a
   * parameter because "approved with nothing checked" is a state of its own,
   * and the difference is what one test below is about.
   */
  const approvedPlugin = async (approvedKinds: string[] = ["sell"]): Promise<number> => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    const approved = await approvePlugin(
      ctx!.db,
      row.id,
      { shop_gb: approvedKinds } as Parameters<typeof approvePlugin>[2],
      reviewed,
    );
    expect(approved).toEqual({ ok: true });
    return row.id;
  };

  it("serves the new source to the very next request, from the same app instance", async () => {
    const app = await buildApp({ db: ctx!.db, registry: [stubAdapter({ source: "cex" })] });

    const before = await markets(app);
    expect(before.available.map((m) => m.source)).not.toContain("shop_gb");

    await approvedPlugin();

    // The CACHED registry still holds the boot-time set until something
    // rebuilds it. Asserted on `deps.sources` rather than through the Markets
    // route, which is no longer a way to observe staleness: that endpoint
    // rebuilds before it answers, because the WORKER can change what
    // `configured` means without this process hearing about it
    // (routes/markets.ts). What is under test here is the replacement itself.
    expect(app.deps.sources.has("shop_gb")).toBe(false);

    await app.deps.reloadSources();

    const after = await markets(app);
    expect(after.available.map((m) => m.source)).toContain("shop_gb");
    expect(after.available.find((m) => m.source === "shop_gb")).toEqual({
      source: "shop_gb",
      label: "Shop GB",
      family: "shop",
      country: "GB",
      configured: true,
    });
    // and it can now be enabled, which is what being in the registry is FOR
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "shop_gb"] },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as MarketSettingsResponse).enabled).toEqual(["shop_gb", "cex"]);
  });

  it("rebuilds a plugin's adapter but NOT the limiter and breaker it is held to", async () => {
    /**
     * The conservative half of the rebuild, and the reason it is worth a test
     * of identity rather than of contents: the state that protects this
     * deployment must survive a rebuild. A circuit breaker may be OPEN because
     * that source is failing right now, and a rate limiter carries a schedule;
     * constructing fresh ones on every rebuild would force a tripped breaker
     * closed, so approving a plugin in Settings would silently undo the
     * protection a breaker had just tripped to provide — at the exact moment
     * the app starts making more calls.
     *
     * The rule lives on the plugin side: the adapter object IS rebuilt, because
     * its manifest, approved kinds and base URL are what changed, while its
     * limiter and breaker are looked up in the app's `PluginPacingStore` and
     * outlive it.
     *
     * No `registry` override here: this needs the adapters the app builds for
     * itself, since an injected list is never replaced at all.
     */
    const app = await buildApp({ db: ctx!.db });
    await approvedPlugin();
    await app.deps.reloadSources();
    const first = app.deps.registry.find((a) => a.source === "shop_gb") as
      | { limiter: unknown; breaker: unknown }
      | undefined;
    expect(first).toBeDefined();

    await app.deps.reloadSources();
    const second = app.deps.registry.find((a) => a.source === "shop_gb") as
      | { limiter: unknown; breaker: unknown }
      | undefined;
    // a NEW adapter object, which is the point of rebuilding...
    expect(second).not.toBe(first);
    // ...holding the SAME limiter and the SAME breaker, which is the point of
    // not rebuilding those.
    expect(second!.limiter).toBe(first!.limiter);
    expect(second!.breaker).toBe(first!.breaker);
  });

  it("keeps a test's injected adapters across a rebuild", async () => {
    // An injected adapter list is that test's fixture. A rebuild refreshes the
    // SOURCES it describes, and must not quietly swap the fixture for the real
    // adapters — which on this machine would mean real credentials deciding
    // what a test asserts.
    const injected = [stubAdapter({ source: "shop_zz" })];
    const app = await buildApp({ db: ctx!.db, registry: injected });
    await app.deps.reloadSources();
    expect(app.deps.registry).toBe(injected);
    // ...and the rebuild did not turn that fixture into a MARKET either: the
    // registry is approved manifests only, and an injected adapter is not one.
    expect(app.deps.sources.get("shop_zz")).toBeUndefined();
  });

  it("neither offers nor enables a source approved with no kinds", async () => {
    // The user approved the plugin and checked nothing for this source. It
    // can answer no kind, so it is not a market this deployment has: the
    // Markets screen is not offered it, and a client naming it anyway is
    // refused rather than being sold a market that would be silently empty
    // forever.
    const app = await buildApp({ db: ctx!.db, registry: [stubAdapter({ source: "cex" })] });
    await approvedPlugin([]);
    await app.deps.reloadSources();

    expect((await markets(app)).available.map((m) => m.source)).not.toContain("shop_gb");
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "shop_gb"] },
    });
    expect(put.statusCode).toBe(400);
    expect((put.json() as { error: string }).error).toContain("shop_gb");
  });
});
