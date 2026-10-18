import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, gameNames, pricePoints, sourceMappings } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import type { PluginManifest, PricesResponse } from "@retrowatchdog/shared";
import type { PriceSourceAdapter, RawListing } from "../../src/adapters/types.js";
import type { NormalizedListing } from "../../src/adapters/types.js";
import { classifyCatalogListing } from "../../src/adapters/classifyListing.js";
import { classifyListing } from "../../src/adapters/classifyListing.js";
import type { IgdbClient } from "../../src/catalog/igdb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

/**
 * What the deleted `normalizeCexListing` was: the shared catalogue reading with
 * CeX's own declared region. The CeX shops declare PAL in the plugin manifest.
 */
const normalizeCexListing = (raw: RawListing): NormalizedListing =>
  classifyCatalogListing(raw, "PAL");


const igdbStub = { isConfigured: () => false, searchGames: async () => [] } as unknown as IgdbClient;

async function seedGameWithMapping(
  db: Db, title: string, platform: string, source: string, sourceProductId: string,
): Promise<number> {
  const [g] = await db.insert(games).values({ title, platform }).returning({ id: games.id });
  await db.insert(gameNames).values({ gameId: g.id, name: title });
  await db.insert(sourceMappings).values({
    gameId: g.id, source, sourceProductId, sourceTitle: title, matchScore: 1, status: "confirmed",
  });
  return g.id;
}

const cexAdapter = (listings: RawListing[]): PriceSourceAdapter =>
  stubAdapter({ source: "cex", search: async () => listings, normalize: normalizeCexListing });
/**
 * A median-of-listings market, standing in for eBay UK. It normalizes with the
 * SHARED classifier — what eBay's own normalize() runs, and the whole of what a
 * plugin adapter's normalize() is — so what these route tests exercise is the
 * pricing path, not one adapter's wrapper.
 *
 * Not EVERY adapter, deliberately: the CeX stub five lines above normalizes
 * with `normalizeCexListing`, because CeX rows carry a category the title does
 * not, and PriceCharting's normalize() sets its own fields without the
 * classifier at all. Two readings is the point — the pricing path must not care
 * which one produced a listing.
 */
const ebayAdapter = (listings: RawListing[]): PriceSourceAdapter =>
  stubAdapter({
    source: "ebay_uk",
    snapshotStrategy: "median_of_listings",
    // eBay's own roles -- medianPointsFrom reads this to find the
    // buy_listing-role price and the kind to write both aggregate halves
    // under (task 4), in place of the hardcoded eBay-only literals.
    kindRoles: { active_median: "reference", active_listing: "buy_listing" },
    search: async () => listings,
    normalize: classifyListing,
  });

describe("GET /api/games/:id/prices", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let zeldaId: number;

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(db);
    // This suite's `ebayAdapter` stub answers under "ebay_uk", and
    // app.deps.sources — read by this route to resolve a source's ROLE for the
    // signal engine — is built from the `plugins` table alone, never from the
    // adapters a test injects. Without a real row "ebay_uk" has no role.
    await seedEbayPlugin(db);
    const [g] = await db
      .insert(games)
      .values({ igdbId: 1029, title: "The Legend of Zelda: Ocarina of Time", platform: "n64", year: 1998 })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: g.id, name: "The Legend of Zelda: Ocarina of Time" });
    zeldaId = g.id;
  });
  afterAll(async () => await pool.end());

  const cexListings: RawListing[] = [
    {
      sourceProductId: "box-1",
      title: "Legend Of Zelda Ocarina Of Time, Boxed",
      categoryText: "Nintendo N64 Games",
      url: null,
      prices: [
        { kind: "sell", amount: 60, currency: "GBP" },
        { kind: "cash", amount: 30, currency: "GBP" },
        { kind: "voucher", amount: 45, currency: "GBP" },
      ],
    },
  ];
  const ebayListings: RawListing[] = ["e1:38", "e2:40", "e3:42", "e4:44", "e5:46"].map((pair) => {
    const [id, amount] = pair.split(":");
    return {
      sourceProductId: id,
      title: "Zelda Ocarina of Time N64 PAL boxed complete",
      url: `https://www.ebay.co.uk/itm/${id}`,
      prices: [{ kind: "active_listing" as const, amount: Number(amount), currency: "GBP" }],
    };
  });

  it("returns game, per-source blocks and computed signals", async () => {
    const app = await buildApp({
      db, igdb: igdbStub,
      registry: [cexAdapter(cexListings), ebayAdapter(ebayListings)],
    });
    const res = await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PricesResponse;
    expect(body.game.id).toBe(zeldaId);
    expect(body.sources.map((s) => s.source)).toEqual(["cex", "ebay_uk"]);
    const ebayBlock = body.sources.find((s) => s.source === "ebay_uk");
    expect(ebayBlock?.cheapestListings?.length).toBeGreaterThan(0);
    // CeX declares no buy_listing role at all (its roles are sell: buy_store,
    // cash: bid, voucher: bid), so its block must carry no strip. Proves
    // exclusion by role, not just inclusion: without the role predicate the
    // grade gate alone would let this "sell" row through as a false strip.
    const cexBlock = body.sources.find((s) => s.source === "cex");
    expect(cexBlock?.cheapestListings).toBeUndefined();
    // cex sell 60 vs PAL/cib median 42 -> 60 > 42*1.3 = 54.6 -> OVERPRICED_STORE
    expect(body.signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(true);
    await app.close();
  });

  it("signalCondition scopes the signals to one condition", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [cexAdapter(cexListings), ebayAdapter(ebayListings)] });
    const cib = (await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices?signalCondition=cib` })).json() as PricesResponse;
    const loose = (await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices?signalCondition=loose` })).json() as PricesResponse;
    await app.close();
    expect(cib.signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(true);
    // every price here is a boxed copy: nothing about a loose cart can be said
    expect(loose.signals.filter((s) => s.type !== "INSUFFICIENT_DATA")).toEqual([]);
    // the display is untouched by the signal scope
    expect(loose.sources.find((b) => b.source === "ebay_uk")?.points.length).toBe(cib.sources.find((b) => b.source === "ebay_uk")?.points.length);
  });

  it("signalRegion scopes the signals without filtering the display", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [cexAdapter(cexListings), ebayAdapter(ebayListings)] });
    const pal = (await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices?signalRegion=PAL` })).json() as PricesResponse;
    const ntscJ = (await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices?signalRegion=NTSC_J` })).json() as PricesResponse;
    await app.close();
    expect(pal.signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(true);
    expect(ntscJ.signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(false);
    expect(ntscJ.sources.find((b) => b.source === "cex")?.points.length).toBe(pal.sources.find((b) => b.source === "cex")?.points.length);
  });

  it("an unknown signalCondition is a 400", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [cexAdapter(cexListings), ebayAdapter(ebayListings)] });
    const res = await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices?signalCondition=mint` });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("filters points by region when requested", async () => {
    const app = await buildApp({
      db, igdb: igdbStub,
      registry: [cexAdapter(cexListings), ebayAdapter(ebayListings)],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${zeldaId}/prices?region=NTSC_J`,
    });
    const body = res.json() as PricesResponse;
    expect(body.sources.every((s) => s.points.length === 0)).toBe(true);
    await app.close();
  });

  it("falls back to undeclared-region eBay medians when filtering by region (finding 4)", async () => {
    // eBay titles carry no region keyword at all -> regionGuess "unknown".
    // Their median must still feed the PAL signal via the spec-9 fallback,
    // even though the request filters to region=PAL.
    const undeclaredRegionEbayListings: RawListing[] = ["e1:38", "e2:40", "e3:42", "e4:44", "e5:46"].map(
      (pair) => {
        const [id, amount] = pair.split(":");
        return {
          sourceProductId: id,
          title: "Zelda Ocarina of Time N64 boxed complete",
          url: `https://www.ebay.co.uk/itm/${id}`,
          prices: [{ kind: "active_listing" as const, amount: Number(amount), currency: "GBP" }],
        };
      },
    );
    const app = await buildApp({
      db, igdb: igdbStub,
      registry: [cexAdapter(cexListings), ebayAdapter(undeclaredRegionEbayListings)],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${zeldaId}/prices?region=PAL`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PricesResponse;
    // cex sell 60 vs undeclared-region PAL/cib median 42 -> 60 > 42*1.3 = 54.6
    const overpriced = body.signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(overpriced).toBeDefined();
    expect(overpriced?.reasoning).toContain("undeclared region");
    await app.close();
  });

  it("threads the eBay listing url through onto the UNDERPRICED signal", async () => {
    const cheapUrl = "https://www.ebay.co.uk/itm/bargain1";
    const underpricedListings: RawListing[] = ["e1:40", "e2:42", "e3:44", "e4:46", "e5:8"].map((pair) => {
      const [id, amount] = pair.split(":");
      return {
        sourceProductId: id,
        title: "Zelda Ocarina of Time N64 PAL boxed complete",
        url: id === "e5" ? cheapUrl : `https://www.ebay.co.uk/itm/${id}`,
        prices: [{ kind: "active_listing" as const, amount: Number(amount), currency: "GBP" }],
      };
    });
    const app = await buildApp({ db, igdb: igdbStub, registry: [ebayAdapter(underpricedListings)] });
    const res = await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices` });
    const body = res.json() as PricesResponse;
    const under = body.signals.find((s) => s.type === "UNDERPRICED");
    expect(under).toBeDefined();
    expect(under?.url).toBe(cheapUrl);
    await app.close();
  });

  it("leaves the UNDERPRICED signal url undefined when the underlying listing carries none", async () => {
    const underpricedListingsNoUrl: RawListing[] = ["e1:40", "e2:42", "e3:44", "e4:46", "e5:8"].map((pair) => {
      const [id, amount] = pair.split(":");
      return {
        sourceProductId: id,
        title: "Zelda Ocarina of Time N64 PAL boxed complete",
        url: id === "e5" ? null : `https://www.ebay.co.uk/itm/${id}`,
        prices: [{ kind: "active_listing" as const, amount: Number(amount), currency: "GBP" }],
      };
    });
    const app = await buildApp({ db, igdb: igdbStub, registry: [ebayAdapter(underpricedListingsNoUrl)] });
    const res = await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices` });
    const body = res.json() as PricesResponse;
    const under = body.signals.find((s) => s.type === "UNDERPRICED");
    expect(under).toBeDefined();
    expect(under?.url).toBeUndefined();
    await app.close();
  });

  it("attaches cheapestListings to any source that produced active_listing points", async () => {
    // a per_listing ebay_uk-id adapter that emits an active_listing row.
    // Sourced onto ebay_uk rather than cex: cex's declaration has no
    // role for active_listing, so a row of that kind stored under "cex" is
    // narrowed away on read-back (the same rule this file's "serves only the
    // kinds..." test proves); ebay_uk declares active_listing: buy_listing
    // (seedEbayPlugin, from this suite's beforeEach), so it survives.
    const adapter = stubAdapter({
      source: "ebay_uk",
      search: async () => [{
        sourceProductId: "cl1", title: "Chrono Trigger cart",
        prices: [{ kind: "active_listing" as const, amount: 80, currency: "GBP" }], url: "https://example.test/cl1",
      }],
      normalize: (raw) => ({ ...raw, cleanTitle: "chrono trigger", platformGuess: "snes", regionGuess: "PAL", conditionGuess: "loose" }),
    });
    const gameId = await seedGameWithMapping(db, "Chrono Trigger", "snes", "ebay_uk", "cl1");
    const app = await buildApp({ db, registry: [adapter] });
    const res = await app.inject({ method: "GET", url: `/api/games/${gameId}/prices?refresh=true` });
    const body = res.json();
    const block = body.sources.find((s: { source: string }) => s.source === "ebay_uk");
    expect(block.cheapestListings).toHaveLength(1);
    await app.close();
  });

  it("keeps a faulty listing out of cheapestListings while leaving it in the table", async () => {
    // The strip renders a bare amount — no title, no condition, no grade — so
    // a "spares or repairs" price there reads as a market offer. The median
    // path already excluded fair/poor from it for exactly that reason, but it
    // did so inside medianPointsFrom, and a per-listing marketplace (the
    // shape every sidecar source takes) never goes through that. The row
    // itself stays in `points`, where it is rendered with its title and its
    // grade beside it.
    // Sourced onto ebay_uk, not cex, for the same reason as the test above:
    // cex declares no role for active_listing, so these rows would be
    // narrowed away on read-back under that id.
    const adapter = stubAdapter({
      source: "ebay_uk",
      search: async () => [
        {
          sourceProductId: "faulty", title: "Chrono Trigger cart FAULTY spares or repairs",
          prices: [{ kind: "active_listing" as const, amount: 6, currency: "GBP" }], url: "https://example.test/faulty",
        },
        {
          sourceProductId: "good", title: "Chrono Trigger cart",
          prices: [{ kind: "active_listing" as const, amount: 80, currency: "GBP" }], url: "https://example.test/good",
        },
      ],
      normalize: (raw) => ({
        ...raw,
        cleanTitle: "chrono trigger",
        platformGuess: "snes",
        regionGuess: "PAL",
        conditionGuess: "loose",
        gradeGuess: raw.sourceProductId === "faulty" ? "poor" : null,
      }),
    });
    const gameId = await seedGameWithMapping(db, "Chrono Trigger", "snes", "ebay_uk", "faulty");
    await db.insert(sourceMappings).values({
      gameId, source: "ebay_uk", sourceProductId: "good", sourceTitle: "Chrono Trigger cart",
      matchScore: 1, status: "confirmed",
    });
    const app = await buildApp({ db, registry: [adapter] });
    const res = await app.inject({ method: "GET", url: `/api/games/${gameId}/prices?refresh=true` });
    const body = res.json();
    const block = body.sources.find((s: { source: string }) => s.source === "ebay_uk");

    expect(block.points).toHaveLength(2);
    expect(block.cheapestListings).toHaveLength(1);
    expect(block.cheapestListings[0].priceUsd).toBe(80);
    expect(block.cheapestListings[0].grade).toBeNull();
    await app.close();
  });

  it("gives the strip to a source whose buy_listing role sits on another kind", async () => {
    // The strip is a role, not a word. A shop plugin that calls its listings
    // `sell` and declares `sell: buy_listing` earns the same strip eBay does.
    //
    // No `seedEbayPlugin`-style helper exists for an arbitrary role
    // declaration, so this mirrors `test/sources/pluginApprovalNarrowing.test.ts`'s
    // own idiom directly: import a plugin manifest, approve it for the kinds
    // that manifest declares, then seed price_points straight into the table
    // (there is no `seedPoints` helper anywhere in the repo).
    const manifest: PluginManifest = {
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
          kindRoles: { sell: "buy_listing" },
          kindLabels: { sell: "Shop GB sells for" },
        },
      ],
    };
    const pluginRow = await insertPlugin(db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest,
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    const reviewed = (await getPlugin(db, pluginRow.id))!.manifestSeen!;
    const approval = await approvePlugin(db, pluginRow.id, { shop_gb: ["sell"] }, reviewed);
    expect(approval).toEqual({ ok: true });
    // shop_gb is not in the "cex,ebay_uk" default seed (config.ENABLED_SOURCES),
    // so without this the route's activeRegistry filter drops its adapter and
    // no block is produced at all, whatever the stored rows say.
    await saveEnabledSources(db, ["shop_gb"]);
    // per-title override, so the route serves the stored batch and never
    // attempts a live fetch to "http://shop:8000" — a base URL nothing
    // answers at. This test stays offline today only because PRICE_MODE
    // defaults to cached_auto and the row below is TTL-fresh; the override
    // makes that independent of whatever the environment sets PRICE_MODE to
    // (the same idiom as test/sources/pluginApprovalNarrowing.test.ts).
    await db.execute(`UPDATE games SET price_mode = 'cached_only' WHERE id = ${zeldaId}`);

    await db.insert(pricePoints).values([
      {
        gameId: zeldaId, source: "shop_gb", region: "PAL", condition: "cib",
        kind: "sell", priceUsd: "22", priceOriginal: "22",
        currencyOriginal: "USD", listingTitle: "Zelda, boxed", fetchedAt: new Date(),
      },
    ]);

    // No `registry` override: buildApp must build the plugin's own sidecar
    // adapter from the approved row, the same way pluginApprovalNarrowing.test.ts
    // does — an injected `registry: [...]` array would never contain "shop_gb"
    // and the block would never be built.
    const app = await buildApp({ db, igdb: igdbStub });
    const res = await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PricesResponse;
    const block = body.sources.find((b) => b.source === "shop_gb");
    expect(block?.cheapestListings).toHaveLength(1);
    expect(block?.cheapestListings?.[0].priceUsd).toBe(22);
    await app.close();
  });

  it("serves only the kinds the registry declares a role for, whatever the origin", async () => {
    // R11: the narrowing is about what a source is declared to be, not about
    // whether it was compiled in. A stored row of an undeclared kind is a
    // build disagreeing with its own data either way, and the screen is not
    // where that argument is settled.
    //
    // Seeded directly into price_points (not via a live adapter fetch): CeX's
    // declaration is `{ sell, cash, voucher }`, which has no role for
    // `active_median`, so a row of that kind stored under "cex" is exactly the
    // build-versus-data disagreement this test proves gets narrowed away.
    const fetchedAt = new Date();
    await db.insert(pricePoints).values([
      {
        gameId: zeldaId, source: "cex", region: "PAL", condition: "cib",
        kind: "sell", priceUsd: "45", priceOriginal: "45",
        currencyOriginal: "USD", fetchedAt,
      },
      {
        gameId: zeldaId, source: "cex", region: "PAL", condition: "cib",
        kind: "active_median", priceUsd: "30", priceOriginal: "30",
        currencyOriginal: "USD", sampleSize: 8, fetchedAt,
      },
    ]);
    const app = await buildApp({ db, igdb: igdbStub, registry: [cexAdapter([])] });
    const res = await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices` });
    const body = res.json() as PricesResponse;
    const block = body.sources.find((s) => s.source === "cex");
    expect(block?.points.map((p) => p.kind)).toEqual(["sell"]);
    await app.close();
  });

  it("404s on an unknown game id", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    const res = await app.inject({ method: "GET", url: "/api/games/999999/prices" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
