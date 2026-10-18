import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { appSettings } from "../../src/db/schema.js";
import {
  ENABLED_SOURCES_KEY,
  enabledSourceIds,
  loadEnabledSources,
  saveEnabledSources,
  seedEnabledSources,
} from "../../src/settings/markets.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("enabled markets setting", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("seeds from ENABLED_SOURCES while the settings row is absent", async () => {
    // A fresh deployment starts UK-only: the env var is the SEED, so the very
    // first game view queries the UK markets and nothing else.
    expect([...(await loadEnabledSources(ctx!.db))]).toEqual(seedEnabledSources());
    expect(seedEnabledSources()).toEqual(["cex", "ebay_uk"]);
  });

  it("does not write the seed on read (the seed keeps applying until the user chooses)", async () => {
    await loadEnabledSources(ctx!.db);
    expect(await ctx!.db.select().from(appSettings)).toEqual([]);
  });

  it("lets the stored list win over the seed once saved", async () => {
    await saveEnabledSources(ctx!.db, ["cex", "cex_es", "ebay_de"]);
    expect([...(await loadEnabledSources(ctx!.db))]).toEqual(["cex", "cex_es", "ebay_de"]);
  });

  it("keeps an empty stored list empty (the seed never sneaks back)", async () => {
    // Turning every market off is a legitimate choice — and it must not read
    // as "unset", or the app would quietly resume querying the UK markets.
    await saveEnabledSources(ctx!.db, []);
    expect([...(await loadEnabledSources(ctx!.db))]).toEqual([]);
  });

  it("keeps a stored id no source in this build answers to, and lets the consumers ignore it", async () => {
    // A source may come from an approved plugin, and this function is handed
    // a `Db` and nothing else. Filtering here would silently drop every plugin
    // source the user has enabled.
    //
    // What makes that safe is that the ids go nowhere on their own: every
    // consumer intersects them with a list of things that can actually answer.
    // The intersection is asserted here, on the same shape the pricing service
    // and the worker use, so the reason this filter could go stays checked
    // rather than merely written down.
    await ctx!.db
      .insert(appSettings)
      .values({ key: ENABLED_SOURCES_KEY, value: ["cex", "atari_jaguar_marketplace"] });
    const enabled = await loadEnabledSources(ctx!.db);
    expect([...enabled]).toEqual(["cex", "atari_jaguar_marketplace"]);

    const registry = [stubAdapter({ source: "cex" }), stubAdapter({ source: "ebay_uk" })];
    expect(registry.filter((a) => enabled.has(a.source)).map((a) => a.source)).toEqual(["cex"]);
    expect(await enabledSourceIds(ctx!.db, registry)).toEqual(["cex"]);
  });
});
