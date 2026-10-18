import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginManifest, PriceKind } from "@retrowatchdog/shared";
// Type-only, so it is erased and cannot pull `config.ts` into this module
// before the env vars below are set. Same reason, same shape, as
// test/sources/pluginPacing.test.ts:5-7.
import type { RateLimiter } from "../../src/lib/rateLimiter.js";
import type { SidecarAdapter } from "../../src/adapters/sidecar/index.js";

/**
 * A plugin's PACE, proved on real elapsed time rather than by reading a
 * private field: `RateLimiter.minIntervalMs` (lib/rateLimiter.ts)
 * has no accessor, so this measures the same way
 * test/sources/registry.test.ts's own "paces a call to one source behind a
 * call to the other, once" already does — `Date.now()` pushed from inside
 * `limiter.schedule`. That file spends the full `SIDECAR_RATE_LIMIT_MS`
 * (3 s) doing this; the two paces here are set small, for THIS file's own
 * module registry only, so the whole file costs a few hundred milliseconds.
 *
 * There is no `withConfig` anywhere in this codebase, and none could exist:
 * `config.ts` parses `process.env` once at module load
 * (`envSchema.parse(process.env)`). So both vars below are set before the
 * dynamic import that follows, and every test in this file shares ONE frozen
 * config — the shape test/sources/pluginPacing.test.ts:5-42 already uses and
 * states its own reason for.
 *
 * This file drives a fictional two-source plugin (`shop_gb`, `shop_fr`) at
 * `SHOP_URL` rather than a real market. The real eBay arithmetic it guards: one limiter per plugin at the 3000 ms global default, serialised,
 * with the wait sitting INSIDE the promise the pricing service races against
 * ADAPTER_TIMEOUT_MS (8000 ms) — five sources behind one plugin start at
 * 0/3/6/9/12 s, so the fourth and fifth can never answer, on every game
 * view.
 */
const GLOBAL_PACE_MS = 200;
const ROW_PACE_MS = 50;
const SHOP_URL = "http://shop:8000";
const OTHER_URL = "http://other:8000";
const SNEAKY_URL = "http://sneaky:8000";

const previousEnv = { pace: process.env.SIDECAR_RATE_LIMIT_MS };
process.env.SIDECAR_RATE_LIMIT_MS = String(GLOBAL_PACE_MS);

const { buildSourceRuntime } = await import("../../src/sources/registry.js");
const { approvePlugin, insertPlugin, listPlugins, setPluginPace } = await import(
  "../../src/plugins/repo.js"
);
const { sql } = await import("drizzle-orm");
const { setupTestDb } = await import("../helpers/testDb.js");

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

/** Two sources behind ONE base URL — the case one shared limiter exists for. */
const shopManifest = (): PluginManifest => ({
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
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["GBP"],
      kindRoles: { active_listing: "buy_listing" },
      kindLabels: { active_listing: "Shop GB listing" },
    },
    {
      id: "shop_fr",
      kind: "live",
      label: "Shop FR",
      family: "shop",
      familyLabel: "Shop",
      country: "FR",
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["EUR"],
      kindRoles: { active_listing: "buy_listing" },
      kindLabels: { active_listing: "Shop FR listing" },
    },
  ],
});

/** One source, at a base URL nobody set a pace for. */
const oneSourceManifest = (name: string, sourceId: string): PluginManifest => ({
  protocol: 2,
  plugin: { name, version: "1.0.0" },
  requiredSecrets: [],
  sources: [
    {
      id: sourceId,
      kind: "live",
      label: `${name} GB`,
      family: name,
      familyLabel: name,
      country: "GB",
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["GBP"],
      kindRoles: { active_listing: "buy_listing" },
      kindLabels: { active_listing: `${name} GB listing` },
    },
  ],
});

/** Import and approve exactly the manifest given, at the base URL given. */
async function approvedPlugin(manifest: PluginManifest, baseUrl: string): Promise<void> {
  const row = await insertPlugin(ctx!.db, {
    baseUrl,
    name: manifest.plugin.name,
    version: manifest.plugin.version,
    manifestSeen: manifest,
    lastHealth: { status: "ok", protocol: 2, configured: true },
  });
  const approvedKinds: Record<string, PriceKind[]> = {};
  for (const source of manifest.sources) {
    approvedKinds[source.id] = Object.keys(source.kindRoles) as PriceKind[];
  }
  const result = await approvePlugin(ctx!.db, row.id, approvedKinds, manifest);
  expect(result).toEqual({ ok: true });
}

/**
 * Two scheduled calls issued together through one limiter; the gap between
 * their actual starts is the limiter's configured pace, measured rather than
 * assumed — the first call never waits, so only the gap is informative.
 */
async function measuredGapMs(limiter: RateLimiter): Promise<number> {
  const starts: number[] = [];
  const mark = async (): Promise<void> => {
    starts.push(Date.now());
  };
  await Promise.all([limiter.schedule(mark), limiter.schedule(mark)]);
  return starts[1] - starts[0];
}

describe.skipIf(ctx === null)("a plugin's pace, per plugin and from the operator alone", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => {
    if (previousEnv.pace === undefined) delete process.env.SIDECAR_RATE_LIMIT_MS;
    else process.env.SIDECAR_RATE_LIMIT_MS = previousEnv.pace;
    await ctx?.pool.end();
  });

  it("takes the pace the operator set on this plugin's row", async () => {
    // The `rate_limit_ms` column, set in Settings -> Plugins, is the most
    // specific thing the operator said and the only one visible from the screen
    // it governs. A SIDECAR_RATE_LIMIT_OVERRIDES env var used to sit between it
    // and the default; it was backfilled into this column and then deleted,
    // because the number deciding whether four of five markets answered at all
    // lived in a gitignored file nobody could see.
    await approvedPlugin(shopManifest(), SHOP_URL);
    const [row] = await listPlugins(ctx!.db);
    await setPluginPace(ctx!.db, row!.id, ROW_PACE_MS);
    const { adapters } = await buildSourceRuntime(ctx!.db, [], new Map());
    const shopGb = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
    const gap = await measuredGapMs(shopGb.limiter);
    // setTimeout may fire a little late, never meaningfully early; the
    // tolerance is about the timer, not about the pace (registry.test.ts
    // uses the same -25 tolerance at the real 3000 ms default).
    expect(gap).toBeGreaterThanOrEqual(ROW_PACE_MS - 25);
    // and it is the ROW that fired here, not the global default this file set
    // -- the two are 4x apart, so a mix-up cannot hide inside the slop
    expect(gap).toBeLessThan(GLOBAL_PACE_MS);
  }, 10_000);

  it("shares ONE limiter across every source the plugin serves", async () => {
    // A pace changes the gap, never the sharing: pacing per source would
    // multiply the request rate by the number of sources declared --
    // the multiplication sources/registry.ts exists to prevent.
    await approvedPlugin(shopManifest(), SHOP_URL);
    const { adapters } = await buildSourceRuntime(ctx!.db, [], new Map());
    const shopGb = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
    const shopFr = adapters.find((a) => a.source === "shop_fr") as SidecarAdapter;
    expect(shopGb.limiter).toBe(shopFr.limiter);
  });

  it("falls back to the deployment default when the row's pace is cleared", async () => {
    // Null means "no opinion", never a number. Storing whatever the fallback
    // resolves to would freeze it, so a later change to the deployment default
    // would silently not apply to any row that had ever been set back to auto.
    await approvedPlugin(shopManifest(), SHOP_URL);
    const [row] = await listPlugins(ctx!.db);
    await setPluginPace(ctx!.db, row!.id, ROW_PACE_MS);
    await setPluginPace(ctx!.db, row!.id, null);

    const { adapters } = await buildSourceRuntime(ctx!.db, [], new Map());
    const shopGb = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
    const gap = await measuredGapMs(shopGb.limiter);
    expect(gap).toBeGreaterThanOrEqual(GLOBAL_PACE_MS - 25);
  }, 10_000);

  it("reads a stored pace of zero as no pace at all", async () => {
    // `RateLimiter` waits only while `wait > 0`, so a 0 left by a hand-edit,
    // an older build or a restored backup would not mean "no pacing
    // configured" — it would mean every call goes out with no gap, which is
    // the opposite of what the column is for. It is read as null, which puts
    // the row back on the deployment's own default.
    await approvedPlugin(shopManifest(), SHOP_URL);
    const [row] = await listPlugins(ctx!.db);
    await ctx!.db.execute(
      sql`update plugins set rate_limit_ms = 0 where id = ${row!.id}`,
    );

    const [reread] = await listPlugins(ctx!.db);
    expect(reread!.rateLimitMs).toBeNull();
    const { adapters } = await buildSourceRuntime(ctx!.db, [], new Map());
    const shopGb = adapters.find((a) => a.source === "shop_gb") as SidecarAdapter;
    const gap = await measuredGapMs(shopGb.limiter);
    expect(gap).toBeGreaterThanOrEqual(GLOBAL_PACE_MS - 25);
  }, 10_000);

  it("gives a plugin nobody set a pace for the deployment default", async () => {
    await approvedPlugin(oneSourceManifest("other", "other_gb"), OTHER_URL);
    const { adapters } = await buildSourceRuntime(ctx!.db, [], new Map());
    const otherGb = adapters.find((a) => a.source === "other_gb") as SidecarAdapter;
    const gap = await measuredGapMs(otherGb.limiter);
    expect(gap).toBeGreaterThanOrEqual(GLOBAL_PACE_MS - 25);
  }, 10_000);

  it("cannot be set by a manifest", async () => {
    // The values come from config and from nowhere else: a plugin cannot ask
    // to be called faster than every other one. There is no `rateLimitMs`
    // field on a manifest source at all (`PluginManifestSource` extends
    // `SourceInfo`, packages/shared/src/pluginManifest.ts:68), and even a
    // proposal that invents one cannot survive to be served: `parseSource`
    // reads its known fields one at a time and constructs a fresh object
    // from them — "rebuilt, never spread"
    // (packages/shared/src/pluginManifest.ts:558-577) — so an extra field
    // is silently absent from the document `validateManifest` returns, on
    // every read of the `manifest` column (`asManifest` in plugins/repo.ts).
    //
    // This plants the hint directly in that column, bypassing
    // `approvePlugin`'s own write path entirely — the worst case the
    // read-time validator has to defend against: a row hand-edited, restored
    // from a backup, or written by a build older than this rule
    // (plugins/repo.ts:135-137 names exactly this case).
    await approvedPlugin(oneSourceManifest("sneaky", "sneaky_gb"), SNEAKY_URL);
    const tainted = oneSourceManifest("sneaky", "sneaky_gb");
    (tainted.sources[0] as unknown as Record<string, unknown>).rateLimitMs = 1;
    const escaped = JSON.stringify(tainted).replace(/'/g, "''");
    await ctx!.db.execute(`UPDATE plugins SET manifest = '${escaped}'::jsonb WHERE base_url = '${SNEAKY_URL}'`);

    const { adapters } = await buildSourceRuntime(ctx!.db, [], new Map());
    const sneakyGb = adapters.find((a) => a.source === "sneaky_gb") as SidecarAdapter;
    const gap = await measuredGapMs(sneakyGb.limiter);
    // proof the hint had no effect: the pace is the plain global default
    // (SNEAKY_URL has no override), not the 1 ms the tainted manifest tried
    // to claim
    expect(gap).toBeGreaterThanOrEqual(GLOBAL_PACE_MS - 25);
  }, 10_000);
});
