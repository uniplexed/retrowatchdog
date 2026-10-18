import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MarketSettingsResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { appSettings, plugins } from "../../src/db/schema.js";
import { ENABLED_SOURCES_KEY, loadEnabledSources } from "../../src/settings/markets.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

// Real credentials are deliberately not consulted: whether the machine running
// the suite holds eBay keys must not decide what this endpoint is allowed to
// store. The five eBay markets answer through the SEEDED plugin below, whose
// health is one `configured` reading shared by all five (see seedEbayPlugin).
const registry = [
  stubAdapter({ source: "cex" }),
  stubAdapter({ source: "cex_es" }),
];

describe.skipIf(ctx === null)("/api/settings/markets", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(ctx!.db);
    await seedEbayPlugin(ctx!.db);
  });
  afterAll(async () => ctx?.pool.end());

  const app = async () => buildApp({ db: ctx!.db, registry });

  const get = async (): Promise<MarketSettingsResponse> => {
    const res = await (await app()).inject({ method: "GET", url: "/api/settings/markets" });
    expect(res.statusCode).toBe(200);
    return res.json() as MarketSettingsResponse;
  };

  it("serves the env seed while nothing is stored, and every known market as available", async () => {
    const body = await get();
    expect(body.enabled).toEqual(["cex", "ebay_uk"]);
    // Every market the build knows is listed, not just the ones this
    // deployment can run — the screen has to show what could be turned on.
    // Every entry is an approved plugin's source, in its manifest's order,
    // oldest approval first.
    expect(body.available.map((m) => m.source)).toEqual([
      "cex", "cex_es", "cex_ie",
      "ebay_uk", "ebay_de", "ebay_es", "ebay_fr", "ebay_us",
    ]);
    // Vinted UK is offered only once its plugin has been imported and
    // approved — an approved plugin's source
    // joining this same `available` list is pinned in test/routes/plugins.test.ts.
    expect(body.available.some((m) => m.source === "vinted_uk")).toBe(false);
    expect(body.available.find((m) => m.source === "cex")).toEqual({
      source: "cex", label: "CeX UK", family: "cex", country: "GB", configured: true,
    });
    // dormant adapter (isConfigured() false)
    // eBay's five markets share ONE plugin's health reading now, not five
    // independent adapters: seedEbayPlugin's row answers `configured: true`
    // for all of them together.
    expect(
      body.available.filter((m) => m.source.startsWith("ebay_")).every((m) => m.configured),
    ).toBe(true);
  });

  it("round-trips a saved list: the PUT echoes it and the stored value then wins over the seed", async () => {
    const res = await (await app()).inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "ebay_de"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MarketSettingsResponse).enabled).toEqual(["cex", "ebay_de"]);
    expect((await get()).enabled).toEqual(["cex", "ebay_de"]);
    expect([...(await loadEnabledSources(ctx!.db))]).toEqual(["cex", "ebay_de"]);
  });

  it("accepts the empty list (every market off is a real choice)", async () => {
    const res = await (await app()).inject({
      method: "PUT", url: "/api/settings/markets", payload: { enabled: [] },
    });
    expect(res.statusCode).toBe(200);
    expect((await get()).enabled).toEqual([]);
  });

  it("rejects an unknown source id with 400 and stores nothing", async () => {
    const res = await (await app()).inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "cex_pt"] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("cex_pt");
    expect((await get()).enabled).toEqual(["cex", "ebay_uk"]); // still the seed
  });

  it("refuses to enable a source this deployment does not serve", async () => {
    // The honest failure: a market that cannot run must not be storable as
    // enabled, or the game view would carry a silently dead block forever. Here
    // the id is one no plugin declares at all.
    const res = await (await app()).inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "pricecharting"] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("pricecharting");
    expect((await get()).enabled).toEqual(["cex", "ebay_uk"]);
  });

  it("a PLUGIN losing its health takes all of its markets dark together, and they can still be switched off", async () => {
    // A market that cannot answer is always a plugin that cannot answer — one
    // plugin, one health reading, shared by every source it declares. Three
    // things are asserted: an unrelated
    // save still carries the dead market, it can be switched OFF (applying the
    // refusal to a market already stored locked the whole screen: the row could
    // not be unticked and every other save was refused, with psql the only way
    // out), and only ENABLING it again is refused.
    await (await app()).inject({
      method: "PUT", url: "/api/settings/markets", payload: { enabled: ["cex", "ebay_uk", "ebay_de"] },
    });
    await ctx!.db
      .update(plugins)
      .set({ lastHealth: { status: "missing secrets", protocol: 2, configured: false } })
      .where(eq(plugins.baseUrl, "http://ebay-plugin:8000"));

    // an unrelated change still saves, carrying both stored-but-dead markets
    const carried = await (await app()).inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "ebay_uk", "ebay_de"] },
    });
    expect(carried.statusCode).toBe(200);
    expect((carried.json() as MarketSettingsResponse).enabled).toEqual(["cex", "ebay_uk", "ebay_de"]);

    // both can be turned off
    const removed = await (await app()).inject({
      method: "PUT", url: "/api/settings/markets", payload: { enabled: ["cex"] },
    });
    expect(removed.statusCode).toBe(200);
    expect((await get()).enabled).toEqual(["cex"]);

    // adding either back, now that the plugin cannot answer, is still refused
    const readded = await (await app()).inject({
      method: "PUT", url: "/api/settings/markets", payload: { enabled: ["cex", "ebay_uk"] },
    });
    expect(readded.statusCode).toBe(400);
    expect((readded.json() as { error: string }).error).toContain("ebay_uk");
  });

  it("carries a STORED id no source answers to through a save of another market", async () => {
    // Reachable as soon as a source can be removed: a market a build stopped
    // shipping, or a plugin not approved yet, is still named by the stored
    // row — and the setting is no longer filtered on read
    // (settings/markets.ts). The client PUTs the complete list, so refusing
    // the whole request for such an id would refuse EVERY save, including the
    // one that removes it. Only ids being ADDED are checked.
    //
    // THE UPGRADE THIS PROTECTS is the one this branch performs: a deployment
    // whose `enabled_sources` names `vinted_uk` from the build that compiled
    // it in, upgraded to a build where that source exists only once its plugin
    // is approved. The screen resends the server's own enabled list verbatim,
    // so a single tick of any other market used to delete it — a setting spent
    // on a market the user never switched off.
    await ctx!.db
      .insert(appSettings)
      .values({ key: ENABLED_SOURCES_KEY, value: ["cex", "atari_jaguar_marketplace"] });
    // it is served as stored, so the screen sends it back
    expect((await get()).enabled).toEqual(["cex", "atari_jaguar_marketplace"]);

    const res = await (await app()).inject({
      method: "PUT",
      url: "/api/settings/markets",
      payload: { enabled: ["cex", "atari_jaguar_marketplace", "ebay_uk"] },
    });
    expect(res.statusCode).toBe(200);
    // the save succeeds and the unrecognised id survives it: registry order
    // first, then the ids the registry has nothing to say about
    expect((res.json() as MarketSettingsResponse).enabled).toEqual([
      "cex", "ebay_uk", "atari_jaguar_marketplace",
    ]);
    expect((await get()).enabled).toEqual(["cex", "ebay_uk", "atari_jaguar_marketplace"]);
  });

  it("still removes a stored id no source answers to when the caller drops it", async () => {
    // Carried is not welded on: the id is kept because the caller sent it
    // back, so a list that leaves it out is a user switching it off and the
    // save honours that.
    await ctx!.db
      .insert(appSettings)
      .values({ key: ENABLED_SOURCES_KEY, value: ["cex", "atari_jaguar_marketplace"] });
    const res = await (await app()).inject({
      method: "PUT", url: "/api/settings/markets", payload: { enabled: ["cex"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MarketSettingsResponse).enabled).toEqual(["cex"]);
    expect((await get()).enabled).toEqual(["cex"]);
  });

  it("de-duplicates a repeated id instead of storing it twice", async () => {
    const res = await (await app()).inject({
      method: "PUT", url: "/api/settings/markets", payload: { enabled: ["cex", "cex", "ebay_uk"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MarketSettingsResponse).enabled).toEqual(["cex", "ebay_uk"]);
  });
});
