import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CollectionResponse, PluginManifest, Signal, SourceReach } from "@retrowatchdog/shared";
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
 * A plugin source whose `reach` is the thing under test.
 *
 * `reach` decides which stored points may speak for an OWNED COPY —
 * `admitsCopyPoint` in collection/copySlice.ts — and it is the one property of
 * a source that the collection route reads through a lookup rather than off
 * the point. A source missing from that lookup reads as `local`: the strict
 * reading, region AND condition equal to the copy's. So a plugin source's
 * points go silent for an owned copy unless the route passes this
 * deployment's registry as the third argument.
 *
 * Every fixture below is therefore built so the two readings DISAGREE: the
 * points carry an undeclared condition, which a `global` source may lend to a
 * copy through the labelled ladder and a `local` source may not.
 */
const manifest = (reach: SourceReach): PluginManifest => ({
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
      reach,
      defaultRegion: "PAL",
      expectedCurrencies: ["GBP"],
      kindRoles: { active_median: "reference", active_listing: "buy_listing" },
      kindLabels: { active_median: "Shop GB median", active_listing: "Shop GB listing" },
    },
  ],
});

const fetchedAt = new Date("2026-09-04T09:00:00Z");

describe.skipIf(ctx === null)("a plugin source's reach decides what speaks for an owned copy", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  const approvedPlugin = async (reach: SourceReach): Promise<void> => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(reach),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    expect(
      await approvePlugin(ctx!.db, row.id, { shop_gb: ["active_median", "active_listing"] }, reviewed),
    ).toEqual({ ok: true });
  };

  /**
   * A PAL median of £30 over nine listings and a £19 listing under it (below
   * the 0.7 underpriced factor), both stored with condition `unknown` — the
   * shape a marketplace's own rows really have, since a free-text title
   * usually declares no completeness tier.
   *
   * The owned copy is PAL/`loose`. So:
   *   - read through this deployment's registry, `shop_gb` is `global` and its
   *     undeclared-condition rows stand in for the copy through the ladder,
   *     the reference resolves, and rule 1 barks UNDERPRICED;
   *   - read through the compiled manifest, `shop_gb` is not there, reads as
   *     `local`, and BOTH rows are refused for a mismatched condition. The
   *     copy's slice is empty and the response carries no bark at all.
   */
  const seedGame = async (reach: SourceReach): Promise<number> => {
    const [game] = await ctx!.db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    await ctx!.db.insert(pricePoints).values([
      {
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "unknown",
        kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00",
        currencyOriginal: "GBP", sampleSize: 9, fetchedAt,
      },
      {
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "unknown",
        kind: "active_listing", priceUsd: "19.00", priceOriginal: "19.00",
        currencyOriginal: "GBP", listingTitle: "Super Metroid cart only",
        sourceUrl: "https://shop.example/1", fetchedAt,
      },
    ]);
    await approvedPlugin(reach);
    // the plugin's source is the only market this deployment reads, so nothing
    // built in can stand in for it
    await saveEnabledSources(ctx!.db, ["shop_gb"]);
    await ctx!.db.insert(ownedCopies).values({
      gameId: game.id, region: "PAL", condition: "loose",
    });
    return game.id;
  };

  const collectionSignals = async (): Promise<Signal[]> => {
    // No `registry` override: the app builds the plugin's adapter too, which is
    // what puts `shop_gb` in the list the route walks. Nothing is fetched —
    // every point here is a stored row.
    const app = await buildApp({ db: ctx!.db });
    const res = await app.inject({ method: "GET", url: "/api/collection" });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json() as CollectionResponse;
    expect(body.items).toHaveLength(1);
    return body.items[0].signals;
  };

  it("lends a global plugin source's undeclared-condition rows to the copy", async () => {
    await seedGame("global");
    const signals = await collectionSignals();

    const bark = signals.find((s) => s.type === "UNDERPRICED");
    expect(bark).toBeDefined();
    expect(bark?.source).toBe("shop_gb");
    // the plugin's own label and the amounts in the currency the comparison
    // happened in
    expect(bark?.reasoning).toContain("Shop GB");
    expect(bark?.reasoning).toContain("£19");
    expect(bark?.reasoning).toContain("£30");
    expect(bark?.url).toBe("https://shop.example/1");
    // and the ladder labelled the rung it descended to, so the reading is
    // offered as `potential` rather than as a fact about this copy's tier
    expect(bark?.confidence).toBe("potential");
  });

  it("refuses the same rows when the plugin source is local", async () => {
    // The other half, and the reason the test above is about REACH and not
    // about plugin sources being admitted wholesale: a shelf price is for the
    // exact box it lists, so a shop's undeclared-condition row never speaks
    // for a `loose` copy however the source is looked up.
    await seedGame("local");
    expect(await collectionSignals()).not.toContainEqual(
      expect.objectContaining({ type: "UNDERPRICED" }),
    );
  });
});
