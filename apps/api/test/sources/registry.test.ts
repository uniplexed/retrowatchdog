import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type PluginManifest, type SourceSchedule } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";
import {
  buildSourceRuntime,
  effectiveKindLabels,
  effectiveKindRoles,
  snapshotStrategyFor,
} from "../../src/sources/registry.js";
import { SidecarAdapter } from "../../src/adapters/sidecar/index.js";
import {
  PluginCatalogAdapter,
  PluginCatalogEmptyError,
} from "../../src/adapters/sidecar/catalogAdapter.js";
import { config } from "../../src/config.js";
import { medianPointsFrom } from "../../src/pricing/service.js";
import type { NormalizedListing } from "../../src/adapters/types.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

/**
 * A plugin serving two sources — the case one limiter and one breaker per
 * plugin exists for. Every field is one `validateManifest` accepts, because
 * the repository validates the column on read: a fixture it refuses would come
 * back as no manifest at all and the source would simply never appear.
 */
const twoSourceManifest = (): PluginManifest => ({
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
      kindLabels: { sell: "Shop GB sells for", cash: "Shop GB pays cash", active_median: "Shop GB median" },
    },
    {
      id: "shop_de",
      kind: "live",
      label: "Shop DE",
      family: "shop",
      familyLabel: "Shop",
      country: "DE",
      reach: "local",
      defaultRegion: "PAL",
      expectedCurrencies: ["EUR"],
      kindRoles: { sell: "buy_store" },
      kindLabels: { sell: "Shop DE sells for" },
    },
  ],
});

/**
 * The one import a test needs, in the shape the repository actually takes.
 * `baseUrl` is a parameter because the column is one plugin's address: a test
 * with two plugins has to give them two.
 */
async function importPlugin(
  manifest: PluginManifest,
  configured = true,
  baseUrl = "http://shop:8000",
): Promise<{ id: number }> {
  const row = await insertPlugin(ctx!.db, {
    baseUrl,
    name: manifest.plugin.name,
    version: manifest.plugin.version,
    manifestSeen: manifest,
    lastHealth: configured ? { status: "ok", protocol: 2, configured: true } : null,
  });
  return { id: row.id };
}

/**
 * Approve exactly the manifest the row currently holds — the signature the
 * repository requires, since approval is consent to a DOCUMENT and not to a
 * plugin. The result is asserted here rather than in each test: an approval
 * that silently did nothing would otherwise surface as an empty registry
 * several assertions later, blaming the wrong module.
 */
async function approve(id: number, approvedKinds: Record<string, string[]>): Promise<void> {
  const reviewed = (await getPlugin(ctx!.db, id))!.manifestSeen!;
  const result = await approvePlugin(
    ctx!.db,
    id,
    approvedKinds as Parameters<typeof approvePlugin>[2],
    reviewed,
  );
  expect(result).toEqual({ ok: true });
}

describe("effectiveKindRoles, effectiveKindLabels and snapshotStrategyFor", () => {
  it("narrows a plugin's declared roles to the kinds the user approved", () => {
    // Approval is per KIND, and an unchecked kind must not survive into the
    // registry: the price table renders every stored row, so a role nobody
    // approved would still print a claim about that market in the app's voice.
    const declared = { sell: "buy_store", cash: "bid", active_median: "reference" } as const;
    expect(effectiveKindRoles(declared, ["sell", "cash"])).toEqual({
      sell: "buy_store",
      cash: "bid",
    });
    expect(effectiveKindRoles(declared, [])).toEqual({});
    // no record of an approval at all is the same as nothing approved
    expect(effectiveKindRoles(declared, undefined)).toEqual({});
  });

  it("narrows the WORDING to the same kinds, not only the roles", () => {
    // Narrowing the roles alone silences the signal engine and leaves the
    // sentence: the price table renders every stored row, so a `cash` row
    // written while `cash` was approved would still print "Shop GB pays cash"
    // after the user unticked it — a claim about a market in the app's own
    // wording, for a role nobody granted.
    const declared = { sell: "Shop GB sells for", cash: "Shop GB pays cash" } as const;
    expect(effectiveKindLabels(declared, { sell: "buy_store" })).toEqual({
      sell: "Shop GB sells for",
    });
    // nothing approved leaves no wording at all, and absent rather than empty:
    // the game view falls back to its own words for a source that labelled none
    expect(effectiveKindLabels(declared, {})).toBeUndefined();
    expect(effectiveKindLabels(undefined, { sell: "buy_store" })).toBeUndefined();
  });

  it("derives the snapshot strategy instead of letting a manifest declare it", () => {
    // A median row is a kind the source must hold a role for; a source without
    // one stores each matched listing as its own real, clickable row.
    expect(snapshotStrategyFor({ active_median: "reference", active_listing: "buy_listing" })).toBe(
      "median_of_listings",
    );
    expect(snapshotStrategyFor({ active_listing: "buy_listing" })).toBe("per_listing");
    expect(snapshotStrategyFor({ sell: "buy_store" })).toBe("per_listing");
  });

  it("refuses to median a source that may not send listings", () => {
    // `active_median` alone is not a median source. Its effective kinds ARE
    // the kinds it may send, so it can only answer with rows that call
    // themselves medians — and taking a median of those would store one
    // invented aggregate whose sample size counts medians as listings, plus
    // cheapest-"listing" rows for a source with no listing role at all.
    expect(snapshotStrategyFor({ active_median: "reference" })).toBe("per_listing");
    expect(snapshotStrategyFor({ active_median: "reference", sell: "buy_store" })).toBe(
      "per_listing",
    );
  });

  it("keys the strategy on ROLES, never on eBay's own kind names (task 4)", () => {
    // The regression this task closes: the old check tested for the literal
    // kind names `active_median` and `active_listing`, so a source declaring
    // the same two roles under any other vocabulary fell through to
    // `per_listing` and its listing rows then landed under a kind the
    // registry gives no role — filtered out at read and inert in the engine,
    // with no error anywhere. Kind names invented for this test, never
    // eBay's, so a pass here cannot be explained by a name match instead of
    // a role match.
    expect(snapshotStrategyFor({ sell: "buy_listing", guide: "reference" })).toBe(
      "median_of_listings",
    );
    // buy_listing alone, no reference: still per_listing, and still no
    // aggregate invented — the same refusal as the eBay-named case above,
    // proved again on a vocabulary the app has never seen.
    expect(snapshotStrategyFor({ sell: "buy_listing" })).toBe("per_listing");
  });
});

describe.skipIf(ctx === null)("buildSourceRuntime", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("serves nothing when there is no approved plugin", async () => {
    const { registry, adapters } = await buildSourceRuntime(ctx!.db);
    expect(registry.sources).toEqual([]);
    expect(adapters).toEqual([]);
  });

  it("ignores an adapter for a source nothing declares", async () => {
    // An injected adapter for a source no plugin declares is NOT a market. It
    // cannot be enabled, queried or named, because the registry is built from
    // approved manifests only and an adapter is not one.
    const { registry } = await buildSourceRuntime(ctx!.db, [stubAdapter({ source: "shop_zz" })]);
    expect(registry.get("shop_zz")).toBeUndefined();
    expect(registry.sources).toEqual([]);
  });

  it("ignores a pending plugin entirely", async () => {
    // Approving is a separate act from importing: a pending plugin's sources
    // do not exist, so nothing can enable, query or even name them.
    await importPlugin(twoSourceManifest());
    const { registry, adapters } = await buildSourceRuntime(ctx!.db);
    expect(registry.has("shop_gb")).toBe(false);
    expect(registry.get("shop_gb")).toBeUndefined();
    expect(adapters.find((a) => a.source === "shop_gb")).toBeUndefined();
  });

  it("serves an approved plugin's sources with only the approved kinds", async () => {
    const { id } = await importPlugin(twoSourceManifest());
    // `active_median: reference` was left unchecked, which is the default in
    // the approval screen
    await approve(id, { shop_gb: ["sell", "cash"], shop_de: ["sell"] });

    const { registry, adapters } = await buildSourceRuntime(ctx!.db);
    const gb = registry.get("shop_gb");
    expect(gb?.origin).toBe("plugin");
    expect(gb?.pluginId).toBe(id);
    expect(gb?.kindRoles).toEqual({ sell: "buy_store", cash: "bid" });
    expect(gb?.configured).toBe(true);
    expect(gb?.label).toBe("Shop GB");
    expect(gb?.familyLabel).toBe("Shop");
    expect(registry.get("shop_de")?.country).toBe("DE");
    // the adapter may send only the kinds that survived the narrowing
    const adapter = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
    expect([...adapter.declaredKinds].sort()).toEqual(["cash", "sell"]);
    // an unapproved `reference` role must not make this a median source
    expect(adapter.snapshotStrategy).toBe("per_listing");
    expect([...adapter.expectedCurrencies]).toEqual(["GBP"]);
  });

  it("leaves a revoked kind's WORDING out of the registry, not only its role", async () => {
    // The other half of the narrowing above, at the level the app reads. The
    // manifest labels three kinds; the user approves one. A DTO carrying the
    // other two labels puts a claim about that market on screen in the app's
    // own voice for a role nobody granted.
    const manifest = twoSourceManifest();
    manifest.sources[0] = {
      ...manifest.sources[0],
      kindLabels: {
        sell: "Shop GB sells for",
        cash: "Shop GB pays cash",
        active_median: "Shop GB median",
      },
    };
    const { id } = await importPlugin(manifest);
    await approve(id, { shop_gb: ["sell"] });

    const { registry } = await buildSourceRuntime(ctx!.db);
    expect(registry.get("shop_gb")?.kindRoles).toEqual({ sell: "buy_store" });
    expect(registry.get("shop_gb")?.kindLabels).toEqual({ sell: "Shop GB sells for" });
  });

  it("leaves a revoked kind's SHORT wording out of the registry, the same as the long one", async () => {
    // `kindLabelsShort` takes the same narrowing route as `kindLabels`, through
    // the same `effectiveKindLabels` call — see the registry's own comment on
    // why it must be pulled out of the spread rather than riding through in
    // `...rest`. A short word for a role nobody granted would still reach a
    // price table's listing row, which is the exact leak this closes.
    const manifest = twoSourceManifest();
    manifest.sources[0] = {
      ...manifest.sources[0],
      kindLabels: {
        sell: "Shop GB sells for",
        cash: "Shop GB pays cash",
        active_median: "Shop GB median",
      },
      kindLabelsShort: { sell: "asks", cash: "pays cash" },
    };
    const { id } = await importPlugin(manifest);
    await approve(id, { shop_gb: ["sell"] });

    const { registry } = await buildSourceRuntime(ctx!.db);
    expect(registry.get("shop_gb")?.kindRoles).toEqual({ sell: "buy_store" });
    expect(registry.get("shop_gb")?.kindLabelsShort).toEqual({ sell: "asks" });
  });

  it("makes a source a median source when its `active_median` role IS approved", async () => {
    // The other half of the previous assertion: the strategy follows the
    // EFFECTIVE roles, so it changes with what the user checked and with
    // nothing else the manifest says. Both halves of a median have to be
    // approved — the listings that go in and the median that comes out.
    const manifest = twoSourceManifest();
    manifest.sources[0] = {
      ...manifest.sources[0],
      kindRoles: { sell: "buy_store", active_median: "reference", active_listing: "buy_listing" },
      kindLabels: { sell: "Shop GB sells for", active_median: "Shop GB median", active_listing: "Shop GB listing" },
    };
    const { id } = await importPlugin(manifest);
    await approve(id, { shop_gb: ["sell", "active_median", "active_listing"] });
    const { adapters } = await buildSourceRuntime(ctx!.db);
    expect(adapters.find((a) => a.source === "shop_gb")?.snapshotStrategy).toBe(
      "median_of_listings",
    );
  });

  it("leaves a source with the median approved but the listings not on per_listing", async () => {
    // The narrowing decides the strategy, so unchecking `active_listing` at
    // approval takes the median away with it: the app will not aggregate rows
    // it was never allowed to receive as listings.
    const manifest = twoSourceManifest();
    manifest.sources[0] = {
      ...manifest.sources[0],
      kindRoles: { active_median: "reference", active_listing: "buy_listing" },
      kindLabels: { active_median: "Shop GB median", active_listing: "Shop GB listing" },
    };
    const { id } = await importPlugin(manifest);
    await approve(id, { shop_gb: ["active_median"] });
    const { adapters } = await buildSourceRuntime(ctx!.db);
    expect(adapters.find((a) => a.source === "shop_gb")?.snapshotStrategy).toBe("per_listing");
  });

  it("leaves a source approved for the listings alone on per_listing too", async () => {
    // The mirror of the case above, and the one `defaultCheckedKinds`
    // (PluginsPanel.tsx) actually produces by default: a `reference` kind is
    // unchecked on first review, so the form as offered approves
    // `active_listing` only. `snapshotStrategyFor` wants BOTH kinds, so half
    // the pair, either half, stores no median.
    const manifest = twoSourceManifest();
    manifest.sources[0] = {
      ...manifest.sources[0],
      kindRoles: { active_median: "reference", active_listing: "buy_listing" },
      kindLabels: { active_median: "Shop GB median", active_listing: "Shop GB listing" },
    };
    const { id } = await importPlugin(manifest);
    await approve(id, { shop_gb: ["active_listing"] });
    const { adapters } = await buildSourceRuntime(ctx!.db);
    const adapter = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
    expect(adapter.snapshotStrategy).toBe("per_listing");
    expect([...adapter.declaredKinds]).toEqual(["active_listing"]);
  });

  it("reports an approved plugin unconfigured until its health says otherwise", async () => {
    // No health has ever been recorded: the app has no evidence the plugin can
    // answer, and assuming it can would put a permanently failing block in a
    // game view.
    const { id } = await importPlugin(twoSourceManifest(), false);
    await approve(id, { shop_gb: ["sell"] });
    const { registry } = await buildSourceRuntime(ctx!.db);
    expect(registry.get("shop_gb")?.configured).toBe(false);
    // it is still a source of this deployment, though: it can be listed and
    // approved-of, it just cannot be enabled
    expect(registry.has("shop_gb")).toBe(true);
  });

  it("drops a disabled plugin's sources", async () => {
    // Disabling stops the app querying a plugin without deleting anything:
    // the row stays, and so do the prices already stored under its ids.
    const { id } = await importPlugin(twoSourceManifest());
    await approve(id, { shop_gb: ["sell"] });
    await ctx!.db.execute("UPDATE plugins SET status = 'disabled'");
    const { registry, adapters } = await buildSourceRuntime(ctx!.db);
    expect(registry.has("shop_gb")).toBe(false);
    expect(adapters.find((a) => a.source === "shop_gb")).toBeUndefined();
  });

  describe("a source approved with no kinds at all", () => {
    /**
     * Approval is per kind, so "approved with every box unchecked" is a real
     * state a screen can produce. Such a source can answer nothing: its
     * adapter's `declaredKinds` would be empty, so every price on every row
     * names an unapproved kind. Each price is dropped for want of consent
     * rather than condemning its row on sight, but a row stripped of every
     * price it arrived with is dropped whole all the same, and a batch in which
     * every row is dropped raises a protocol error against the plugin. Reporting it
     * `configured: true` and letting it be enabled would buy the user a market
     * that is silently, permanently empty. It is left out of the registry
     * instead.
     */
    it("is absent from the registry and has no adapter", async () => {
      const { id } = await importPlugin(twoSourceManifest());
      await approve(id, { shop_gb: [], shop_de: ["sell"] });
      const { registry, adapters } = await buildSourceRuntime(ctx!.db);
      expect(registry.has("shop_gb")).toBe(false);
      expect(registry.get("shop_gb")).toBeUndefined();
      expect(registry.byId.shop_gb).toBeUndefined();
      expect(adapters.find((a) => a.source === "shop_gb")).toBeUndefined();
      // one source's missing consent costs that source and no other
      expect(registry.get("shop_de")?.origin).toBe("plugin");
    });

    it("is absent when the approval record does not name it at all", async () => {
      // No record of an approval reads as nothing approved, which is the same
      // outcome by the same rule — consent is carried, never implied.
      const { id } = await importPlugin(twoSourceManifest());
      await approve(id, { shop_de: ["sell"] });
      const { registry } = await buildSourceRuntime(ctx!.db);
      expect(registry.has("shop_gb")).toBe(false);
    });
  });

  describe("a catalog-sync plugin source", () => {
    /** The same plugin, declaring its GB source as a swept catalogue. */
    const syncManifest = (schedule: SourceSchedule | undefined): PluginManifest => {
      const manifest = twoSourceManifest();
      manifest.sources[0] = {
        ...manifest.sources[0],
        kind: "sync",
        kindRoles: { sell: "buy_store", cash: "bid" },
        kindLabels: { sell: "Shop GB sells for", cash: "Shop GB pays cash" },
        ...(schedule === undefined ? {} : { schedule }),
      };
      return manifest;
    };

    it("gets a catalog capability on the manifest's own cadence, and searches the app's catalogue", async () => {
      const { id } = await importPlugin(syncManifest({ catalogCron: "0 4 * * *", trackedRefreshHours: 6 }));
      await approve(id, { shop_gb: ["sell", "cash"], shop_de: ["sell"] });
      const { adapters } = await buildSourceRuntime(ctx!.db);
      const adapter = adapters.find((a) => a.source === "shop_gb");
      expect(adapter).toBeInstanceOf(PluginCatalogAdapter);
      expect(adapter?.catalogSync?.schedule).toEqual({
        catalogCron: "0 4 * * *",
        trackedRefreshHours: 6,
      });
      // A sync source has no /search to be asked for (spec A.3): its search
      // reads catalog_items, which is empty here and says so rather than
      // reaching a plugin that does not serve the endpoint.
      await expect(adapter!.search("anything")).rejects.toBeInstanceOf(PluginCatalogEmptyError);
    });

    it("hands the adapter the region the MANIFEST declared, not a compiled-in guess", async () => {
      // The manifest carries `defaultRegion` for exactly this, and until it was
      // threaded through nothing read it: a plugin shop's region-less SKU
      // classified `unknown` where the identical CeX SKU classifies PAL, so the
      // two prices were never compared — the app compares per (game, region,
      // condition). Asserted through `buildSourceRuntime` rather than on the
      // adapter's constructor, because the wiring is the thing that was missing.
      const { id } = await importPlugin(syncManifest({ catalogCron: "0 4 * * *", trackedRefreshHours: 6 }));
      await approve(id, { shop_gb: ["sell", "cash"], shop_de: ["sell"] });
      const { adapters } = await buildSourceRuntime(ctx!.db);
      const adapter = adapters.find((a) => a.source === "shop_gb")!;
      const normalized = adapter.normalize({
        sourceProductId: "A1",
        title: "Legend of Zelda Ocarina of Time, w/ Manual, Boxed",
        categoryText: "N64 Games",
        prices: [{ kind: "sell", amount: 38, currency: "GBP" }],
        url: null,
      });
      expect(normalized.regionGuess).toBe("PAL");
    });

    it("leaves a LIVE source without one, so the worker never sweeps it", async () => {
      // The worker's whole live/sync distinction is the presence of this
      // field: a live plugin source that carried one would be swept for a
      // catalogue it has no endpoints for.
      const { id } = await importPlugin(twoSourceManifest());
      await approve(id, { shop_gb: ["sell"], shop_de: ["sell"] });
      const { adapters } = await buildSourceRuntime(ctx!.db);
      const adapter = adapters.find((a) => a.source === "shop_gb");
      expect(adapter).toBeInstanceOf(SidecarAdapter);
      expect(adapter?.catalogSync).toBeUndefined();
    });

    it("cannot even be approved, because a sync source with no cadence fails the whole manifest", async () => {
      // Since protocol 3 (spec R10) `schedule` is required on a sync source,
      // and the validator refuses the WHOLE document over it, not just the
      // one entry — the same all-or-nothing shape the "constructor" id case
      // below pins. So `manifestSeen` reads back null and `approvePlugin`
      // never gets far enough to let this plugin's sources — sync OR its live
      // sibling — anywhere near the registry. The app does not invent a
      // cadence either: that would be a sweep nobody chose, on someone else's
      // clock.
      const manifest = syncManifest(undefined);
      const { id } = await importPlugin(manifest);
      const stored = await getPlugin(ctx!.db, id);
      expect(stored?.manifestSeen).toBeNull();
      expect(
        await approvePlugin(
          ctx!.db,
          id,
          { shop_gb: ["sell", "cash"], shop_de: ["sell"] } as Parameters<typeof approvePlugin>[2],
          manifest,
        ),
      ).toEqual({ ok: false, reason: "no-manifest" });
      const { registry, adapters } = await buildSourceRuntime(ctx!.db);
      expect(registry.has("shop_gb")).toBe(false);
      expect(adapters.find((a) => a.source === "shop_gb")).toBeUndefined();
      // and its once-unaffected live sibling is gone too: the whole document
      // fails to read, so nothing this plugin declares reaches the registry.
      expect(registry.has("shop_de")).toBe(false);
    });

    /**
     * F1/F2/F6/F7 (whole-branch review, 2026-09-09): `snapshotStrategyFor`
     * keys on ROLE, not on eBay's kind names, but until this fix `kindRoles`
     * was passed only to `SidecarAdapter` — never to `PluginCatalogAdapter`.
     * A sync source declaring both a `buy_listing` and a `reference` role
     * (under any vocabulary, never eBay's) built a `median_of_listings`
     * adapter with no `kindRoles` to resolve either role from, and
     * `medianPointsFrom` threw on every game view of that source. This is
     * exactly the case the fix wires: kind names invented for this test,
     * never `active_median`/`active_listing`, so passing it could not be
     * confused with a name-based test.
     */
    it("gets kindRoles too, so a sync source with both aggregate roles can price a game instead of throwing", async () => {
      const manifest = twoSourceManifest();
      manifest.sources[0] = {
        ...manifest.sources[0],
        kind: "sync",
        kindRoles: { sell: "buy_listing", guide: "reference" },
        kindLabels: { sell: "Shop GB sells for", guide: "Shop GB guide price" },
        schedule: { catalogCron: "0 4 * * *", trackedRefreshHours: 6 },
      };
      const { id } = await importPlugin(manifest);
      await approve(id, { shop_gb: ["sell", "guide"], shop_de: ["sell"] });
      const { adapters } = await buildSourceRuntime(ctx!.db);
      const adapter = adapters.find((a) => a.source === "shop_gb") as PluginCatalogAdapter;
      expect(adapter).toBeInstanceOf(PluginCatalogAdapter);
      expect(adapter.snapshotStrategy).toBe("median_of_listings");
      // the exact map the strategy was derived from -- not `{}`, which is
      // what `adapter.kindRoles ?? {}` fed the throw before this fix
      expect(adapter.kindRoles).toEqual({ sell: "buy_listing", guide: "reference" });

      // Proving the wiring is not enough on its own -- prove the THROW this
      // finding is about no longer fires, and that pricing a game with this
      // adapter's own kindRoles produces real points.
      const listing: NormalizedListing = {
        sourceProductId: "A1",
        title: "Some Game",
        prices: [{ kind: "sell", amount: 20, currency: "GBP" }],
        url: null,
        cleanTitle: "some game",
        platformGuess: null,
        regionGuess: "PAL",
        conditionGuess: "cib",
      };
      expect(() =>
        medianPointsFrom("shop_gb", adapter.kindRoles, [listing], 1, new Date(), new Map([["GBP", 1]])),
      ).not.toThrow();
      const points = medianPointsFrom(
        "shop_gb",
        adapter.kindRoles,
        [listing],
        1,
        new Date(),
        new Map([["GBP", 1]]),
      );
      expect(points.some((p) => p.kind === "guide" && p.sampleSize === 1)).toBe(true);
      expect(points.some((p) => p.kind === "sell" && p.priceOriginal === "20")).toBe(true);
    });
  });

  it("gives a colliding id to the plugin approved FIRST, not the newest", async () => {
    // Two approved plugins declaring one source id. The import flow will
    // refuse that up front once it exists; a hand-written row can carry it
    // today, so the read path has to decide. `listPlugins` returns newest
    // first, so without the approval ordering the LATER plugin would silently
    // take over a source the user had already approved and enabled.
    const first = await importPlugin(twoSourceManifest(), true, "http://first:8000");
    await approve(first.id, { shop_gb: ["sell"], shop_de: ["sell"] });

    const later = twoSourceManifest();
    later.sources = [{ ...later.sources[0], label: "Impostor GB" }];
    const second = await importPlugin(later, true, "http://second:8000");
    await approve(second.id, { shop_gb: ["cash"] });

    const { registry, adapters } = await buildSourceRuntime(ctx!.db);
    expect(registry.get("shop_gb")?.pluginId).toBe(first.id);
    expect(registry.get("shop_gb")?.label).toBe("Shop GB");
    // and the id is served once, by one adapter, whichever plugin lost it
    expect(registry.sources.filter((s) => s.id === "shop_gb")).toHaveLength(1);
    expect(adapters.filter((a) => a.source === "shop_gb")).toHaveLength(1);
  });

  describe("a source id spelled like an Object.prototype member", () => {
    /**
     * `byId` is keyed by source id, and a source id is a string a plugin
     * chose. On a plain object `byId.constructor` is a function — truthy — so
     * `has(id)` written as a truthiness test, or a `byId` built as `{}`, would
     * report a source this deployment does not have, and hand a caller a
     * function where it expected a SourceInfo.
     *
     * There are TWO independent defences and they are pinned separately,
     * because either one alone makes the app answer correctly and a test that
     * only asks the registry a question therefore holds down only the first:
     *   - the map is built with `Object.create(null)`, so nothing is inherited
     *     to find. That is what the first two tests below observe, the second
     *     of them through `byId` directly (`has`/`get` would keep answering
     *     `false` on a plain object anyway, so the map's own reading is the
     *     only place a lost null prototype shows);
     *   - `has`/`get` use `Object.hasOwn` rather than truthiness, so the
     *     answer does not DEPEND on the null prototype. No code path in this
     *     app can give `byId` a prototype today — it is created and sealed
     *     inside `buildSourceRuntime` — so the last test plants one itself.
     *     That is the future change the guard is defence in depth against,
     *     made locally; it is honest about being arranged rather than
     *     reachable.
     *
     * This is asserted here rather than assumed from the two gates upstream
     * (the manifest validator, and the repository's read of `approved_kinds`),
     * on the principle that a guard in another module is not a guarantee about
     * this one: those gates were each written because the previous one lived
     * somewhere else.
     */
    it("answers no for it while no plugin declares it", async () => {
      const { registry } = await buildSourceRuntime(ctx!.db);
      for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
        expect(registry.has(id), id).toBe(false);
        expect(registry.get(id), id).toBeUndefined();
        expect(registry.byId[id], id).toBeUndefined();
      }
    });

    it("hands out a map with no prototype at all", async () => {
      // The first defence, stated as the structural fact it is rather than
      // inferred from a lookup: `byId` is passed WHOLE to the shared helpers
      // (`admitsCopyPoint`, `buildSignalInputs`, `computeSignals`), which index
      // it directly and never go through `has`/`get`, so the map itself has to
      // be safe to index.
      const { registry } = await buildSourceRuntime(ctx!.db);
      expect(Object.getPrototypeOf(registry.byId)).toBeNull();
    });

    it("answers no through has/get even if the map is given a prototype", async () => {
      // The second defence, on its own. `has` and `get` close over this very
      // object, so planting a prototype on it here IS the future change they
      // are written against — a `byId` assembled some other way, restored from
      // a plain object, or handed through a layer that copied it. With
      // `Object.hasOwn` the answer does not move; a truthiness test would
      // start reporting `constructor` as a source of this deployment and hand
      // its caller a function.
      const { id } = await importPlugin(twoSourceManifest());
      await approve(id, { shop_gb: ["sell"] });
      const { registry } = await buildSourceRuntime(ctx!.db);
      Object.setPrototypeOf(registry.byId, Object.prototype);
      for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
        expect(registry.has(key), key).toBe(false);
        expect(registry.get(key), key).toBeUndefined();
      }
      // and it is not answering no to everything: an approved plugin's source
      // still resolves.
      expect(registry.has("shop_gb")).toBe(true);
      expect(registry.get("shop_gb")?.id).toBe("shop_gb");
    });

    it("cannot be reached through a stored row either, because the manifest is refused on read", async () => {
      // Belt and braces, and worth pinning because it is the reason the case
      // above is the only one the registry can actually meet: a manifest
      // declaring such an id fails `validateManifest`, so the repository reads
      // the column as null (naming the field in a warning) and the plugin
      // cannot even be approved. Should that ever change, this test says so
      // and the one above still holds the registry's own end up.
      const manifest = twoSourceManifest();
      manifest.sources[0] = { ...manifest.sources[0], id: "constructor" };
      const row = await insertPlugin(ctx!.db, {
        baseUrl: "http://shop:8000",
        name: "shop",
        version: "1.0.0",
        manifestSeen: manifest,
      });
      const stored = await getPlugin(ctx!.db, row.id);
      expect(stored?.manifestSeen).toBeNull();
      expect(await approvePlugin(ctx!.db, row.id, {}, manifest)).toEqual({
        ok: false,
        reason: "no-manifest",
      });
      const { registry } = await buildSourceRuntime(ctx!.db);
      expect(registry.has("constructor")).toBe(false);
    });
  });

  describe("one limiter and one breaker per plugin", () => {
    /**
     * The whole reason a plugin may serve several sources. A plugin is ONE
     * process behind ONE base URL: pacing it per source would multiply the
     * request rate by the number of sources it declares, and a breaker per
     * source would keep calling a process already known to be unwell.
     */
    it("gives both sources of one plugin the same instances", async () => {
      const { id } = await importPlugin(twoSourceManifest());
      await approve(id, { shop_gb: ["sell"], shop_de: ["sell"] });
      const { adapters } = await buildSourceRuntime(ctx!.db);
      const gb = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
      const de = adapters.find((a) => a.source === "shop_de") as SidecarAdapter;
      // identity, not existence: two limiters that merely both exist would
      // pace this plugin twice
      expect(gb.limiter).toBe(de.limiter);
      expect(gb.breaker).toBe(de.breaker);
    });

    it("paces a call to one source behind a call to the other, once", async () => {
      // The property the shared instance is FOR, measured rather than
      // inferred: two calls to two sources of one plugin are separated by ONE
      // gap of the configured pace, instead of leaving together as they would
      // if each source had a limiter of its own. It costs the suite that one
      // gap (SIDECAR_RATE_LIMIT_MS, 3 s by default) and is the only test here
      // that spends real time.
      expect(config.SIDECAR_RATE_LIMIT_MS).toBeGreaterThan(0);
      const { id } = await importPlugin(twoSourceManifest());
      await approve(id, { shop_gb: ["sell"], shop_de: ["sell"] });
      const { adapters } = await buildSourceRuntime(ctx!.db);
      const gb = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
      const de = adapters.find((a) => a.source === "shop_de") as SidecarAdapter;

      const starts: number[] = [];
      const spy = async (): Promise<void> => {
        starts.push(Date.now());
      };
      const began = Date.now();
      // straight through the shared limiter, so this measures the pacing and
      // not the HTTP client
      await Promise.all([gb.limiter.schedule(spy), de.limiter.schedule(spy)]);
      expect(starts).toHaveLength(2);
      // setTimeout may fire a millisecond early; the tolerance is about the
      // timer, not about the pace
      expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(config.SIDECAR_RATE_LIMIT_MS - 25);
      // and the FIRST call waits for nothing: the pace is between calls
      expect(starts[0] - began).toBeLessThan(config.SIDECAR_RATE_LIMIT_MS);
    }, 30_000);
  });
});
