import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  CollectionResponse,
  PluginManifest,
  PricesResponse,
  ValueBasis,
} from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";
import { games, ownedCopies, pricePoints } from "../../src/db/schema.js";
import { saveEnabledSources } from "../../src/settings/markets.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

/**
 * One approved plugin shop in the user's own country, declaring a store price,
 * a payout and a market median.
 *
 * The country matters as much as the roles: the collection's markets gate asks
 * which country a source is in, and it asks the SOURCE REGISTRY. A source
 * declaring `GB` here is a source a UK collection may be valued from.
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
      kindRoles: { sell: "buy_store", cash: "bid", active_median: "reference" },
      kindLabels: {
        sell: "Shop GB sells for",
        cash: "Shop GB pays cash",
        active_median: "Shop GB median",
      },
    },
  ],
});

const fetchedAt = new Date("2026-09-04T09:00:00Z");

describe.skipIf(ctx === null)("an approval narrows what a plugin source may claim", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  /** Import once and report it healthy, so its source counts as configured. */
  const importPlugin = async (): Promise<number> => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    return row.id;
  };

  /** Approve exactly the document the row holds, granting these kinds. */
  const approve = async (id: number, kinds: string[]): Promise<void> => {
    const reviewed = (await getPlugin(ctx!.db, id))!.manifestSeen!;
    expect(
      await approvePlugin(
        ctx!.db,
        id,
        { shop_gb: kinds } as Parameters<typeof approvePlugin>[2],
        reviewed,
      ),
    ).toEqual({ ok: true });
  };

  /**
   * A PAL/loose batch from the plugin: a store price, a payout, and a median
   * over nine listings (above the default SIGNAL_MIN_SAMPLE of 5, so it can
   * anchor a market value). One `fetchedAt`, so it is one stored batch.
   */
  const seedGame = async (): Promise<number> => {
    const [game] = await ctx!.db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    await ctx!.db.insert(pricePoints).values([
      {
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "loose",
        kind: "sell", priceUsd: "45.00", priceOriginal: "45.00",
        currencyOriginal: "GBP", available: true, fetchedAt,
      },
      {
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "loose",
        kind: "cash", priceUsd: "20.00", priceOriginal: "20.00",
        currencyOriginal: "GBP", available: true, fetchedAt,
      },
      {
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "loose",
        kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00",
        currencyOriginal: "GBP", sampleSize: 9, fetchedAt,
      },
    ]);
    // the plugin's source is the only market this deployment reads
    await saveEnabledSources(ctx!.db, ["shop_gb"]);
    return game.id;
  };

  // No `registry` override: the app builds the real adapters plus the
  // plugin's, which is what puts `shop_gb` in the list the routes walk to load
  // its stored points. Nothing is ever fetched — the game carries a
  // `cached_only` override where it matters, and the collection route never
  // fetches at all.
  const app = async () => buildApp({ db: ctx!.db });

  const kindsOnScreen = async (gameId: number): Promise<string[]> => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: `/api/games/${gameId}/prices` });
    await a.close();
    expect(res.statusCode).toBe(200);
    const body = res.json() as PricesResponse;
    expect(body.sources.map((b) => b.source)).toEqual(["shop_gb"]);
    return body.sources[0].points.map((p) => p.kind).sort();
  };

  it("stops serving a stored row of a kind the user has since unticked", async () => {
    // A ROW OUTLIVES AN APPROVAL. The `cash` row was written while `cash` was
    // approved and stays in `price_points` for good, so re-approving without
    // it has to stop the row being READ — otherwise the price table goes on
    // rendering "Shop GB pays cash" for a role the user revoked. The sync path
    // has always done this (`PluginCatalogAdapter.toListing`); this is the
    // live path agreeing with it.
    const id = await importPlugin();
    await approve(id, ["sell", "cash", "active_median"]);
    const gameId = await seedGame();
    // per-title override, so the route serves the stored batch and touches no
    // external service (this plugin's base URL does not resolve)
    await ctx!.db.execute(`UPDATE games SET price_mode = 'cached_only' WHERE id = ${gameId}`);

    expect(await kindsOnScreen(gameId)).toEqual(["active_median", "cash", "sell"]);

    await approve(id, ["sell", "active_median"]);
    expect(await kindsOnScreen(gameId)).toEqual(["active_median", "sell"]);
  });

  it("values an owned copy from a plugin source in the collection's own country", async () => {
    // `estimateCopyValue` must ask this deployment's registry two questions
    // about a plugin source: which country it is in (the markets gate) and
    // what role each of its kinds plays. Asked anywhere else, every point
    // arrives role-less and the source never values an owned copy.
    const id = await importPlugin();
    await approve(id, ["sell", "cash", "active_median"]);
    const gameId = await seedGame();
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "loose" });

    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: "/api/collection?valuation=market&country=GB",
    });
    await a.close();
    expect(res.statusCode).toBe(200);

    const item = (res.json() as CollectionResponse).items[0];
    expect(item.estimatedValueUsd).toBe(30);
    expect(item.valueBasis).toEqual({
      readAs: "reading",
      source: "shop_gb",
      priceKind: "active_median",
      viaUnknownCondition: false,
      viaUnknownRegion: false,
    });
  });

  it("stops blaming the valuation markets for a copy it cannot value for another reason", async () => {
    // The explanation is derived from the same lookup as the value, so it used
    // to assert a cause the setting could not change: the copy had no value
    // because the source was role-less to the compiled manifest, and the
    // screen said "outside your valuation markets" about a GB source in a GB
    // collection. Here the ONLY reading is a payout, which the `market` basis
    // does not read and the `replacement` basis refuses to fall through to —
    // so the copy has no value, and the reason is not the markets gate.
    const id = await importPlugin();
    await approve(id, ["cash"]);
    const gameId = await seedGame();
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "loose" });

    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: "/api/collection?valuation=replacement&country=GB",
    });
    await a.close();
    expect(res.statusCode).toBe(200);

    const item = (res.json() as CollectionResponse).items[0];
    expect(item.estimatedValueUsd).toBeNull();
    const excluded = item.valueBasis as ValueBasis | null;
    expect(excluded === null || excluded.readAs !== "excluded").toBe(true);
  });
});
