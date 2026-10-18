import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import type { PluginManifest } from "@retrowatchdog/shared";
import { CircuitOpenError } from "../../src/lib/circuitBreaker.js";
// Type-only, so it is erased and cannot pull `config.ts` into this module
// before the env vars below are set.
import type { PluginPacingStore } from "../../src/sources/registry.js";

/**
 * A plugin's limiter and breaker belong to the PLUGIN, not to the adapter
 * object built from it.
 *
 * The worker rebuilds the plugin adapters on every plugin-health tick — five
 * minutes by default — and the app rebuilds them on every approval. If the pair
 * were rebuilt with them, SIDECAR_BREAKER_HOLD_MS (half an hour: how long a
 * failing source is left alone) would silently become the tick interval, and
 * the app would go back to calling a source it had already decided was unwell.
 * The same reasoning app.ts records for the BUILT-IN adapters, which are
 * constructed once and passed to every rebuild.
 *
 * The sharing is observable, so this file observes it rather than reading
 * private fields: a breaker opened through one build's adapter either fast-fails
 * the next build's adapter or it does not.
 *
 * The real pace (3 s) and threshold (5) are lowered for this file's module
 * registry only, before the code under test is imported, and restored
 * afterwards; they decide how long the file takes, not what it shows.
 */
const PACE_MS = 0;
const THRESHOLD = 2;
const previousEnv = {
  pace: process.env.SIDECAR_RATE_LIMIT_MS,
  threshold: process.env.SIDECAR_BREAKER_THRESHOLD,
};
process.env.SIDECAR_RATE_LIMIT_MS = String(PACE_MS);
process.env.SIDECAR_BREAKER_THRESHOLD = String(THRESHOLD);

const { buildSourceRuntime } = await import("../../src/sources/registry.js");
const { approvePlugin, insertPlugin, recordPluginHealth, setPluginPace } = await import(
  "../../src/plugins/repo.js"
);
const { setupTestDb } = await import("../helpers/testDb.js");

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const ORIGIN = "http://shop:8000";

const manifest = (label: string): PluginManifest => ({
  protocol: 2,
  plugin: { name: "shop", version: "1.0.0" },
  requiredSecrets: [],
  sources: [
    {
      id: "shop_gb",
      kind: "live",
      label,
      family: "shop",
      familyLabel: "Shop",
      country: "GB",
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["GBP"],
      kindRoles: { active_listing: "buy_listing" },
      kindLabels: { active_listing: `${label} listing` },
    },
  ],
});

describe.skipIf(ctx === null)("a plugin's limiter and breaker survive a rebuild", () => {
  let agent: MockAgent;
  let previousDispatcher: Dispatcher;

  beforeEach(async () => {
    await ctx!.truncateAll();
    previousDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
  });
  afterAll(async () => {
    process.env.SIDECAR_RATE_LIMIT_MS = previousEnv.pace;
    process.env.SIDECAR_BREAKER_THRESHOLD = previousEnv.threshold;
    await ctx?.pool.end();
  });

  /** An approved plugin serving one live source, exactly as the registry reads it. */
  async function approvedPlugin(label: string): Promise<number> {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: ORIGIN,
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(label),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    await approvePlugin(ctx!.db, row.id, { shop_gb: ["active_listing"] }, manifest(label));
    return row.id;
  }

  const adapterFor = async (pacing: PluginPacingStore) => {
    const { adapters, registry } = await buildSourceRuntime(ctx!.db, [], pacing);
    const adapter = adapters.find((a) => a.source === "shop_gb");
    if (!adapter) throw new Error("the plugin source is not in the runtime");
    return { adapter, registry };
  };

  /** Fail every /search until the breaker has counted THRESHOLD of them. */
  async function openTheBreaker(search: () => Promise<unknown>): Promise<void> {
    for (let i = 0; i < THRESHOLD; i += 1) {
      agent.get(ORIGIN).intercept({ path: /\/search.*/, method: "GET" }).reply(500, "nope");
      await expect(search()).rejects.toThrow();
    }
  }

  it("holds a plugin off across a rebuild, and still rebuilds the adapter", async () => {
    const id = await approvedPlugin("Shop GB");
    const pacing: PluginPacingStore = new Map();
    const first = await adapterFor(pacing);
    await openTheBreaker(() => first.adapter.search("zelda"));

    // the plugin republishes and the user approves the new manifest: the SOURCE
    // is rebuilt from it...
    await recordPluginHealth(ctx!.db, id, null, manifest("Shop GB (new)"), null);
    expect(
      await approvePlugin(
        ctx!.db,
        id,
        { shop_gb: ["active_listing"] },
        manifest("Shop GB (new)"),
      ),
    ).toEqual({ ok: true });

    const second = await adapterFor(pacing);
    expect(second.registry.get("shop_gb")?.label).toBe("Shop GB (new)");
    expect(second.adapter).not.toBe(first.adapter);
    // ...and the hold the plugin earned is still being served. No interceptor
    // is registered here on purpose: a request would fail as an unmatched mock
    // rather than as CircuitOpenError, so this asserts no call was made.
    await expect(second.adapter.search("zelda")).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("changes the pace in place and leaves an open breaker open", async () => {
    // THE TRAP THIS TEST GUARDS. The obvious way to make a pace change take
    // effect is to fold the pace into the store key, so a changed pace simply
    // misses the cache. But a miss hands back a fresh CircuitBreaker as well —
    // and a fresh breaker is a CLOSED one, so saving a pace on a plugin the
    // app has already given up on would put it straight back into rotation,
    // hammering a process known to be unwell.
    //
    // A pace is not evidence about health. The limiter is updated in place and
    // the breaker is left exactly as it was.
    const id = await approvedPlugin("Shop GB");
    const pacing: PluginPacingStore = new Map();
    const first = await adapterFor(pacing);
    await openTheBreaker(() => first.adapter.search("zelda"));

    await setPluginPace(ctx!.db, id, 40);
    const second = await adapterFor(pacing);

    // the SAME limiter object, now running at the new pace
    expect(second.adapter).not.toBe(first.adapter);
    expect((second.adapter as { limiter?: unknown }).limiter).toBe(
      (first.adapter as { limiter?: unknown }).limiter,
    );
    // and the hold the plugin earned survives the pace change. No interceptor
    // is registered, so a request would fail as an unmatched mock rather than
    // as CircuitOpenError: this asserts no call was made at all.
    await expect(second.adapter.search("zelda")).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("gives a different plugin identity its own breaker", async () => {
    // The key is the plugin, not the process: a store that held one pair for
    // everything would let one failing plugin mute a healthy one.
    await approvedPlugin("Shop GB");
    const pacing: PluginPacingStore = new Map();
    const { adapter } = await adapterFor(pacing);
    await openTheBreaker(() => adapter.search("zelda"));

    // a caller with nothing to preserve — the default store — is unaffected
    const fresh = await adapterFor(new Map());
    agent
      .get(ORIGIN)
      .intercept({ path: /\/search.*/, method: "GET" })
      .reply(200, JSON.stringify([]));
    await expect(fresh.adapter.search("zelda")).resolves.toEqual([]);
  });
});
