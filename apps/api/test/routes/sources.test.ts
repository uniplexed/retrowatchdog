import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginManifest, SourceInfoDto, SourcesResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { buildApp } from "../../src/app.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

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
      kindRoles: { sell: "buy_store", cash: "bid" },
      kindLabels: { sell: "Shop GB sells for", cash: "Shop GB pays cash" },
      caveat: "an unofficial community reader",
    },
  ],
});

/**
 * GET /api/sources is how the web knows what sources this deployment has: it
 * compiles none of them in, so every field its screens render — the
 * label, the per-kind wording, the caveat, the family heading, and the roles
 * that decide whether a shop is shown as two-sided — has to survive the trip
 * through JSON. A field lost here is a field missing on screen.
 */
describe.skipIf(ctx === null)("GET /api/sources", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(ctx!.db);
  });
  afterAll(async () => ctx?.pool.end());

  const app = async () =>
    buildApp({
      db: ctx!.db,
      registry: [stubAdapter({ source: "cex" })],
    });

  const sources = async (): Promise<SourceInfoDto[]> => {
    const res = await (await app()).inject({ method: "GET", url: "/api/sources" });
    expect(res.statusCode).toBe(200);
    return (res.json() as SourcesResponse).sources;
  };

  it("serves the eBay plugin's adopted sources with the fields the web used to compile in", async () => {
    // What this endpoint serves for eBay's five markets once the plugin is
    // approved: seedEbayPlugin approves the plugin's own manifest fixture.
    await seedEbayPlugin(ctx!.db);
    const list = await sources();
    const ebay = list.find((s) => s.id === "ebay_uk");
    expect(ebay).toMatchObject({
      label: "eBay UK",
      family: "ebay",
      familyLabel: "eBay",
      country: "GB",
      reach: "global",
      kind: "live",
      origin: "plugin",
      defaultRegion: null,
      expectedCurrencies: ["GBP"],
    });
    expect(ebay!.pluginId).not.toBeNull();
    expect(ebay!.kindLabels?.active_median).toBe("eBay UK median (active)");
    expect(ebay!.kindRoles).toEqual({ active_median: "reference", active_listing: "buy_listing" });
    expect(ebay!.caveat).toMatch(/active/i);
    // every source is an approved plugin's, in its manifest's order, oldest
    // approval first
    expect(list.map((s) => s.id)).toEqual([
      "cex", "cex_es", "cex_ie",
      "ebay_uk", "ebay_de", "ebay_es", "ebay_fr", "ebay_us",
    ]);
    // `vinted_uk` is absent because it is a plugin nobody has approved on
    // this deployment. A deployment carrying stored Vinted price points
    // serves exactly this list until the user approves that plugin too —
    // which is what makes those rows unreadable meanwhile, and what makes
    // the approval visible.
    expect(list.some((s) => s.id === "vinted_uk")).toBe(false);
  });

  it("says which markets this deployment can actually run", async () => {
    // A plugin source's `configured` comes from ITS PLUGIN's health, never
    // from an adapter given to `registry` — seeding an unhealthy eBay plugin
    // proves the two are independent.
    await seedEbayPlugin(ctx!.db, "http://ebay-plugin:8000", { configured: false });
    const list = await sources();
    // CeX's three shops read `configured: true` from the CeX plugin's own
    // health (one reading for the three, as eBay's five share theirs), and the
    // eBay plugin is present — it is approved — but unconfigured.
    expect(list.filter((s) => s.configured).map((s) => s.id)).toEqual(["cex", "cex_es", "cex_ie"]);
    expect(list.find((s) => s.id === "ebay_uk")?.configured).toBe(false);
  });

  it("serves an approved plugin's source, narrowed to the kinds the user checked", async () => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    expect(await approvePlugin(ctx!.db, row.id, { shop_gb: ["sell"] }, reviewed)).toEqual({ ok: true });

    const shop = (await sources()).find((s) => s.id === "shop_gb");
    expect(shop).toMatchObject({
      label: "Shop GB",
      familyLabel: "Shop",
      origin: "plugin",
      pluginId: row.id,
      configured: true,
      defaultRegion: "PAL",
    });
    // `cash` was declared and NOT checked, so the app does not serve a role
    // for it: an unapproved kind is not merely inert, it does not exist.
    expect(shop!.kindRoles).toEqual({ sell: "buy_store" });
  });

  it("does not serve a plugin that has only been imported", async () => {
    await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    expect((await sources()).some((s) => s.id === "shop_gb")).toBe(false);
  });
});
