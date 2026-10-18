import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { setupTestDb } from "../../helpers/testDb.js";
import { makeBulkSink } from "../../../src/worker/catalogSink.js";
import {
  PluginCatalogAdapter,
  PluginCatalogEmptyError,
} from "../../../src/adapters/sidecar/catalogAdapter.js";
import { SidecarSyncCapability } from "../../../src/adapters/sidecar/sync.js";
import { RateLimiter } from "../../../src/lib/rateLimiter.js";
import { CircuitBreaker } from "../../../src/lib/circuitBreaker.js";
import type { CatalogItemUpsert } from "../../../src/adapters/types.js";
import { catalogItems } from "../../../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const BASE = "http://shop:8000";
const SOURCE = "shop_gb";
const SYNCED_AT = new Date("2026-09-03T03:00:00Z");
let agent: MockAgent;

function adapter(overrides: Partial<ConstructorParameters<typeof PluginCatalogAdapter>[0]> = {}) {
  return new PluginCatalogAdapter({
    db: ctx!.db,
    source: SOURCE,
    baseUrl: BASE,
    snapshotStrategy: "per_listing",
    family: "shop",
    declaredKinds: ["sell", "cash"],
    expectedCurrencies: ["GBP"],
    catalogSync: new SidecarSyncCapability({
      source: SOURCE,
      baseUrl: BASE,
      schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
      approvedKinds: ["sell", "cash"],
      expectedCurrencies: ["GBP"],
      limiter: new RateLimiter(0),
      breaker: new CircuitBreaker({ failureThreshold: 5, holdMs: 1000 }),
    }),
    ...overrides,
  });
}

async function store(...items: CatalogItemUpsert[]): Promise<void> {
  await makeBulkSink(ctx!.db, SOURCE, "Toys", SYNCED_AT).upsert(items);
}

const item = (id: string, title: string, extra: Partial<CatalogItemUpsert> = {}): CatalogItemUpsert => ({
  sourceProductId: id,
  title,
  categoryText: "N64 Games",
  prices: { sell: "38.00", cash: "20.00" },
  currency: "GBP",
  available: true,
  ...extra,
});

/**
 * A sync plugin source is searched in the app's OWN catalogue.
 *
 * The protocol gives a sync plugin no `/search` endpoint (spec A.3), so this
 * is not an optimisation: an adapter that asked the plugin would ask for
 * something it does not serve, once per game view, and read as a broken source
 * on every screen. The MockAgent below refuses every outbound connection, so a
 * search that reached the wire fails the test rather than passing quietly.
 */
describe.skipIf(ctx === null)("PluginCatalogAdapter", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });
  afterAll(async () => ctx?.pool.end());

  it("answers from catalog_items without calling the plugin at all", async () => {
    await store(
      item("A1", "Legend of Zelda Ocarina of Time, Boxed"),
      item("A2", "Super Mario 64, Unboxed"),
    );
    const listings = await adapter().search("Legend of Zelda Ocarina of Time");
    expect(listings.map((l) => l.sourceProductId)).toEqual(["A1"]);
    const [listing] = listings;
    // jsonb does not keep the key order it was given, so the kinds are
    // asserted as a set: the prices are what matters, their order is not
    expect([...listing.prices].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "cash", amount: 20, currency: "GBP" },
      { kind: "sell", amount: 38, currency: "GBP" },
    ]);
    expect(listing.categoryText).toBe("N64 Games");
    expect(listing.available).toBe(true);
    // when the sweep saw it, not when the page was opened
    expect(listing.observedAt).toEqual(SYNCED_AT);
    // protocol A.3's row has no url field, so there is no link to invent
    expect(listing.url).toBeNull();
    agent.assertNoPendingInterceptors();
  });

  it("reads a row's own observedAt, conditionText and sample back, and falls back to syncedAt", async () => {
    const synced = new Date("2026-09-17T03:00:00Z");
    const seen = new Date("2026-09-16T21:30:00Z");
    await ctx!.db.insert(catalogItems).values([
      {
        source: SOURCE, sourceProductId: "WITH", title: "Castlevania II Belmont's Revenge",
        prices: { sell: "38.00" }, currency: "GBP", syncedAt: synced, lastSeenAt: synced,
        refreshSource: "bulk", observedAt: seen, conditionText: "Very good", sampleSizes: { sell: 12 },
      },
      {
        source: SOURCE, sourceProductId: "WITHOUT", title: "Castlevania II Belmont's Revenge (alt)",
        prices: { sell: "40.00" }, currency: "GBP", syncedAt: synced, lastSeenAt: synced, refreshSource: "bulk",
      },
    ]);
    const listings = await adapter().search("Castlevania II Belmont's Revenge", "gb");
    const withFields = listings.find((l) => l.sourceProductId === "WITH")!;
    const without = listings.find((l) => l.sourceProductId === "WITHOUT")!;
    expect(withFields.observedAt).toEqual(seen);
    expect(withFields.conditionText).toBe("Very good");
    expect(withFields.prices).toEqual([{ kind: "sell", amount: 38, currency: "GBP", sampleSize: 12 }]);
    expect(without.observedAt).toEqual(synced);
    expect(without).not.toHaveProperty("conditionText");
    expect(without.prices[0]).not.toHaveProperty("sampleSize");
  });

  it("drops a stored sample above the write-side bound instead of carrying it through", async () => {
    // The column is jsonb: a row written before MAX_SAMPLE_SIZE existed, or by
    // a bug, can hold a sample no live plugin could ever send. The price must
    // survive without it, not carry a value the price_points insert (an
    // integer column) could throw on.
    const synced = new Date("2026-09-17T03:00:00Z");
    await ctx!.db.insert(catalogItems).values([
      {
        source: SOURCE, sourceProductId: "OOB", title: "Castlevania II Belmont's Revenge",
        prices: { sell: "38.00" }, currency: "GBP", syncedAt: synced, lastSeenAt: synced,
        refreshSource: "bulk", sampleSizes: { sell: 3_000_000_000 },
      },
    ]);
    const listings = await adapter().search("Castlevania II Belmont's Revenge", "gb");
    const [listing] = listings;
    expect(listing.prices).toEqual([{ kind: "sell", amount: 38, currency: "GBP" }]);
    expect(listing.prices[0]).not.toHaveProperty("sampleSize");
  });

  it("carries the row's OWN currency, not a compiled-in fact about the shop", async () => {
    await store(item("A1", "Super Mario 64", { currency: "EUR" }));
    const [listing] = await adapter({ expectedCurrencies: ["EUR"] }).search("Super Mario 64");
    expect(listing.prices.map((p) => p.currency)).toEqual(["EUR", "EUR"]);
  });

  it("reads a stored row under TODAY's approval, not the one it was swept under", async () => {
    // A row outlives an approval. Re-approving with `cash` unchecked has to
    // stop that price being read, or an unapproved kind would keep printing a
    // claim about this market under its own heading.
    await store(item("A1", "Super Mario 64", { prices: { sell: "38.00", cash: "20.00" } }));
    const [listing] = await adapter({ declaredKinds: ["sell"] }).search("Super Mario 64");
    expect(listing.prices).toEqual([{ kind: "sell", amount: 38, currency: "GBP" }]);
  });

  it("drops a row whose stored currency the source's site no longer quotes", async () => {
    // The alternative is worse than losing the row: the amount would be frozen
    // into a USD twin at another country's rate, permanently.
    await store(item("A1", "Super Mario 64", { currency: "USD" }));
    await expect(adapter({ expectedCurrencies: ["GBP"] }).search("Super Mario 64")).resolves.toEqual([]);
  });

  it("drops a row left with no price the app may read", async () => {
    await store(item("A1", "Super Mario 64", { prices: { voucher: "26.00" } }));
    await expect(adapter().search("Super Mario 64")).resolves.toEqual([]);
  });

  it("keeps a shop's own complete-in-box SKU title, which the non-game reading would refuse", async () => {
    // Measured, and the reason this path does not run the app's free-text
    // merchandise filter: `isNonGameListing` treats the real shop title shape
    // "…, w/ Manual, Boxed" as an accessory listing, because the completeness
    // qualifier knows "with" and "w/o" but not a shop's bare "w/". Running it
    // here would delete the CIB tier of a whole catalogue.
    await store(item("A1", "Legend of Zelda Ocarina of Time, w/ Manual, Boxed"));
    const listings = await adapter().search("Legend of Zelda Ocarina of Time");
    expect(listings.map((l) => l.sourceProductId)).toEqual(["A1"]);
  });

  it("tells a catalogue that has never synced apart from one that has nothing to say", async () => {
    // An empty block for a source whose sweep never ran looks healthy and is
    // not.
    await expect(adapter().search("Super Mario 64")).rejects.toBeInstanceOf(PluginCatalogEmptyError);
    await store(item("A1", "Legend of Zelda Ocarina of Time"));
    await expect(adapter().search("something else entirely")).resolves.toEqual([]);
  });

  it("classifies with the app's shared classifier, never the plugin's words", async () => {
    // A shop's SKU title names no console, so the platform comes off the
    // category — without it the matcher runs with NO platform filter and this
    // title could confirm against the 3DS release, forever.
    await store(item("A1", "Legend of Zelda Ocarina of Time, w/ Manual, Boxed"));
    const [listing] = await adapter().search("Legend of Zelda Ocarina of Time");
    const normalized = adapter().normalize(listing);
    expect(normalized.platformGuess).toBe("n64");
    expect(normalized.conditionGuess).toBe("cib");
  });

  it("lets the shop's own category win over a title that names another console", async () => {
    // Reversed deliberately, and the SKU that reverses it is the ordinary one:
    // "Super Mario Advance" is a GBA cartridge whose name carries the SNES
    // original, and re-releases and compilations do this constantly. The title
    // is marketing text; the category is the shop's structured answer to
    // exactly this question, for exactly this SKU. Getting it wrong is not
    // cheap: a confirmed mapping to the wrong release is kept forever.
    await store(item("A1", "Super Mario Advance SNES", { categoryText: "GBA Games" }));
    const [listing] = await adapter().search("Super Mario Advance SNES");
    expect(adapter().normalize(listing).platformGuess).toBe("gba");
  });

  it("falls back to the title when the category is one this build cannot read", async () => {
    // The hint list is written from CeX's live category names, so it is a guess
    // about another shop's vocabulary. Unrecognised, it leaves the title as the
    // only thing that said anything — which is better than no platform at all,
    // since an unknown platform drops the matcher's platform filter entirely.
    await store(item("A1", "Super Mario 64 N64 cart", { categoryText: "Retro Bundles" }));
    const [listing] = await adapter().search("Super Mario 64 N64 cart");
    expect(adapter().normalize(listing).platformGuess).toBe("n64");
  });

  it("classifies a shop's region-less SKU as the region its manifest declares", async () => {
    // The manifest field exists for exactly this. Without it a plugin shop's
    // SKU reads `unknown` where the identical CeX SKU reads PAL, and the app
    // compares prices per (game, region, condition) — so the two would never be
    // compared at all, which is the app's whole proposition.
    await store(item("A1", "Legend of Zelda Ocarina of Time, w/ Manual, Boxed"));
    const [listing] = await adapter().search("Legend of Zelda Ocarina of Time");
    expect(adapter({ defaultRegion: "PAL" }).normalize(listing).regionGuess).toBe("PAL");
    // and a source that declares none still guesses none
    expect(adapter().normalize(listing).regionGuess).toBe("unknown");
  });

  it("never lets the declared region overrule what the title says", async () => {
    // The default is for a title that
    // declared nothing. A bare "import" marker says "not the domestic region"
    // without saying which, so it stays unknown rather than being answered.
    await store(item("A1", "Super Mario 64 NTSC-J"), item("A2", "Super Mario 64 Import"));
    const pal = adapter({ defaultRegion: "PAL" });
    const found = await pal.search("Super Mario 64");
    const byId = new Map(found.map((l) => [l.sourceProductId, l]));
    expect(pal.normalize(byId.get("A1")!).regionGuess).toBe("NTSC_J");
    expect(pal.normalize(byId.get("A2")!).regionGuess).toBe("unknown");
  });

  it("links a synced row through the template its manifest declared", async () => {
    // A synced row cannot carry a URL -- the protocol has no field for one --
    // so the template is where a sync source's points get their link. It is
    // not only the click: `price_points.source_url` is what the mapping sweep
    // matches a stored point back to its mapping by, so a source with no link
    // stores points the stale-point invalidation cannot find.
    await store(item("045496830144C", "Super Mario Kart, Unboxed"));
    const template = "https://uk.webuy.com/product-detail?id={id}";
    const [linked] = await adapter({ productUrl: template }).search("Super Mario Kart");
    expect(linked.url).toBe("https://uk.webuy.com/product-detail?id=045496830144C");
    // and a source that declares no template still stores no link
    const [bare] = await adapter().search("Super Mario Kart");
    expect(bare.url).toBeNull();
  });

  it("encodes the id it substitutes, so one cannot smuggle a query of its own", async () => {
    // The import check pins the ORIGIN the prefix resolves to; encoding is what
    // this side owes on top of it. Declared by the protocol's own note on
    // productUrl.
    await store(item("A 1&x=2", "Super Mario Kart, Unboxed"));
    const [listing] = await adapter({
      productUrl: "https://uk.webuy.com/product-detail?id={id}",
    }).search("Super Mario Kart");
    expect(listing.url).toBe("https://uk.webuy.com/product-detail?id=A%201%26x%3D2");
  });

  it("prefers the hinted platform's shelves for a family the app can read", async () => {
    // A narrowing selected by the family a manifest declares. Without it a query whose trigram top-50 is crowded
    // with another console's SKUs -- CeX's catalogue is ~63.7k of them -- can
    // push the right platform's rows out of the answer entirely.
    await store(
      item("A1", "Super Mario Kart", { categoryText: "Super NES Software" }),
      item("A2", "Super Mario Kart Advance", { categoryText: "GBA Games" }),
    );
    const found = await adapter({ family: "cex" }).search("Super Mario Kart", "snes");
    expect(found.map((l) => l.sourceProductId)).toEqual(["A1"]);
  });

  it("narrows by nothing for a family the app has no reading for", async () => {
    // The R12 defect, stated as a test: these hint words are facts about CeX's
    // own category names, and another shop's shelves are its own vocabulary.
    // Applying them there would drop rows for being named differently.
    await store(
      item("A1", "Super Mario Kart", { categoryText: "Super NES Software" }),
      item("A2", "Super Mario Kart Advance", { categoryText: "GBA Games" }),
    );
    const found = await adapter({ family: "boutique" }).search("Super Mario Kart", "snes");
    expect(found.map((l) => l.sourceProductId).sort()).toEqual(["A1", "A2"]);
  });

  it("falls back to the whole answer when the hint would empty it", async () => {
    // Recall-widening ONLY: the matcher's hard platform filter is what makes
    // the answer correct, so a hint that matches nothing must not turn a real
    // answer into none. Tested on LISTINGS rather than rows, because a row
    // with no readable price yields no listing at all.
    await store(item("A1", "Super Mario Kart", { categoryText: "Super NES Software" }));
    const found = await adapter({ family: "cex" }).search("Super Mario Kart", "gba");
    expect(found.map((l) => l.sourceProductId)).toEqual(["A1"]);
  });

  it("carries the sweep as its catalogSync, which is what makes it a catalog source", async () => {
    expect(adapter().catalogSync.schedule).toEqual({
      catalogCron: "0 3 * * *",
      trackedRefreshHours: 4,
    });
  });
});
