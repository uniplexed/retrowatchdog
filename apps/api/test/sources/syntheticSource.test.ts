import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  CollectionResponse,
  PluginManifest,
  PricesResponse,
  SourceId,
  WatchlistResponse,
} from "@retrowatchdog/shared";
import { PLUGIN_PROTOCOL_VERSION } from "@retrowatchdog/shared";
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
 * A source this app has never heard of: id, family, label and country all
 * invented for this file alone. The id names a Spanish city; the declared
 * `country` is GB — deliberately mismatched, so a passing assertion can never
 * be credited to the NAME rather than to what the manifest actually says.
 */
const RETRO_ES = "retro_es" as SourceId;

/**
 * Declares exactly the four roles this file asserts on, and nothing the app
 * has a word for otherwise (kindRoles/kindLabels carry no fifth entry): the
 * market valuation reading, the cheapest-listings strip and the watchlist's
 * offer-and-bids are each driven by one role, and `kindLabels` on `sell`/
 * `cash` proves the declared-label resolver (task 6) in the same reading.
 *
 * `buy_listing` sits on `voucher`, deliberately NOT on `active_listing`: the
 * strip used to filter on `p.kind === "active_listing"` before this batch,
 * and a fixture that names its buy_listing kind `active_listing` would pass
 * against that old code identically, proving nothing about the role read.
 * `voucher` carries no role anywhere else in this file, and the watchlist's
 * bids are filtered by role (`=== "bid"`), never by kind name, so a
 * `voucher: "buy_listing"` declaration cannot leak into `storeBids`.
 *
 * `reach: "global"` is the field the copy-slice test turns on: `country: "GB"`
 * matches the default valuation markets on purpose, because a source
 * declaring a foreign country would have every point dropped by `valuesCopies`
 * before a role is ever read — a `toBeNull()`/`toBeUndefined()` assertion
 * would then pass for the wrong reason (trap 3). Nothing here tests the
 * markets gate itself; every reading below is inside it deliberately, so a
 * failure can only mean the ROLE or the REACH was not read.
 */
const manifest = (): PluginManifest => ({
  protocol: PLUGIN_PROTOCOL_VERSION,
  plugin: { name: "retro", version: "1.0.0" },
  requiredSecrets: [],
  sources: [
    {
      id: RETRO_ES,
      kind: "live",
      label: "RetroMadrid",
      family: "retro",
      familyLabel: "RetroMadrid",
      country: "GB",
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["GBP"],
      kindRoles: {
        sell: "buy_store",
        cash: "bid",
        active_median: "reference",
        voucher: "buy_listing",
      },
      kindLabels: {
        sell: "RetroMadrid sells for",
        cash: "RetroMadrid pays cash",
        active_median: "RetroMadrid median",
        voucher: "RetroMadrid listing",
      },
      sellFeeRate: 0.1,
    },
  ],
});

const fetchedAt = new Date("2026-09-04T09:00:00Z");

/**
 * Every kind the manifest declares a role for. The four `it` blocks below
 * each approve this whole list; the role-revocation proof (see the task 7
 * report) edits THIS constant alone and re-runs the file, because every test
 * reads it — a role removed here is a role removed from every route at once,
 * which is what "revoke one role, watch the dependent assertions fail" means
 * for a source this deployment reads through one shared registry entry.
 */
const ALL_KINDS = ["sell", "cash", "active_median", "voucher"];

describe.skipIf(ctx === null)(
  "a source the code has never heard of, driving every feature past the engine",
  () => {
    beforeEach(async () => ctx!.truncateAll());
    afterAll(async () => ctx?.pool.end());

    /**
     * Import and approve RETRO_ES as a plugin ROW, then enable it — never an
     * injected adapter. `app.deps.sources` (what every route below reads) is
     * built from the compiled manifest plus the `plugins` TABLE; an injected
     * `registry: [stubAdapter({ source: RETRO_ES })]` would add a FETCHER and
     * no registry entry, so its points would be stored and then read
     * role-less (trap 1). `saveEnabledSources` defeats trap 2: ENABLED_SOURCES
     * defaults to "cex,ebay_uk", and without this call the collection and
     * watchlist routes load no block for RETRO_ES at all — a silent empty
     * item, never an error, for a source that was never enabled.
     */
    const importAndApprove = async (kinds: string[]): Promise<void> => {
      const row = await insertPlugin(ctx!.db, {
        baseUrl: "http://retro:8000",
        name: "retro",
        version: "1.0.0",
        manifestSeen: manifest(),
        lastHealth: { status: "ok", protocol: PLUGIN_PROTOCOL_VERSION, configured: true },
      });
      const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
      expect(
        await approvePlugin(
          ctx!.db,
          row.id,
          { [RETRO_ES]: kinds } as Parameters<typeof approvePlugin>[2],
          reviewed,
        ),
      ).toEqual({ ok: true });
      await saveEnabledSources(ctx!.db, [RETRO_ES]);
    };

    /**
     * GAME A: an owned copy and a watchlist row, both PAL/loose, and one
     * exact-match batch carrying all four declared kinds. `price_mode`
     * is pinned to `cached_only` — RETRO_ES's adapter points at a base URL
     * nothing answers, and `/api/games/:id/prices` defaults to `cached_auto`,
     * which would attempt a live fetch of it once this fixture's `fetchedAt`
     * ages past the TTL.
     */
    const seedGameA = async (): Promise<number> => {
      const [game] = await ctx!.db
        .insert(games)
        .values({ title: "RetroMadrid Test Cart", platform: "snes" })
        .returning({ id: games.id });
      await ctx!.db.execute(`UPDATE games SET price_mode = 'cached_only' WHERE id = ${game.id}`);
      await ctx!.db.insert(pricePoints).values([
        {
          gameId: game.id, source: RETRO_ES, region: "PAL", condition: "loose",
          kind: "sell", priceUsd: "50.00", priceOriginal: "50.00",
          currencyOriginal: "GBP", available: true, fetchedAt,
        },
        {
          gameId: game.id, source: RETRO_ES, region: "PAL", condition: "loose",
          kind: "cash", priceUsd: "20.00", priceOriginal: "20.00",
          currencyOriginal: "GBP", available: true, fetchedAt,
        },
        {
          gameId: game.id, source: RETRO_ES, region: "PAL", condition: "loose",
          kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00",
          currencyOriginal: "GBP", sampleSize: 9, fetchedAt,
        },
        {
          // buy_listing lives on `voucher` here, not on the kind literally
          // named `active_listing` — see the manifest's doc comment above.
          gameId: game.id, source: RETRO_ES, region: "PAL", condition: "loose",
          kind: "voucher", priceUsd: "12.00", priceOriginal: "12.00",
          currencyOriginal: "GBP", listingTitle: "RetroMadrid listing", available: true, fetchedAt,
        },
      ]);
      await ctx!.db.insert(ownedCopies).values({ gameId: game.id, region: "PAL", condition: "loose" });
      await ctx!.db.insert(watchlist).values({ gameId: game.id, region: "PAL", condition: "loose" });
      return game.id;
    };

    /**
     * GAME B: an owned copy (PAL/loose) whose only store offer is an EXACT
     * match, compared against a reference RETRO_ES reports from an UNDECLARED
     * region. `admitsCopyPoint`'s grade rule aside, `reach: "global"` admits a
     * point whose region is the copy's own OR "unknown"; the LOCAL default
     * (an unregistered source, or a caller that never threaded the registry)
     * requires an exact region match and would reject it outright — trap 4.
     *
     * An exact-match-only fixture cannot tell the two apart: both readings
     * admit an exact point identically. This one makes them DISAGREE on which
     * SIGNAL fires, not merely on whether one fires — admitted, the median
     * resolves through the "undeclared region" rung and 50 > 20 * 1.3 fires
     * OVERPRICED_STORE; rejected, the store offer wants a comparison that can
     * never resolve and fires INSUFFICIENT_DATA instead. A `toBeNull()`-shaped
     * assertion could never catch a caller that quietly narrowed to
     * exactness; this one names the wrong signal.
     */
    const seedGameB = async (): Promise<number> => {
      const [game] = await ctx!.db
        .insert(games)
        .values({ title: "RetroMadrid Test Cart (import)", platform: "snes" })
        .returning({ id: games.id });
      await ctx!.db.insert(pricePoints).values([
        {
          gameId: game.id, source: RETRO_ES, region: "PAL", condition: "loose",
          kind: "sell", priceUsd: "50.00", priceOriginal: "50.00",
          currencyOriginal: "GBP", available: true, fetchedAt,
        },
        {
          gameId: game.id, source: RETRO_ES, region: "unknown", condition: "loose",
          kind: "active_median", priceUsd: "20.00", priceOriginal: "20.00",
          currencyOriginal: "GBP", sampleSize: 9, fetchedAt,
        },
      ]);
      await ctx!.db.insert(ownedCopies).values({ gameId: game.id, region: "PAL", condition: "loose" });
      return game.id;
    };

    it("values an owned copy of an invented source from its own market reference", async () => {
      await importAndApprove(ALL_KINDS);
      const gameId = await seedGameA();
      const app = await buildApp({ db: ctx!.db });
      const res = await app.inject({ method: "GET", url: "/api/collection?valuation=market&country=GB" });
      await app.close();
      expect(res.statusCode).toBe(200);
      const item = (res.json() as CollectionResponse).items.find((i) => i.game.id === gameId)!;
      expect(item.estimatedValueUsd).toBe(30);
      expect(item.valueBasis).toEqual({
        readAs: "reading",
        source: RETRO_ES,
        priceKind: "active_median",
        viaUnknownCondition: false,
        viaUnknownRegion: false,
      });
    });

    it("admits a copy's undeclared-region reference only because the source declares global reach", async () => {
      await importAndApprove(ALL_KINDS);
      const gameId = await seedGameB();
      const app = await buildApp({ db: ctx!.db });
      const res = await app.inject({ method: "GET", url: "/api/collection?valuation=market&country=GB" });
      await app.close();
      expect(res.statusCode).toBe(200);
      const item = (res.json() as CollectionResponse).items.find((i) => i.game.id === gameId)!;
      const overpriced = item.signals.find((s) => s.type === "OVERPRICED_STORE");
      expect(overpriced).toBeDefined();
      expect(overpriced?.reasoning).toContain("undeclared region");
      // the wrong-caller reading: an unadmitted reference leaves the store
      // offer wanting a comparison it can never resolve
      expect(item.signals.some((s) => s.type === "INSUFFICIENT_DATA")).toBe(false);
    });

    it("gives the cheapest-listings strip to a source that keys it on buy_listing, not on a kind's name", async () => {
      await importAndApprove(ALL_KINDS);
      const gameId = await seedGameA();
      const app = await buildApp({ db: ctx!.db });
      const res = await app.inject({ method: "GET", url: `/api/games/${gameId}/prices` });
      await app.close();
      expect(res.statusCode).toBe(200);
      const body = res.json() as PricesResponse;
      const block = body.sources.find((b) => b.source === RETRO_ES);
      expect(block?.cheapestListings).toHaveLength(1);
      expect(block?.cheapestListings?.[0].priceUsd).toBe(12);
    });

    it("pairs the watchlist's cheapest offer with the same shop's payout, in its own declared words", async () => {
      await importAndApprove(ALL_KINDS);
      const gameId = await seedGameA();
      const app = await buildApp({ db: ctx!.db });
      const res = await app.inject({ method: "GET", url: "/api/watchlist" });
      await app.close();
      expect(res.statusCode).toBe(200);
      const item = (res.json() as WatchlistResponse).items.find((i) => i.game.id === gameId)!;
      expect(item.storeSource).toBe(RETRO_ES);
      expect(item.storeOffer).toEqual({
        kind: "sell", label: "RetroMadrid sells for",
        priceUsd: 50, priceOriginal: 50, currencyOriginal: "GBP",
      });
      expect(item.storeBids).toEqual([
        { kind: "cash", label: "RetroMadrid pays cash", priceUsd: 20, priceOriginal: 20, currencyOriginal: "GBP" },
      ]);
    });
  },
);
