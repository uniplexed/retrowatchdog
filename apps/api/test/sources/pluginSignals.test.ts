import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  CollectionResponse,
  PluginManifest,
  PricesResponse,
  Signal,
  WatchlistResponse,
} from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";
import { games, ownedCopies, pricePoints, watchlist } from "../../src/db/schema.js";
import { saveEnabledSources } from "../../src/settings/markets.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

/**
 * One approved plugin source with a reference and a buy_listing role, and one
 * cheap listing under its own median.
 *
 * The point of the fixture is that EVERY price in it belongs to the plugin: the
 * roles that make this bark exist only in the manifest the user approved, so
 * if a route computes signals against anything but this deployment's
 * registry, both points are role-less, every rule ignores them, and the
 * response carries no signal at all — no error, no empty block, just silence
 * for a market the user approved and enabled.
 *
 * So each test here fails if its route stops passing `app.deps.sources.byId`
 * to `buildSignalInputs`/`computeSignals`.
 */
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
      kindRoles: { active_median: "reference", active_listing: "buy_listing" },
      kindLabels: { active_median: "Shop GB median", active_listing: "Shop GB listing" },
    },
  ],
});

const fetchedAt = new Date("2026-09-04T09:00:00Z");

describe.skipIf(ctx === null)("an approved plugin's roles reach the signal engine", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  /** Import, approve both kinds, and report it healthy so it counts as configured. */
  const approvedPlugin = async (): Promise<number> => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    expect(
      await approvePlugin(ctx!.db, row.id, { shop_gb: ["active_median", "active_listing"] }, reviewed),
    ).toEqual({ ok: true });
    return row.id;
  };

  /**
   * A PAL/loose median of £30 over nine listings, and a £19 listing under it —
   * below the 0.7 underpriced factor, so rule 1 fires on the listing against
   * the reference. Both rows share one `fetchedAt` so they are one stored
   * batch.
   */
  const seedGame = async (): Promise<number> => {
    const [game] = await ctx!.db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    await ctx!.db.insert(pricePoints).values([
      {
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "loose",
        kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00",
        currencyOriginal: "GBP", sampleSize: 9, fetchedAt,
      },
      {
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "loose",
        kind: "active_listing", priceUsd: "19.00", priceOriginal: "19.00",
        currencyOriginal: "GBP", listingTitle: "Super Metroid cart only",
        sourceUrl: "https://shop.example/1", fetchedAt,
      },
    ]);
    await approvedPlugin();
    // the plugin's source is the only market this deployment reads
    await saveEnabledSources(ctx!.db, ["shop_gb"]);
    return game.id;
  };

  // No `registry` override: the app builds the real adapters plus the plugin's,
  // which is what puts `shop_gb` in the list the routes walk to load its stored
  // points. Nothing is ever fetched — every test here reads stored rows only.
  const app = async () => buildApp({ db: ctx!.db });

  const underpriced = (signals: Signal[]): Signal | undefined =>
    signals.find((s) => s.type === "UNDERPRICED");

  it("barks UNDERPRICED on the watchlist for a plugin source", async () => {
    const gameId = await seedGame();
    await ctx!.db.insert(watchlist).values({ gameId, region: "PAL", condition: "loose" });

    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/watchlist" });
    await a.close();
    expect(res.statusCode).toBe(200);

    const item = (res.json() as WatchlistResponse).items[0];
    const bark = underpriced(item.signals);
    expect(bark).toBeDefined();
    // the source id, the plugin's own
    // label from the approved manifest, and the amounts in the currency the
    // comparison happened in
    expect(bark?.source).toBe("shop_gb");
    expect(bark?.reasoning).toContain("Shop GB");
    expect(bark?.reasoning).toContain("£19");
    expect(bark?.reasoning).toContain("£30");
    expect(bark?.url).toBe("https://shop.example/1");
  });

  it("barks UNDERPRICED on an owned copy for a plugin source", async () => {
    const gameId = await seedGame();
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "loose" });

    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/collection" });
    await a.close();
    expect(res.statusCode).toBe(200);

    const item = (res.json() as CollectionResponse).items[0];
    const bark = underpriced(item.signals);
    expect(bark).toBeDefined();
    expect(bark?.source).toBe("shop_gb");
    expect(bark?.reasoning).toContain("Shop GB");
  });

  it("barks UNDERPRICED on the game screen for a plugin source", async () => {
    const gameId = await seedGame();
    // per-title override, so the route serves the stored batch and touches no
    // external service (this plugin's base URL does not resolve)
    await ctx!.db.execute(`UPDATE games SET price_mode = 'cached_only' WHERE id = ${gameId}`);

    const a = await app();
    const res = await a.inject({ method: "GET", url: `/api/games/${gameId}/prices` });
    await a.close();
    expect(res.statusCode).toBe(200);

    const body = res.json() as PricesResponse;
    // the block is there, which is the precondition for the signal
    expect(body.sources.map((b) => b.source)).toEqual(["shop_gb"]);
    const bark = underpriced(body.signals);
    expect(bark).toBeDefined();
    expect(bark?.source).toBe("shop_gb");
    expect(bark?.reasoning).toContain("Shop GB");
  });
});
