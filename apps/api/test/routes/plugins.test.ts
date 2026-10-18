import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { eq } from "drizzle-orm";
import type {
  MarketSettingsResponse,
  PluginDto,
  PluginsResponse,
  SourcesResponse,
} from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { buildApp } from "../../src/app.js";
import { approvalRefusal } from "../../src/routes/plugins.js";
import { getPlugin, insertPlugin, recordPluginHealth } from "../../src/plugins/repo.js";
import { loadEnabledSources, saveEnabledSources } from "../../src/settings/markets.js";
import { catalogItems, games, plugins, pricePoints, sourceMappings } from "../../src/db/schema.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const BASE = "http://shop:8000";
const OTHER = "http://other:8000";

const okHealth = { status: "ok", protocol: 2, configured: true };

type Json = Record<string, unknown>;

/** A manifest that passes `validateManifest`, so a test differs in ONE field. */
function manifestBody(): Json {
  return {
    protocol: 3,
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
  };
}

const withSource = (mutate: (source: Json) => void): Json => {
  const body = manifestBody();
  mutate((body.sources as Json[])[0]);
  return body;
};

describe.skipIf(ctx === null)("the plugin endpoints", () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(async () => {
    await ctx!.truncateAll();
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });
  afterAll(async () => ctx?.pool.end());

  // A stub adapter, so no test depends on the machine holding real
  // credentials. eBay's markets answer through the seeded plugin above.
  const app = async () =>
    buildApp({
      db: ctx!.db,
      registry: [stubAdapter({ source: "cex" })],
    });

  const stubPlugin = (
    base: string,
    answers: { health?: Json; manifest?: Json } = {},
  ): void => {
    agent
      .get(base)
      .intercept({ path: "/health", method: "GET" })
      .reply(200, answers.health ?? okHealth);
    agent
      .get(base)
      .intercept({ path: "/manifest", method: "GET" })
      .reply(200, answers.manifest ?? manifestBody());
  };

  type App = Awaited<ReturnType<typeof buildApp>>;

  const post = async (instance: App, url: string, payload: unknown) =>
    instance.inject({ method: "POST", url, payload: payload as Json });

  const listPluginDtos = async (instance: App): Promise<PluginDto[]> => {
    const res = await instance.inject({ method: "GET", url: "/api/plugins" });
    expect(res.statusCode).toBe(200);
    return (res.json() as PluginsResponse).plugins;
  };

  const sourceIds = async (instance: App): Promise<string[]> => {
    const res = await instance.inject({ method: "GET", url: "/api/sources" });
    expect(res.statusCode).toBe(200);
    return (res.json() as SourcesResponse).sources.map((s) => s.id);
  };

  const markets = async (instance: App): Promise<MarketSettingsResponse> => {
    const res = await instance.inject({ method: "GET", url: "/api/settings/markets" });
    expect(res.statusCode).toBe(200);
    return res.json() as MarketSettingsResponse;
  };

  /** Import one plugin and return its row id. */
  const importPlugin = async (instance: App, base = BASE, manifest?: Json): Promise<number> => {
    stubPlugin(base, manifest ? { manifest } : {});
    const res = await post(instance, "/api/plugins", { baseUrl: base });
    expect(res.statusCode).toBe(201);
    return (res.json() as { plugin: PluginDto }).plugin.id;
  };

  /**
   * The fingerprint the API is serving for this plugin RIGHT NOW, read the way
   * a panel reads it. Every ordinary approval below goes through this, so no
   * test invents the value the guard checks.
   */
  const servedFingerprint = async (instance: App, id: number): Promise<string> => {
    const plugin = (await listPluginDtos(instance)).find((p) => p.id === id);
    expect(plugin?.manifestFingerprint).toEqual(expect.any(String));
    return plugin!.manifestFingerprint!;
  };

  /** Approve, sending back the fingerprint the listing served for this plugin. */
  const approve = async (
    instance: App,
    id: number,
    approvedKinds: Record<string, string[]>,
  ) =>
    post(instance, `/api/plugins/${id}/approve`, {
      approvedKinds,
      reviewedFingerprint: await servedFingerprint(instance, id),
    });

  describe("POST /api/plugins", () => {
    it("imports a reachable plugin as pending, and pending is not in the registry", async () => {
      const instance = await app();
      stubPlugin(BASE);
      const res = await post(instance, "/api/plugins", { baseUrl: "http://shop:8000/" });
      expect(res.statusCode).toBe(201);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.status).toBe("pending");
      // the trailing slash is the one thing normalizeBaseUrl collapses
      expect(plugin.baseUrl).toBe(BASE);
      expect(plugin.name).toBe("shop");
      expect(plugin.version).toBe("1.0.0");
      expect(plugin.configured).toBe(true);
      expect(plugin.drift).toEqual([]);
      expect(plugin.lastError).toBeNull();
      expect(plugin.lastHealthAt).not.toBeNull();
      expect(plugin.sources.map((s) => s.id)).toEqual(["shop_gb"]);
      // the review screen sees what the manifest DECLARED and what has been
      // approved of it, which on an import is nothing
      expect(plugin.sources[0].kindRoles).toEqual({ sell: "buy_store", cash: "bid" });
      expect(plugin.sources[0].approvedKinds).toEqual([]);
      expect(await sourceIds(instance)).not.toContain("shop_gb");
    });

    it("reads health as evidence, never as an assumption", async () => {
      const instance = await app();
      // a plugin that answers health without claiming it holds what it needs
      stubPlugin(BASE, { health: { status: "ok", protocol: 2 } });
      const res = await post(instance, "/api/plugins", { baseUrl: BASE });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { plugin: PluginDto }).plugin.configured).toBe(false);
    });

    it("stores nothing when the manifest is refused, and says which field", async () => {
      const instance = await app();
      stubPlugin(BASE, { manifest: { ...manifestBody(), protocol: 1 } });
      const res = await post(instance, "/api/plugins", { baseUrl: BASE });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/protocol 1.*requires 3/i);
      expect(await listPluginDtos(instance)).toEqual([]);
    });

    it("names the field for a NUL in a label, instead of dying in the insert", async () => {
      // `plugins.manifest_seen` is jsonb and Postgres refuses a NUL inside
      // one, so a manifest carrying one used to pass every field rule, reach
      // `insertPlugin` and come back as Fastify's bare "Internal Server
      // Error" — on the one screen whose whole contract is that a refusal
      // names the field to fix. Built from a code point: pasted literally, the
      // byte would corrupt this file.
      const instance = await app();
      const nul = String.fromCharCode(0);
      stubPlugin(BASE, { manifest: withSource((s) => { s.label = `Shop${nul} GB`; }) });
      const res = await post(instance, "/api/plugins", { baseUrl: BASE });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/sources\[0\]\.label/);
      expect(await listPluginDtos(instance)).toEqual([]);
    });

    it("refuses an id an APPROVED plugin owns, naming that plugin by NAME", async () => {
      // spec Part D: "rejected naming the id and its current owner (built-in
      // or plugin name)". The row id rides along because two plugins may carry
      // one name, and then the name alone does not say which row to open.
      const instance = await app();
      const first = await importPlugin(instance, BASE);
      expect((await approve(instance, first, { shop_gb: ["sell"] })).statusCode).toBe(200);

      stubPlugin(OTHER);
      const res = await post(instance, "/api/plugins", { baseUrl: OTHER });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe(
        `shop_gb is already served by another plugin (shop, id ${first})`,
      );
    });

    it("lets two PENDING plugins claim one id, and refuses the second approval", async () => {
      // The import check consults the REGISTRY, which holds approved sources
      // only — so the collision is real at the moment it would take effect,
      // not at the moment a second author happened to pick the same name.
      const instance = await app();
      const first = await importPlugin(instance, BASE);
      const second = await importPlugin(instance, OTHER);
      expect((await approve(instance, first, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const res = await approve(instance, second, { shop_gb: ["sell"] });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/shop_gb is already served by another plugin/);
      expect((await getPlugin(ctx!.db, second))!.status).toBe("pending");
    });

    /**
     * The collision carve-out is over what this plugin SERVES, not over what
     * its `manifest` column names, and these two are the ways those differ.
     *
     * Both end the same way if the carve-out is read off the column: two rows
     * approved for one id, no message anywhere, and the id handed to whichever
     * was approved longer ago — so an ordinary later re-approval of the other
     * moves a live market to a different container.
     */
    it("refuses re-approving an id another plugin took while this one served none", async () => {
      // Approved for NO kind: `sources/registry.ts` drops such a source, so
      // the row's manifest names shop_gb and the registry does not serve it.
      const instance = await app();
      const first = await importPlugin(instance, BASE);
      expect((await approve(instance, first, { shop_gb: [] })).statusCode).toBe(200);
      expect(await sourceIds(instance)).not.toContain("shop_gb");

      const second = await importPlugin(instance, OTHER);
      expect((await approve(instance, second, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const res = await approve(instance, first, { shop_gb: ["sell"] });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe(
        `shop_gb is already served by another plugin (shop, id ${second})`,
      );
      // and the id still belongs to the plugin that was approved for it
      const shopGb = (await instance.inject({ method: "GET", url: "/api/sources" }).then((r) =>
        (r.json() as SourcesResponse).sources.find((s) => s.id === "shop_gb"),
      ))!;
      expect(shopGb.pluginId).toBe(second);
    });

    it("refuses re-approving an id another plugin took while this one was disabled", async () => {
      // `setPluginStatus` writes `status` and nothing else, so a disabled
      // plugin keeps its approved manifest whole while serving nothing.
      const instance = await app();
      const first = await importPlugin(instance, BASE);
      expect((await approve(instance, first, { shop_gb: ["sell"] })).statusCode).toBe(200);
      expect((await post(instance, `/api/plugins/${first}/disable`, {})).statusCode).toBe(200);
      expect((await getPlugin(ctx!.db, first))!.manifest?.sources.map((s) => s.id)).toEqual([
        "shop_gb",
      ]);

      const second = await importPlugin(instance, OTHER);
      expect((await approve(instance, second, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const res = await approve(instance, first, { shop_gb: ["sell"] });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe(
        `shop_gb is already served by another plugin (shop, id ${second})`,
      );
      expect((await getPlugin(ctx!.db, first))!.status).toBe("disabled");
    });

    it("refuses a cron the app's own parser cannot read, though its shape passed", async () => {
      // packages/shared checks the five-field SHAPE; cron-parser is an API
      // dependency and has the final say, because it is what would have to
      // schedule the catalog sweep.
      const instance = await app();
      stubPlugin(BASE, {
        manifest: withSource((s) => {
          s.kind = "sync";
          s.schedule = { catalogCron: "99 99 * * *", trackedRefreshHours: 4 };
        }),
      });
      const res = await post(instance, "/api/plugins", { baseUrl: BASE });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/catalogCron/);
      expect(await listPluginDtos(instance)).toEqual([]);
    });

    it("refuses an unreachable plugin with the reason, and stores nothing", async () => {
      const instance = await app();
      agent
        .get(BASE)
        .intercept({ path: "/health", method: "GET" })
        .replyWithError(Object.assign(new Error("connect ECONNREFUSED"), { name: "Error" }));
      const res = await post(instance, "/api/plugins", { baseUrl: BASE });
      expect(res.statusCode).toBe(400);
      // undici says only "fetch failed" and puts the reason on `cause`, so the
      // route names the URL, the call and the cause. Measured against a real
      // non-plugin service, this is the shape: pointing the import at postgres
      // answers "http://127.0.0.1:5432 GET /health failed: fetch failed:
      // other side closed".
      expect((res.json() as { error: string }).error).toBe(
        "http://shop:8000 GET /health failed: fetch failed: connect ECONNREFUSED",
      );
      expect(await listPluginDtos(instance)).toEqual([]);
    });

    it("answers a plugin that never answers, naming the call that timed out", async () => {
      // The bound itself is time, not code, and it is measured in
      // test/plugins/http.test.ts: `AbortSignal.timeout` is an absolute
      // deadline that aborts the read in flight, so a socket that accepts and
      // then goes silent rejects at ADAPTER_TIMEOUT_MS instead of holding the
      // request open. What this pins is the other half — that the rejection
      // reaches the client as an actionable 400 rather than a 500 or a hang.
      const instance = await app();
      agent
        .get(BASE)
        .intercept({ path: "/health", method: "GET" })
        .replyWithError(
          Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          }),
        );
      const res = await post(instance, "/api/plugins", { baseUrl: BASE });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(
        /^http:\/\/shop:8000 GET \/health failed: .*aborted due to timeout$/,
      );
    });

    it("passes the base-URL refusal back verbatim, because it names what was wrong", async () => {
      const instance = await app();
      const refuse = async (baseUrl: string): Promise<string> => {
        const res = await post(instance, "/api/plugins", { baseUrl });
        expect(res.statusCode).toBe(400);
        return (res.json() as { error: string }).error;
      };
      expect(await refuse("shop-8000")).toMatch(/not an absolute URL/);
      expect(await refuse("ftp://shop:8000")).toMatch(/ftp:\/\/ is not a scheme this app can fetch/);
      // the three the app REFUSES rather than silently dropping
      expect(await refuse("http://user:pw@shop:8000")).toMatch(/username or password/);
      expect(await refuse("http://shop:8000?token=1")).toMatch(/query string/);
      expect(await refuse("http://shop:8000#frag")).toMatch(/fragment/);
      expect(await listPluginDtos(instance)).toEqual([]);
    });

    it("refuses a second row for the same plugin", async () => {
      const instance = await app();
      await importPlugin(instance, BASE);
      stubPlugin(BASE);
      const res = await post(instance, "/api/plugins", { baseUrl: `${BASE}/` });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe(`${BASE} is already added`);
      expect(await listPluginDtos(instance)).toHaveLength(1);
    });

    it("answers the same 400 when the duplicate lands after the pre-check", async () => {
      // The pre-check and the insert are separated by TWO network budgets — up
      // to 2 * ADAPTER_TIMEOUT_MS — so a second import of the same URL can
      // pass the check and meet the unique index instead. Driven exactly
      // there, and not by hoping two requests interleave: the competing row is
      // written from inside the /manifest reply, which is after this handler
      // looked and before it inserts. The user did the same thing they would
      // have done a second earlier, so they get the same answer, not a 500.
      const instance = await app();
      agent.get(BASE).intercept({ path: "/health", method: "GET" }).reply(200, okHealth);
      agent
        .get(BASE)
        .intercept({ path: "/manifest", method: "GET" })
        .reply(async () => {
          await insertPlugin(ctx!.db, {
            baseUrl: BASE,
            name: "shop",
            version: "1.0.0",
            manifestSeen: null,
          });
          return { statusCode: 200, data: manifestBody() };
        });

      const res = await post(instance, "/api/plugins", { baseUrl: BASE });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe(`${BASE} is already added`);
      expect(await listPluginDtos(instance)).toHaveLength(1);
    });
  });

  describe("the two fingerprints a row serves", () => {
    it("serves what the plugin published beside what the row is described by", async () => {
      // `manifestFingerprint` is the digest of the document the row is
      // DESCRIBED by; `seenFingerprint` is the digest of what the plugin last
      // PUBLISHED. On a row with nothing to review they are the same value,
      // and that identity is what makes an already-approved grant editable
      // through this very endpoint with no new route.
      const instance = await app();
      const id = await importPlugin(instance);
      const pending = (await listPluginDtos(instance)).find((p) => p.id === id)!;
      expect(pending.seenFingerprint).toEqual(expect.any(String));
      expect(pending.seenFingerprint).toBe(pending.manifestFingerprint);

      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);
      const approved = (await listPluginDtos(instance)).find((p) => p.id === id)!;
      expect(approved.seenFingerprint).toBe(approved.manifestFingerprint);

      // and re-approving with the served digest is admitted, which is the
      // whole basis of editing a grant without removing the plugin
      const edited = await approve(instance, id, { shop_gb: ["sell", "cash"] });
      expect(edited.statusCode).toBe(200);
      expect((edited.json() as { plugin: PluginDto }).plugin.sources[0].approvedKinds).toEqual([
        "sell",
        "cash",
      ]);
    });

    it("says a manifest_seen it cannot read is not there, while still describing the row", async () => {
      // The one approval refusal a panel cannot otherwise predict: an
      // APPROVED row whose `manifest_seen` no longer validates still serves a
      // `manifestFingerprint` (of `manifest`), so a client reading that alone
      // would offer an edit whose only outcome is a 400.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);
      await ctx!.db
        .update(plugins)
        .set({ manifestSeen: { not: "a manifest" } })
        .where(eq(plugins.id, id));

      const row = (await listPluginDtos(instance)).find((p) => p.id === id)!;
      expect(row.manifestFingerprint).toEqual(expect.any(String));
      expect(row.seenFingerprint).toBeNull();
      // and the refusal it predicts is the one that really comes back
      const res = await post(instance, `/api/plugins/${id}/approve`, {
        approvedKinds: { shop_gb: ["sell"] },
        reviewedFingerprint: row.manifestFingerprint,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe(
        "this plugin has not answered /manifest yet",
      );
    });
  });

  describe("POST /api/plugins/:id/address", () => {
    it("moves a plugin and keeps everything it was granted", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell", "cash"] })).statusCode).toBe(200);
      // a pace set here travels with the row, which is why this endpoint could
      // not exist before the pace stopped being keyed on the base URL
      expect((await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 250 })).statusCode).toBe(200);

      stubPlugin(OTHER);
      const res = await post(instance, `/api/plugins/${id}/address`, { baseUrl: OTHER });
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.baseUrl).toBe(OTHER);
      expect(plugin.status).toBe("approved");
      expect(plugin.sources[0].approvedKinds).toEqual(["sell", "cash"]);
      expect(plugin.rateLimitMs).toBe(250);
      expect(plugin.drift).toEqual([]);
      // and the source is still served
      expect(await sourceIds(instance)).toContain("shop_gb");
    });

    it("does not let whoever answers at the new address inherit the old consent", async () => {
      // THE CONSENT HOLE THIS ENDPOINT IS SHAPED TO AVOID. A bare
      // `UPDATE base_url` would leave `manifest`, `approved_kinds` and
      // `status = approved` pointing at a process nobody reviewed. Instead the
      // new address's document goes into `manifest_seen`, so anything
      // different is drift and the app goes on serving what was approved.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);

      stubPlugin(OTHER, {
        manifest: withSource((source) => {
          source.kindRoles = { sell: "reference", cash: "bid" };
        }),
      });
      const res = await post(instance, `/api/plugins/${id}/address`, { baseUrl: OTHER });
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.baseUrl).toBe(OTHER);
      // it moved, and it is asking rather than telling
      expect(plugin.drift).toContain("shop_gb.kindRoles");
      expect(plugin.proposed).not.toBeNull();
      // what the app SERVES is untouched: `sell` is still buy_store
      expect(plugin.sources[0].kindRoles).toEqual({ sell: "buy_store", cash: "bid" });
    });

    it("refuses an address nothing answers at, and does not move the row", async () => {
      // A stored address nothing answered at would turn one mistyped port into
      // a plugin that is silently never called again, with its markets still
      // in the enabled list.
      const instance = await app();
      const id = await importPlugin(instance);
      // no interceptor for OTHER: the probe cannot connect
      const res = await post(instance, `/api/plugins/${id}/address`, { baseUrl: OTHER });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/GET \/health/);
      expect((await getPlugin(ctx!.db, id))!.baseUrl).toBe(BASE);
    });

    it("refuses an address another plugin already has, and a malformed one", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      await importPlugin(instance, OTHER);

      const taken = await post(instance, `/api/plugins/${id}/address`, { baseUrl: OTHER });
      expect(taken.statusCode).toBe(400);
      expect((taken.json() as { error: string }).error).toBe(`${OTHER} is already added`);

      const credentials = await post(instance, `/api/plugins/${id}/address`, {
        baseUrl: "http://user:pass@shop:8000",
      });
      expect(credentials.statusCode).toBe(400);
      expect((credentials.json() as { error: string }).error).toMatch(/username or password/);
      expect((await getPlugin(ctx!.db, id))!.baseUrl).toBe(BASE);
    });

    it("accepts the address it already has as a no-op", async () => {
      // Pressing Move on an unchanged field should not probe anything or
      // rewrite the row; it is not an error either.
      const instance = await app();
      const id = await importPlugin(instance);
      const res = await post(instance, `/api/plugins/${id}/address`, { baseUrl: `${BASE}/` });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { plugin: PluginDto }).plugin.baseUrl).toBe(BASE);
    });
  });

  describe("POST /api/plugins/:id/pace", () => {
    /** A manifest with `count` live sources behind one base URL. */
    const manySources = (count: number): Json => {
      const body = manifestBody();
      body.sources = Array.from({ length: count }, (_, i) => {
        const source = (manifestBody().sources as Json[])[0] as Json;
        return { ...source, id: `shop_${i}`, label: `Shop ${i}` };
      });
      return body;
    };

    it("stores a pace and reports where the one in force came from", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      const before = (await listPluginDtos(instance)).find((p) => p.id === id)!;
      // nothing set here and nothing in this suite's environment: the
      // deployment default is what runs, and the DTO says so
      expect(before.rateLimitMs).toBeNull();
      expect(before.rateLimitSource).toBe("default");
      expect(before.effectiveRateLimitMs).toBeGreaterThan(0);

      const res = await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 250 });
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.rateLimitMs).toBe(250);
      expect(plugin.effectiveRateLimitMs).toBe(250);
      expect(plugin.rateLimitSource).toBe("plugin");
    });

    it("restores the deployment default when the pace is cleared", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 250 })).statusCode).toBe(200);

      const res = await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: null });
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      // null, not the number the default happens to be: storing that would
      // freeze it, so a later change to the default would not reach this row
      expect(plugin.rateLimitMs).toBeNull();
      expect(plugin.rateLimitSource).toBe("default");
    });

    it("refuses a pace that is not a whole number of milliseconds above 0", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      for (const bad of [0, -1, 1.5]) {
        const res = await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: bad });
        expect(res.statusCode).toBe(400);
        expect((res.json() as { error: string }).error).toBe(
          "the pace must be a whole number of milliseconds above 0",
        );
      }
      // and none of them was stored
      expect((await listPluginDtos(instance)).find((p) => p.id === id)!.rateLimitMs).toBeNull();
    });

    it("refuses a pace that would leave the last market unable to answer", async () => {
      // The incident this endpoint exists for, in miniature: five sources
      // behind one queue at 3000 ms means the last starts twelve seconds into
      // a budget of eight, and the failure is SILENT — a source that times out
      // reaches neither the breaker nor a log.
      const instance = await app();
      const id = await importPlugin(instance, BASE, manySources(5));
      const res = await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 3000 });
      expect(res.statusCode).toBe(400);
      const error = (res.json() as { error: string }).error;
      expect(error).toContain("serves 5 live markets on one queue");
      expect(error).toContain("the last one starts 12000 ms in");
      expect(error).toContain("Use 1500 ms or less");
      expect((await listPluginDtos(instance)).find((p) => p.id === id)!.rateLimitMs).toBeNull();
    });

    it("lets a sync-only plugin be paced slower than a game view's budget", async () => {
      // A ported CeX: three country indexes sharing one Algolia application,
      // held to its 10 s pace. Counted as three sources the budget capped it
      // at 3000 ms and this endpoint refused the only correct value — but a
      // sync source is in no game view's race at all, so there is nothing for
      // its pace to be too slow for.
      const instance = await app();
      const body = manifestBody();
      body.sources = Array.from({ length: 3 }, (_, i) => {
        const source = (manifestBody().sources as Json[])[0] as Json;
        return {
          ...source,
          id: `shop_${i}`,
          label: `Shop ${i}`,
          kind: "sync",
          schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
        };
      });
      const id = await importPlugin(instance, BASE, body);
      const res = await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 10_000 });
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.rateLimitMs).toBe(10_000);
      expect(plugin.effectiveRateLimitMs).toBe(10_000);
    });

    it("refuses a pace whose last call starts in time but cannot finish", async () => {
      // THE REFUSAL A NAIVE RULE WOULD NOT MAKE. At 1999 ms the fifth market
      // starts at 7996 ms of an 8000 ms budget: it has started, and it has 4 ms
      // to complete a round trip. "It started in time" is exactly the reading
      // that would put this deployment back where it was.
      const instance = await app();
      const id = await importPlugin(instance, BASE, manySources(5));
      const res = await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 1999 });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain("the last one starts 7996 ms in");
      // and the largest that does fit is accepted
      expect((await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 1500 })).statusCode).toBe(200);
    });

    it("lets a one-source plugin take any pace", async () => {
      // Nothing queues behind anything, so there is no gap to fit.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await post(instance, `/api/plugins/${id}/pace`, { rateLimitMs: 60_000 })).statusCode).toBe(200);
    });
  });

  describe("POST /api/plugins/:id/recheck", () => {
    it("stores a fresh reading and clears the error the last failure left", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      // a poll fails: the reading it had is kept, and the error is recorded
      await recordPluginHealth(ctx!.db, id, null, null, "connect ECONNREFUSED");
      expect((await listPluginDtos(instance)).find((p) => p.id === id)!.lastError).toBe(
        "connect ECONNREFUSED",
      );

      stubPlugin(BASE);
      const res = await post(instance, `/api/plugins/${id}/recheck`, {});
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.lastError).toBeNull();
      expect(plugin.configured).toBe(true);
      expect(plugin.lastHealthAt).not.toBeNull();
    });

    it("keeps the last good reading when the probe fails, and says what failed", async () => {
      // The rule is the worker's: a null argument means "nothing new was
      // learned", never "it has nothing". One unreachable probe must not
      // report a plugin unconfigured that answered a minute ago.
      const instance = await app();
      const id = await importPlugin(instance);
      const before = (await listPluginDtos(instance)).find((p) => p.id === id)!;
      expect(before.configured).toBe(true);

      // no intercept registered for this round: the probe cannot connect
      const res = await post(instance, `/api/plugins/${id}/recheck`, {});
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.configured).toBe(true);
      expect(plugin.lastHealthAt).toBe(before.lastHealthAt);
      expect(plugin.lastError).toMatch(/GET \/health/);
    });

    it("reports a republished manifest as drift, and grants nothing", async () => {
      // A recheck writes `manifest_seen`; `manifest` — the column the registry
      // serves from — is written by an approval and by nothing else. So the
      // visible outcome of learning a plugin republished is a review, exactly
      // as when the worker learns it.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);

      stubPlugin(BASE, {
        manifest: withSource((source) => {
          source.kindRoles = { sell: "reference", cash: "bid" };
        }),
      });
      const res = await post(instance, `/api/plugins/${id}/recheck`, {});
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.drift).toContain("shop_gb.kindRoles");
      expect(plugin.proposed).not.toBeNull();
      // still serving what was approved: `sell` as buy_store, not reference
      expect(plugin.sources[0].kindRoles).toEqual({ sell: "buy_store", cash: "bid" });
      expect(plugin.sources[0].approvedKinds).toEqual(["sell"]);
    });

    it("refuses on a plugin that is off, and on one that is not there", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);
      expect((await post(instance, `/api/plugins/${id}/disable`, {})).statusCode).toBe(200);

      const off = await post(instance, `/api/plugins/${id}/recheck`, {});
      expect(off.statusCode).toBe(409);
      expect((off.json() as { error: string }).error).toBe("this plugin is off; turn it on first");

      const missing = await post(instance, "/api/plugins/9999/recheck", {});
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("POST /api/plugins/:id/approve", () => {
    it("puts the approved sources in the registry, switched off in Markets", async () => {
      // Approving is not enabling: a new source arrives switched off.
      const instance = await app();
      const id = await importPlugin(instance);
      const res = await approve(instance, id, { shop_gb: ["sell", "cash"] });
      expect(res.statusCode).toBe(200);
      const plugin = (res.json() as { plugin: PluginDto }).plugin;
      expect(plugin.status).toBe("approved");
      expect(plugin.sources[0].approvedKinds).toEqual(["sell", "cash"]);

      expect(await sourceIds(instance)).toContain("shop_gb");
      const settings = await markets(instance);
      expect(settings.available.some((m) => m.source === "shop_gb")).toBe(true);
      expect(settings.enabled).not.toContain("shop_gb");
    });

    it("refuses to approve a kind the manifest never declared", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      const res = await approve(instance, id, { shop_gb: ["active_median"] });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe("shop_gb declares no role for active_median");
      expect((await getPlugin(ctx!.db, id))!.status).toBe("pending");
    });

    it("refuses a key that names no source of this plugin", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      const res = await approve(instance, id, { shop_fr: ["sell"] });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe("shop_fr is not a source of this plugin");
    });

    it("refuses a key spelled like a prototype property, and stores nothing", async () => {
      // `approvedKinds` is an object keyed by an id a CLIENT chose. Measured
      // on this build: a body carrying `__proto__` never reaches the handler —
      // Fastify's JSON parser refuses the whole body — while `constructor`
      // parses and arrives as an ordinary own key, which the declared-source
      // check below refuses. No manifest can declare either id:
      // `validateManifest` rejects one that names a prototype property.
      const instance = await app();
      const id = await importPlugin(instance);
      const fingerprint = await servedFingerprint(instance, id);

      const viaConstructor = await approve(instance, id, { constructor: ["sell"] });
      expect(viaConstructor.statusCode).toBe(400);
      expect((viaConstructor.json() as { error: string }).error).toBe(
        "constructor is not a source of this plugin",
      );

      const viaProto = await instance.inject({
        method: "POST",
        url: `/api/plugins/${id}/approve`,
        headers: { "content-type": "application/json" },
        // written as raw JSON on purpose: `{ __proto__: ... }` in an object
        // literal sets the prototype instead of a key, so the wire bytes are
        // the only way to send what a hostile client would send
        payload: `{"approvedKinds":{"__proto__":["sell"]},"reviewedFingerprint":${JSON.stringify(fingerprint)}}`,
      });
      expect(viaProto.statusCode).toBe(400);

      const row = (await getPlugin(ctx!.db, id))!;
      expect(row.status).toBe("pending");
      expect({ ...row.approvedKinds }).toEqual({});
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(typeof ({} as Record<string, unknown>).constructor).toBe("function");
    });

    it("maps a refused approval to a status a person can act on", async () => {
      // 409 is the one worth writing down: it is not a client error, it is the
      // plugin having republished under the request. The end-to-end drivers
      // for these three are races inside one handler, so the mapping is
      // exported and pinned here; the refusals themselves are the repository's
      // (test/plugins/repo.test.ts).
      expect(approvalRefusal("manifest-changed", 7)).toEqual({
        code: 409,
        error: "this plugin changed its manifest while you were reviewing it; review it again",
      });
      expect(approvalRefusal("no-manifest", 7)).toEqual({
        code: 400,
        error: "this plugin has not answered /manifest yet",
      });
      expect(approvalRefusal("not-found", 7)).toEqual({ code: 404, error: "no plugin 7" });
    });

    it("refuses a manifest republished after the panel rendered it, then admits the reviewed one", async () => {
      // THE window the two-column design exists to close, driven end to end
      // against the real handler: the panel renders a manifest, the plugin
      // republishes, the user clicks Approve. Here the republished document
      // promotes `sell` from `buy_store` to `reference` — the role that makes
      // a source the baseline every other source is judged against, and the
      // one the approval screen leaves unchecked by default for that reason
      // (`defaultCheckedKinds` in apps/web/src/components/PluginsPanel.tsx).
      // Approving with the fingerprint the panel was SERVED must be refused,
      // because it is no longer what the plugin says; approving with the
      // current one is a review of the new document and is admitted.
      const instance = await app();
      const id = await importPlugin(instance);
      const rendered = (await listPluginDtos(instance))[0];
      expect(rendered.sources[0].kindRoles).toEqual({ sell: "buy_store", cash: "bid" });
      const reviewed = rendered.manifestFingerprint!;
      expect(reviewed).toEqual(expect.any(String));

      const republished = withSource((s) => { s.kindRoles = { sell: "reference" }; s.kindLabels = { sell: "Shop GB sells for" }; });
      await recordPluginHealth(ctx!.db, id, okHealth, republished as never, null);

      const stale = await post(instance, `/api/plugins/${id}/approve`, {
        approvedKinds: { shop_gb: ["sell"] },
        reviewedFingerprint: reviewed,
      });
      expect(stale.statusCode).toBe(409);
      expect((stale.json() as { error: string }).error).toBe(
        "this plugin changed its manifest while you were reviewing it; review it again",
      );
      // nothing was granted, and the promoted role reached no registry
      expect((await getPlugin(ctx!.db, id))!.status).toBe("pending");
      expect(await sourceIds(instance)).not.toContain("shop_gb");

      // the panel re-reads, the user sees `reference` this time, and approves it
      const current = await servedFingerprint(instance, id);
      expect(current).not.toBe(reviewed);
      const fresh = await post(instance, `/api/plugins/${id}/approve`, {
        approvedKinds: { shop_gb: ["sell"] },
        reviewedFingerprint: current,
      });
      expect(fresh.statusCode).toBe(200);
      const shop = (await instance.inject({ method: "GET", url: "/api/sources" }).then((r) =>
        (r.json() as SourcesResponse).sources.find((s) => s.id === "shop_gb"),
      ))!;
      expect(shop.kindRoles).toEqual({ sell: "reference" });
    });

    it("refuses an approval that carries no fingerprint at all", async () => {
      // The guard cannot be opted out of by omission: a client that does not
      // send the field is refused by the schema, and one that sends an empty
      // string is refused by the same rule rather than being compared.
      const instance = await app();
      const id = await importPlugin(instance);
      const missing = await post(instance, `/api/plugins/${id}/approve`, {
        approvedKinds: { shop_gb: ["sell"] },
      });
      expect(missing.statusCode).toBe(400);
      const empty = await post(instance, `/api/plugins/${id}/approve`, {
        approvedKinds: { shop_gb: ["sell"] },
        reviewedFingerprint: "",
      });
      expect(empty.statusCode).toBe(400);
      expect((await getPlugin(ctx!.db, id))!.status).toBe("pending");
    });

    it("serves one fingerprint for one document, whatever order jsonb hands it back in", async () => {
      // The digest names a DOCUMENT, not a serialisation: a manifest rewritten
      // with its keys in another order is the same manifest and must not read
      // as drift the user has to review again.
      const instance = await app();
      const id = await importPlugin(instance);
      const before = await servedFingerprint(instance, id);

      const reordered = manifestBody();
      const source = (reordered.sources as Json[])[0];
      (reordered.sources as Json[])[0] = Object.fromEntries(
        Object.keys(source).reverse().map((key) => [key, source[key]]),
      );
      await recordPluginHealth(ctx!.db, id, okHealth, reordered as never, null);
      expect(await servedFingerprint(instance, id)).toBe(before);
    });

    it("re-runs the CRON check the import runs, against the document being approved", async () => {
      // `manifest_seen` is rewritten by every health poll, so the document
      // reaching approval is not the one the import checked. A cron this app's
      // parser cannot read would leave a catalog sweep unscheduled and a
      // source erroring on every game view with nothing saying why, so the
      // approval is refused exactly as the import would have refused it.
      const instance = await app();
      const id = await importPlugin(instance);
      const drifted = withSource((s) => {
        s.kind = "sync";
        s.schedule = { catalogCron: "99 99 * * *", trackedRefreshHours: 4 };
      });
      await recordPluginHealth(ctx!.db, id, okHealth, drifted as never, null);

      const res = await approve(instance, id, { shop_gb: ["sell"] });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/catalogCron/);
      expect((await getPlugin(ctx!.db, id))!.status).toBe("pending");
    });

    it("does not refuse an approval over a source it is not approving", async () => {
      // A source approved for no kind never enters the registry, so it takes
      // no id and can collide with nothing. Refusing the whole approval over
      // one would stop a user approving the sources they DO want because of
      // one they deliberately left alone.
      const instance = await app();
      // Both imported while the registry is empty of either — the import check
      // is over the WHOLE manifest, because nothing is being approved there.
      const first = await importPlugin(instance, BASE);
      const twoSources = manifestBody();
      (twoSources.sources as Json[]).push({
        ...(manifestBody().sources as Json[])[0],
        id: "shop_fr",
        label: "Shop FR",
        country: "FR",
      });
      const second = await importPlugin(instance, OTHER, twoSources);
      expect((await approve(instance, first, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const res = await approve(instance, second, { shop_fr: ["sell"] });
      expect(res.statusCode).toBe(200);
      const ids = await sourceIds(instance);
      expect(ids).toContain("shop_fr");
      // and shop_gb still belongs to the plugin that was approved for it
      const shopGb = (await instance.inject({ method: "GET", url: "/api/sources" }).then((r) =>
        (r.json() as SourcesResponse).sources.find((s) => s.id === "shop_gb"),
      ))!;
      expect(shopGb.pluginId).toBe(first);
    });

    it("answers 404 for a plugin that is not there, including an id no column can hold", async () => {
      const instance = await app();
      const body = { approvedKinds: {}, reviewedFingerprint: "whatever" };
      expect((await post(instance, "/api/plugins/404/approve", body)).statusCode).toBe(404);
      expect((await post(instance, "/api/plugins/abc/approve", body)).statusCode).toBe(404);
      // `plugins.id` is a serial, so this is past what an int4 can hold. Left
      // unbounded it reaches postgres and comes back as 22003 — a 500 quoting
      // the SQL statement and its parameters, for what is simply not a plugin.
      expect((await post(instance, "/api/plugins/2147483648/approve", body)).statusCode).toBe(404);
      expect(
        (await instance.inject({ method: "DELETE", url: "/api/plugins/2147483648" })).statusCode,
      ).toBe(404);
      expect((await post(instance, "/api/plugins/2147483648/disable", {})).statusCode).toBe(404);
    });
  });

  describe("a plugin that changed its manifest after approval", () => {
    it("keeps serving the approved one and reports which fields drifted", async () => {
      // A community plugin cannot promote itself to `reference` through an
      // update: until the user re-approves, the new role does not exist.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const drifted = withSource((s) => { s.kindRoles = { sell: "reference" }; s.kindLabels = { sell: "Shop GB sells for" }; });
      (drifted.sources as Json[]).push({
        ...(manifestBody().sources as Json[])[0],
        id: "shop_fr",
        label: "Shop FR",
        country: "FR",
      });
      await recordPluginHealth(ctx!.db, id, okHealth, drifted as never, null);

      const plugin = (await listPluginDtos(instance))[0];
      expect(plugin.drift).toContain("shop_gb.kindRoles");
      expect(plugin.drift).toContain("+shop_fr");
      // and the panel still describes what was approved
      expect(plugin.sources.map((s) => s.id)).toEqual(["shop_gb"]);

      const res = await instance.inject({ method: "GET", url: "/api/sources" });
      const shop = (res.json() as SourcesResponse).sources.find((s) => s.id === "shop_gb");
      expect(shop!.kindRoles).toEqual({ sell: "buy_store" });
      expect((await sourceIds(instance))).not.toContain("shop_fr");
    });

    it("names the drifted fields the app acts on, caveat included, not a relabelled source", async () => {
      // Entries of DRIFT_FIELDS, chosen because they are the ones a reader
      // would least expect to matter; `kindRoles` is covered by the test
      // above. The drift list is an audit of what sources/registry.ts reads.
      // `kind` and `schedule` decide which endpoints a source is called
      // through and whether a catalog sweep — the one irreversible operation
      // here — will run
      // against it; `sellFeeRate` is multiplied into what the PROFIT rule
      // shows; `caveat` is printed under this source's prices in the app's
      // own voice, so a reworded one is a claim the app now makes on the
      // plugin's behalf, and IS a reason to send a person back to a review
      // screen. `label` and `familyLabel` stay out: a relabelled source is
      // the one kind of prose a person can check against the card in front
      // of them.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const drifted = withSource((s) => {
        s.kind = "sync";
        s.schedule = { catalogCron: "0 3 * * *", trackedRefreshHours: 24 };
        s.sellFeeRate = 0.1;
        s.label = "Shop Great Britain";
        s.familyLabel = "Shoppe";
        s.caveat = "reworded, and now printed as the app's own warning";
      });
      await recordPluginHealth(ctx!.db, id, okHealth, drifted as never, null);

      const drift = (await listPluginDtos(instance))[0].drift;
      expect(drift).toContain("shop_gb.kind");
      expect(drift).toContain("shop_gb.schedule");
      expect(drift).toContain("shop_gb.sellFeeRate");
      expect(drift).toContain("shop_gb.caveat");
      expect(drift).not.toContain("shop_gb.label");
      expect(drift).not.toContain("shop_gb.familyLabel");
    });

    it("serves the drifted document and ITS fingerprint, so it can be reviewed and approved in place", async () => {
      // Spec Part C's drift flow: "shows manifest changed — review", and the
      // user approves the new document FROM THAT CARD. It needs two things on
      // screen at once — the document the plugin publishes now, and the
      // fingerprint the approve handler will compare against `manifest_seen`.
      // Serving only the approved manifest left the panel able to send back
      // one fingerprint, the old one, which could earn nothing but a 409; the
      // panel's answer was to tell the user to remove the plugin and add it
      // again. This is what replaces that.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const drifted = withSource((s) => { s.kindRoles = { sell: "reference" }; s.kindLabels = { sell: "Shop GB sells for" }; });
      (drifted.sources as Json[]).push({
        ...(manifestBody().sources as Json[])[0],
        id: "shop_fr",
        label: "Shop FR",
        country: "FR",
      });
      await recordPluginHealth(ctx!.db, id, okHealth, drifted as never, null);

      const plugin = (await listPluginDtos(instance))[0];
      // the row is still described by what was approved...
      expect(plugin.sources.map((s) => s.id)).toEqual(["shop_gb"]);
      expect(plugin.sources[0].kindRoles).toEqual({ sell: "buy_store", cash: "bid" });
      // ...and the new document rides beside it, whole
      expect(plugin.proposed!.sources.map((s) => s.id)).toEqual(["shop_gb", "shop_fr"]);
      expect(plugin.proposed!.sources[0].kindRoles).toEqual({ sell: "reference" });
      // the role `sell` was actually APPROVED under last time — buy_store,
      // not the reference the new document now proposes for it. This is what
      // tells defaultCheckedKinds a re-offered grant apart from a promotion
      // wearing the old kind's name: read off the APPROVED manifest
      // (row.manifest), never the seen/proposed one, so a regression that
      // swapped that source in sourceDto() would fail here, not just in
      // apps/web/test/PluginsPanel.test.tsx's hand-set fixtures.
      expect(plugin.proposed!.sources[0].approvedKindRoles).toEqual({ sell: "buy_store", cash: "bid" });
      // what the user granted THAT ID last time, so a re-review can be
      // pre-ticked from the last decision rather than from the plugin's wish
      expect(plugin.proposed!.sources[0].approvedKinds).toEqual(["sell"]);
      expect(plugin.proposed!.sources[1].approvedKinds).toEqual([]);
      expect(plugin.proposed!.manifestFingerprint).not.toBe(plugin.manifestFingerprint);

      // the approved fingerprint is still refused — that guard is untouched
      const stale = await post(instance, `/api/plugins/${id}/approve`, {
        approvedKinds: { shop_gb: ["sell"] },
        reviewedFingerprint: plugin.manifestFingerprint,
      });
      expect(stale.statusCode).toBe(409);

      // and the one served with the document the user was shown is admitted
      const fresh = await post(instance, `/api/plugins/${id}/approve`, {
        approvedKinds: { shop_gb: ["sell"], shop_fr: ["sell"] },
        reviewedFingerprint: plugin.proposed!.manifestFingerprint,
      });
      expect(fresh.statusCode).toBe(200);
      const ids = await sourceIds(instance);
      expect(ids).toContain("shop_fr");
      const shop = (await instance.inject({ method: "GET", url: "/api/sources" }).then((r) =>
        (r.json() as SourcesResponse).sources.find((s) => s.id === "shop_gb"),
      ))!;
      expect(shop.kindRoles).toEqual({ sell: "reference" });
      // nothing left to review once it is the served document
      expect((await listPluginDtos(instance))[0].proposed).toBeNull();
    });

    it("offers no second document when the plugin has published only one", async () => {
      // `proposed` is the OTHER document or nothing. A pending row's own
      // fields already ARE the last-seen manifest, and an undrifted approved
      // row has one document under two names — in both cases a second copy on
      // screen would be a review the user does not owe anybody.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await listPluginDtos(instance))[0].proposed).toBeNull();
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);
      expect((await listPluginDtos(instance))[0].proposed).toBeNull();
    });

    it("still proposes a document that differs only outside DRIFT_FIELDS, with an empty drift list", async () => {
      // The state a protocol bump puts every approved plugin
      // into at once: the published document differs from the approved one
      // by fingerprint, but only in something `driftFields` never compares —
      // a version string here, which is what a real plugin republishes on
      // every release (the protocol number is the other field that can
      // differ this way and still never be compared). `proposed` is offered
      // on any BYTE difference and deliberately not gated on `drift` (see the
      // comment above it in apps/api/src/routes/plugins.ts): it is the only
      // document this panel can approve and the only fingerprint the approve
      // guard accepts, so gating it here would strand the row with no Review
      // button, an editor that opens anyway, and a fingerprint that could
      // only earn a 409.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);

      const republished = manifestBody();
      republished.plugin = { name: "shop", version: "1.3.0" };
      await recordPluginHealth(ctx!.db, id, okHealth, republished as never, null);

      const plugin = (await listPluginDtos(instance))[0];
      expect(plugin.status).toBe("approved");
      // the row can still be approved from this document...
      expect(plugin.proposed).not.toBeNull();
      expect(plugin.proposed!.version).toBe("1.3.0");
      // ...but the screen has nothing to phrase about it
      expect(plugin.drift).toEqual([]);
    });

    it("serves every manifest field the app acts on, so a review screen can show them", async () => {
      // A consent screen may not hide a field the app ACTS on, and these four
      // are the ones the card could not render before: `expectedCurrencies`
      // decides which prices exist at all, `defaultRegion` classifies every
      // row, `sellFeeRate` is multiplied into what PROFIT shows, `schedule` is
      // what a catalog sweep runs on. They are also among the entries of
      // DRIFT_FIELDS, which is the same list read the other way round.
      // `productUrl` rides along too: nothing acts on it yet, but the same
      // screen is where a person approves it, so it may not be hidden either.
      // `categoryPlatforms` rides along for the same reason.
      const instance = await app();
      const declared = withSource((s) => {
        s.kind = "sync";
        s.schedule = { catalogCron: "0 3 * * *", trackedRefreshHours: 24 };
        s.sellFeeRate = 0.1;
        s.defaultRegion = "PAL";
        s.expectedCurrencies = ["GBP"];
        s.productUrl = "https://uk.webuy.com/product-detail?id={id}";
        s.categoryPlatforms = { "Nintendo NES Software": "nes" };
      });
      const id = await importPlugin(instance, BASE, declared);
      const source = (await listPluginDtos(instance))[0].sources[0];
      expect(source.defaultRegion).toBe("PAL");
      expect(source.expectedCurrencies).toEqual(["GBP"]);
      expect(source.sellFeeRate).toBe(0.1);
      expect(source.schedule).toEqual({ catalogCron: "0 3 * * *", trackedRefreshHours: 24 });
      expect(source.productUrl).toBe("https://uk.webuy.com/product-detail?id={id}");
      expect(source.categoryPlatforms).toEqual({ "Nintendo NES Software": "nes" });

      // and absent stays absent: a plugin that declared no fee and no
      // schedule must not be shown as one that declared 0 and never sweeps
      const bare = await importPlugin(instance, OTHER, withSource((s) => { s.id = "shop_ie"; s.country = "IE"; }));
      const other = (await listPluginDtos(instance)).find((p) => p.id === bare)!.sources[0];
      expect(other.sellFeeRate).toBeUndefined();
      expect(other.schedule).toBeUndefined();
      expect(other.productUrl).toBeUndefined();
      expect(other.categoryPlatforms).toBeUndefined();
    });

    it("describes a row by its served manifest, not by the columns the import wrote", async () => {
      // `plugins.name` and `plugins.version` are written by `insertPlugin` and
      // by nothing else — not by an approval, not by a health poll — so a
      // plugin that renamed itself would otherwise be listed under the name it
      // had at import beside sources taken from the document it publishes now.
      const instance = await app();
      const id = await importPlugin(instance);
      const renamed = manifestBody();
      renamed.plugin = { name: "shoppe", version: "2.0.0" };
      await recordPluginHealth(ctx!.db, id, okHealth, renamed as never, null);

      const pending = (await listPluginDtos(instance))[0];
      expect(pending.name).toBe("shoppe");
      expect(pending.version).toBe("2.0.0");
      // and an approved row is described by what was approved, name included
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);
      expect((await listPluginDtos(instance))[0].name).toBe("shoppe");
    });
  });

  describe("disable and delete", () => {
    it("disabling takes the sources out of the registry and keeps the row", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      await approve(instance, id, { shop_gb: ["sell"] });
      expect(await sourceIds(instance)).toContain("shop_gb");

      const res = await post(instance, `/api/plugins/${id}/disable`, {});
      expect(res.statusCode).toBe(200);
      expect((res.json() as { plugin: PluginDto }).plugin.status).toBe("disabled");
      expect(await sourceIds(instance)).not.toContain("shop_gb");
      expect(await listPluginDtos(instance)).toHaveLength(1);
    });

    it("re-approving a disabled plugin switches it back on, markets and all", async () => {
      // What "Approve" MEANS on a disabled card, pinned because the panel
      // prints its consequence beside the button and that sentence must be
      // this behaviour and not a hope. `approvePlugin` writes
      // `status = approved` whatever the row said, so approving a disabled
      // plugin is what brings it back — and because `disable` deliberately
      // does NOT prune `enabled_sources` (see the handler), a market that was
      // switched on before comes back switched ON — live again for the next
      // caller that asks for prices, which is a game view or a worker tick,
      // not this request.
      const instance = await app();
      const id = await importPlugin(instance);
      await approve(instance, id, { shop_gb: ["sell"] });
      const enable = await instance.inject({
        method: "PUT",
        url: "/api/settings/markets",
        payload: { enabled: ["cex", "shop_gb"] },
      });
      expect(enable.statusCode).toBe(200);

      expect((await post(instance, `/api/plugins/${id}/disable`, {})).statusCode).toBe(200);
      expect(await sourceIds(instance)).not.toContain("shop_gb");
      // the setting is untouched by disabling, which is why the market
      // returns switched on rather than switched off
      expect([...(await loadEnabledSources(ctx!.db))]).toEqual(["shop_gb", "cex"]);

      const back = await approve(instance, id, { shop_gb: ["sell"] });
      expect(back.statusCode).toBe(200);
      expect((back.json() as { plugin: PluginDto }).plugin.status).toBe("approved");
      expect(await sourceIds(instance)).toContain("shop_gb");
      expect((await markets(instance)).enabled).toContain("shop_gb");
    });

    it("deleting removes the row and its ids from enabled_sources, and keeps the history", async () => {
      const instance = await app();
      const id = await importPlugin(instance);
      await approve(instance, id, { shop_gb: ["sell"] });

      // the user enables it, exactly as they would any other market
      const enable = await instance.inject({
        method: "PUT",
        url: "/api/settings/markets",
        payload: { enabled: ["cex", "shop_gb"] },
      });
      expect(enable.statusCode).toBe(200);
      expect([...(await loadEnabledSources(ctx!.db))]).toEqual(["shop_gb", "cex"]);

      // and it has been queried: rows exist under its id
      const [game] = await ctx!.db
        .insert(games)
        .values({ title: "Super Metroid", platform: "snes" })
        .returning();
      await ctx!.db.insert(pricePoints).values({
        gameId: game.id, source: "shop_gb", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "40.00", priceOriginal: "32.00", currencyOriginal: "GBP",
        fetchedAt: new Date("2026-09-03T10:00:00Z"),
      });
      await ctx!.db.insert(catalogItems).values({
        source: "shop_gb", sourceProductId: "p1", title: "Super Metroid", currency: "GBP",
        prices: { sell: "32.00" },
        syncedAt: new Date("2026-09-03T10:00:00Z"),
        lastSeenAt: new Date("2026-09-03T10:00:00Z"),
        refreshSource: "bulk",
      });
      await ctx!.db.insert(sourceMappings).values({
        gameId: game.id, source: "shop_gb", sourceProductId: "p1",
        sourceTitle: "Super Metroid", matchScore: 0.9, status: "confirmed",
      });

      const res = await instance.inject({ method: "DELETE", url: `/api/plugins/${id}` });
      expect(res.statusCode).toBe(200);
      expect(await listPluginDtos(instance)).toEqual([]);
      expect(await sourceIds(instance)).not.toContain("shop_gb");
      // the deployment stops naming a market it no longer has
      expect([...(await loadEnabledSources(ctx!.db))]).toEqual(["cex"]);
      expect((await markets(instance)).enabled).toEqual(["cex"]);

      // history is KEPT: the prices were true when they were taken
      expect(await ctx!.db.select().from(pricePoints)).toHaveLength(1);
      expect(await ctx!.db.select().from(catalogItems)).toHaveLength(1);
      expect(await ctx!.db.select().from(sourceMappings)).toHaveLength(1);
    });

    it("leaves the Markets screen saveable after the source it named is deleted", async () => {
      // Two rules meet here. The delete above keeps the STORED list from
      // naming a dead market; this one is about a list that names one anyway —
      // saved before the deletion, restored from a backup, or written by hand.
      // routes/markets.ts refuses only ids being ADDED, so the save that
      // carries a dead id through is accepted — and keeps it, because the
      // registry's silence about an id already stored is not a decision the
      // user made. Without that first rule the screen would be locked: the
      // offending id is in every list the client can send, including the one
      // that removes it.
      const instance = await app();
      const id = await importPlugin(instance);
      await approve(instance, id, { shop_gb: ["sell"] });
      expect((await instance.inject({ method: "DELETE", url: `/api/plugins/${id}` })).statusCode).toBe(200);
      await saveEnabledSources(ctx!.db, ["cex", "shop_gb"]);

      const res = await instance.inject({
        method: "PUT",
        url: "/api/settings/markets",
        payload: { enabled: ["cex", "shop_gb"] },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as MarketSettingsResponse).enabled).toEqual(["cex", "shop_gb"]);
    });

    it("keeps a disabled plugin's markets switched on across a save of another one", async () => {
      // Disabling stops querying a plugin; it does not spend the user's
      // setting. The stored list goes on naming this plugin's ids while the
      // registry does not serve them, so a save of any other market used to
      // delete them and re-approving brought the sources back switched OFF.
      //
      // Naming "ebay_uk" as an id THIS DEPLOYMENT already has needs a real
      // approved plugin row, seeded BEFORE `app()` builds its one-shot
      // registry (the PUT below never rebuilds it — see the route's comment).
      await seedEbayPlugin(ctx!.db);
      const instance = await app();
      const id = await importPlugin(instance);
      await approve(instance, id, { shop_gb: ["sell"] });
      await saveEnabledSources(ctx!.db, ["cex", "shop_gb"]);
      expect((await post(instance, `/api/plugins/${id}/disable`, {})).statusCode).toBe(200);

      const res = await instance.inject({
        method: "PUT",
        url: "/api/settings/markets",
        payload: { enabled: ["cex", "shop_gb", "ebay_uk"] },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as MarketSettingsResponse).enabled).toEqual(["ebay_uk", "cex", "shop_gb"]);

      // and re-approving brings the source back switched ON
      expect((await approve(instance, id, { shop_gb: ["sell"] })).statusCode).toBe(200);
      expect((await markets(instance)).enabled).toContain("shop_gb");
    });

    it("does not freeze the ENABLED_SOURCES seed into the database", async () => {
      // Deleting a plugin whose ids nobody had enabled must not write the
      // enabled-sources row at all: `loadEnabledSources` falls back to the env
      // seed while no row is stored, and materialising it here would stop that
      // seed applying to a deployment that never chose a list.
      const instance = await app();
      const id = await importPlugin(instance);
      expect((await instance.inject({ method: "DELETE", url: `/api/plugins/${id}` })).statusCode).toBe(200);
      const stored = await ctx!.db.query.appSettings.findMany();
      expect(stored.map((row) => row.key)).not.toContain("enabled_sources");
    });

    it("answers 404 for a plugin that is not there", async () => {
      const instance = await app();
      expect((await instance.inject({ method: "DELETE", url: "/api/plugins/404" })).statusCode).toBe(404);
      expect((await post(instance, "/api/plugins/404/disable", {})).statusCode).toBe(404);
    });
  });
});
