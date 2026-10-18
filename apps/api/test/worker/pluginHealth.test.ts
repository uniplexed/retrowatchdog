import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import {
  approvePlugin,
  getPlugin,
  insertPlugin,
  listPlugins,
  setPluginStatus,
  type PluginHealth,
} from "../../src/plugins/repo.js";
import { buildSourceRuntime } from "../../src/sources/registry.js";
import {
  ensureSchedulers,
  reconcileSchedulers,
  runPluginHealth,
  type PluginProbe,
  type SchedulerQueue,
  type SchedulerRepeat,
} from "../../src/worker/pluginHealth.js";
import type { CatalogSyncCapability, PriceSourceAdapter } from "../../src/adapters/types.js";
import type { Db } from "../../src/db/index.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

/**
 * A manifest `validateManifest` accepts, because the repository validates the
 * column on read: a fixture it refuses comes back as no manifest at all and
 * the assertions below would be about nothing.
 *
 * `shop_gb`, a fictional id, so no real plugin's declaration is involved.
 */
const manifest = (
  kindRoles: PluginManifest["sources"][number]["kindRoles"] = { active_listing: "buy_listing" },
): PluginManifest => ({
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
      kindRoles,
      // One label per role the caller declared, worded generically: no test
      // in this file asserts the wording itself, only that every declared
      // role survives the trip through `manifestSeen`/`manifest`.
      kindLabels: Object.fromEntries(
        Object.keys(kindRoles).map((kind) => [kind, `Shop GB ${kind}`]),
      ) as PluginManifest["sources"][number]["kindLabels"],
    },
  ],
});

const okHealth = { status: "ok", protocol: 2, configured: true } as const;

/**
 * The same database, with the Nth `update` refused — the app's own storage
 * failing under a poll that otherwise went fine. A proxy rather than a stub
 * because everything else the pass does (the `listPlugins` read, the write for
 * every other plugin) has to keep working for the assertion to mean anything.
 * Methods are bound to the real db, so drizzle's builders keep their own `this`.
 */
function refusingWrite(db: Db, nth: number): Db {
  let writes = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "update") {
        return (...args: unknown[]) => {
          writes += 1;
          if (writes === nth) throw new Error("connection terminated unexpectedly");
          return (target.update as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

/** A probe that answers the same thing for every plugin and records who was asked. */
function fakeProbe(
  answers: {
    health?: (baseUrl: string) => Promise<PluginHealth>;
    manifest?: (baseUrl: string) => Promise<PluginManifest>;
  } = {},
): PluginProbe & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    health: async (baseUrl) => {
      asked.push(baseUrl);
      return answers.health ? await answers.health(baseUrl) : { ...okHealth };
    },
    manifest: async (baseUrl) => (answers.manifest ? await answers.manifest(baseUrl) : manifest()),
  };
}

describe.skipIf(ctx === null)("runPluginHealth", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("records health and the latest manifest for every non-disabled plugin", async () => {
    const pending = await insertPlugin(ctx!.db, {
      baseUrl: "http://pending:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: null,
    });
    const approved = await insertPlugin(ctx!.db, {
      baseUrl: "http://approved:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
    });
    await approvePlugin(ctx!.db, approved.id, { shop_gb: ["active_listing"] }, manifest());

    await runPluginHealth(ctx!.db, fakeProbe());

    for (const id of [pending.id, approved.id]) {
      const row = await getPlugin(ctx!.db, id);
      expect(row?.lastHealth).toEqual({ status: "ok", protocol: 2, configured: true });
      expect(row?.lastHealthAt).toBeInstanceOf(Date);
      expect(row?.manifestSeen).toEqual(manifest());
      expect(row?.lastError).toBeNull();
    }
  });

  it("skips a disabled plugin entirely", async () => {
    // Disabled means "do not talk to it": polling it would keep a dead
    // container's failures arriving in the log and its clock ticking in the
    // row, for a plugin the user told the app to leave alone.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://disabled:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
      lastError: "the error it was disabled with",
    });
    const before = await getPlugin(ctx!.db, row.id);
    await setPluginStatus(ctx!.db, row.id, "disabled");

    const probe = fakeProbe();
    await runPluginHealth(ctx!.db, probe);

    expect(probe.asked).toEqual([]);
    const after = await getPlugin(ctx!.db, row.id);
    expect(after?.lastHealthAt?.getTime()).toBe(before?.lastHealthAt?.getTime());
    expect(after?.lastError).toBe("the error it was disabled with");
  });

  it("records the error and keeps the last known health when a plugin does not answer", async () => {
    // The app must never report every plugin unconfigured because its own
    // worker, or one plugin, blipped for a tick.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    await approvePlugin(ctx!.db, row.id, { shop_gb: ["active_listing"] }, manifest());
    const before = await getPlugin(ctx!.db, row.id);

    await runPluginHealth(
      ctx!.db,
      fakeProbe({
        health: async () => {
          throw new Error("http://shop:8000 GET /health: connect ECONNREFUSED");
        },
      }),
    );

    const after = await getPlugin(ctx!.db, row.id);
    expect(after?.lastError).toBe("http://shop:8000 GET /health: connect ECONNREFUSED");
    expect(after?.lastHealth).toEqual({ status: "ok", protocol: 2, configured: true });
    // the timestamp is the age of the KEPT reading, so it must not move
    expect(after?.lastHealthAt?.getTime()).toBe(before?.lastHealthAt?.getTime());
    // and end to end: the source is still offered as configured
    const { registry } = await buildSourceRuntime(ctx!.db, []);
    expect(registry.get("shop_gb")?.configured).toBe(true);
  });

  it("leaves a plugin that has never answered unconfigured", async () => {
    // Null health says "it has never answered". A failed poll writes no
    // synthetic reading, so nothing invents an answer the plugin never gave.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://never:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
    });
    await approvePlugin(ctx!.db, row.id, { shop_gb: ["active_listing"] }, manifest());

    await runPluginHealth(
      ctx!.db,
      fakeProbe({
        health: async () => {
          throw new Error("no answer");
        },
      }),
    );

    expect((await getPlugin(ctx!.db, row.id))?.lastHealth).toBeNull();
    const { registry } = await buildSourceRuntime(ctx!.db, []);
    expect(registry.get("shop_gb")?.configured).toBe(false);
  });

  it("records a new configured reading, so the next runtime built offers the source", async () => {
    // What this shows is the tick's half of the promise: the reading changes in
    // the table, and a runtime built from the table afterwards offers the
    // source. It deliberately does NOT claim "without a restart" for the app as
    // a whole — the worker rebuilds its own runtime every tick, but the API
    // serves a cached one that only its own boot or an
    // approve/disable/delete rebuilds (`pluginConfigured` in
    // sources/registry.ts). Naming this "without a restart" would promise the
    // Markets screen something the tick does not do for it.
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: false },
    });
    await approvePlugin(ctx!.db, row.id, { shop_gb: ["active_listing"] }, manifest());

    let configured = false;
    const probe = fakeProbe({ health: async () => ({ status: "ok", protocol: 2, configured }) });

    await runPluginHealth(ctx!.db, probe);
    expect((await buildSourceRuntime(ctx!.db, [])).registry.get("shop_gb")?.configured).toBe(false);

    // the plugin's container gains its secrets; nothing here restarts
    configured = true;
    await runPluginHealth(ctx!.db, probe);
    expect((await buildSourceRuntime(ctx!.db, [])).registry.get("shop_gb")?.configured).toBe(true);
  });

  it("keeps the health a plugin did give when only its manifest fails", async () => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });

    await runPluginHealth(
      ctx!.db,
      fakeProbe({
        health: async () => ({ status: "ok", protocol: 2, configured: false }),
        manifest: async () => {
          throw new Error("http://shop:8000 GET /manifest: sources[0].id 7 must match ^[a-z]");
        },
      }),
    );

    const after = await getPlugin(ctx!.db, row.id);
    // the plugin's own answer about its secrets, not a guess
    expect(after?.lastHealth).toEqual({ status: "ok", protocol: 2, configured: false });
    expect(after?.lastError).toContain("GET /manifest");
    // an invalid manifest is an error like any other: the last valid one stands
    expect(after?.manifestSeen).toEqual(manifest());
  });

  it("polls the next plugin after one of them fails", async () => {
    await insertPlugin(ctx!.db, {
      baseUrl: "http://first:8000",
      name: "a",
      version: "1.0.0",
      manifestSeen: null,
    });
    await insertPlugin(ctx!.db, {
      baseUrl: "http://second:8000",
      name: "b",
      version: "1.0.0",
      manifestSeen: null,
    });

    const probe = fakeProbe({
      health: async (baseUrl) => {
        if (baseUrl === "http://first:8000") throw new Error("down");
        return { ...okHealth };
      },
    });
    await runPluginHealth(ctx!.db, probe);

    expect(probe.asked.sort()).toEqual(["http://first:8000", "http://second:8000"]);
  });

  it("goes on polling when this app's own database refuses the write", async () => {
    // Two failures used to be told apart by nothing. A write that fails is
    // OURS, not the plugin's: recording it in `last_error` puts this app's
    // outage on screen as that plugin's, and the write that recorded it lived
    // in the catch, so a database that was down threw a second time and ended
    // the pass — every plugin after the first one went unpolled for the tick.
    await insertPlugin(ctx!.db, {
      baseUrl: "http://first:8000",
      name: "a",
      version: "1.0.0",
      manifestSeen: null,
    });
    await insertPlugin(ctx!.db, {
      baseUrl: "http://second:8000",
      name: "b",
      version: "1.0.0",
      manifestSeen: null,
    });

    const probe = fakeProbe();
    await runPluginHealth(refusingWrite(ctx!.db, 1), probe);

    // the pass reached the second plugin...
    expect(probe.asked).toHaveLength(2);
    const byUrl = new Map((await listPlugins(ctx!.db)).map((p) => [p.baseUrl, p]));
    const [firstAsked, secondAsked] = probe.asked;
    // ...whose reading was written, while the plugin whose write was refused
    // kept the nothing it had — and, above all, was not blamed for it
    expect(byUrl.get(firstAsked)?.lastHealth).toBeNull();
    expect(byUrl.get(firstAsked)?.lastError).toBeNull();
    expect(byUrl.get(secondAsked)?.lastHealth).toEqual({
      status: "ok",
      protocol: 2,
      configured: true,
    });
  });

  it("cannot promote a plugin's roles by republishing between ticks", async () => {
    // The tick writes what the plugin SAYS (`manifest_seen`). What the app
    // SERVES is what the user approved (`manifest`), and only an approval
    // writes that. A community plugin therefore cannot make itself the market
    // baseline by republishing.
    const approvedManifest = manifest({ active_listing: "buy_listing" });
    const republished = manifest({ active_listing: "buy_listing", active_median: "reference" });
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: approvedManifest,
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    await approvePlugin(ctx!.db, row.id, { shop_gb: ["active_listing"] }, approvedManifest);

    await runPluginHealth(ctx!.db, fakeProbe({ manifest: async () => republished }));

    const after = await getPlugin(ctx!.db, row.id);
    // the drift is visible...
    expect(after?.manifestSeen).toEqual(republished);
    // ...and the approved manifest is untouched
    expect(after?.manifest).toEqual(approvedManifest);
    const { registry } = await buildSourceRuntime(ctx!.db, []);
    expect(registry.get("shop_gb")?.kindRoles).toEqual({ active_listing: "buy_listing" });

    // And the approval the user is holding is now an answer to a document that
    // is no longer what the plugin says: it is refused rather than promoted.
    expect(
      await approvePlugin(
        ctx!.db,
        row.id,
        { shop_gb: ["active_listing", "active_median"] },
        approvedManifest,
      ),
    ).toEqual({ ok: false, reason: "manifest-changed" });
  });
});

interface RecordingQueue extends SchedulerQueue {
  upserted: Array<[string, SchedulerRepeat, { name: string; data: unknown }]>;
  removed: string[];
}

/**
 * Records every call; never touches Redis. `existing` is what the queue
 * remembers, and its CADENCE matters now: an upsert is supposed to happen only
 * for a scheduler that is missing or whose repeat options actually changed, so
 * a fixture that says only "this id exists" is a fixture that always differs.
 * A bare string is exactly that, and stays available for the tests about
 * removal, which are not about cadence at all.
 */
function fakeQueue(existing: Array<string | ({ key: string } & SchedulerRepeat)> = []): RecordingQueue {
  const upserted: RecordingQueue["upserted"] = [];
  const removed: string[] = [];
  return {
    upserted,
    removed,
    upsertJobScheduler: async (id, repeat, job) => {
      upserted.push([id, repeat, job]);
      return undefined;
    },
    removeJobScheduler: async (id) => {
      removed.push(id);
      return true;
    },
    getJobSchedulers: async () =>
      existing.map((entry) => (typeof entry === "string" ? { key: entry } : entry)),
  };
}

function syncAdapter(
  source: string,
  schedule: CatalogSyncCapability["schedule"],
): PriceSourceAdapter {
  return stubAdapter({
    source,
    catalogSync: {
      schedule,
      listSyncUnits: async () => [],
      syncUnit: async () => ({ itemsUpserted: 0, complete: true }),
    },
  });
}

describe("reconcileSchedulers", () => {
  it("schedules catalog-sync and tracked-refresh for a newly approved sync source", async () => {
    const queue = fakeQueue();
    await reconcileSchedulers(queue, [
      syncAdapter("shop_gb", { catalogCron: "0 4 * * *", trackedRefreshHours: 6 }),
    ]);
    expect(queue.upserted).toEqual([
      [
        "catalog-sync:shop_gb",
        { pattern: "0 4 * * *" },
        { name: "catalog-sync", data: { source: "shop_gb" } },
      ],
      [
        "tracked-refresh:shop_gb",
        { every: 6 * 3_600_000 },
        { name: "tracked-refresh", data: { source: "shop_gb" } },
      ],
    ]);
    expect(queue.removed).toEqual([]);
  });

  it("removes the schedulers of a source that is no longer in the registry", async () => {
    // A removed plugin must stop costing jobs, and a job naming a source the
    // worker cannot find throws "unknown sync source" on every firing.
    const queue = fakeQueue([
      "catalog-sync:gone",
      "tracked-refresh:gone",
      "catalog-sync:cex",
      "tracked-refresh:cex",
    ]);
    await reconcileSchedulers(queue, [
      syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
    ]);
    expect(queue.removed).toEqual(["catalog-sync:gone", "tracked-refresh:gone"]);
  });

  it("never removes a scheduler it does not recognise", async () => {
    // Only ids of the shape THIS worker creates are its business. The queue is
    // shared: `plugin-health` is this very tick's own heartbeat, and it carries
    // no source, so a reconciliation that matched on "not in the registry"
    // rather than on the id shape would delete the thing that reconciles.
    const queue = fakeQueue([
      "plugin-health",
      "some-other-app:job",
      "catalog-sync",
      "catalog-sync:",
      "tracked-refresh-legacy:cex",
    ]);
    await reconcileSchedulers(queue, [
      syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
    ]);
    expect(queue.removed).toEqual([]);
  });

  it("removes every scheduler when no sync source is served any more", async () => {
    // An empty list is a state a user can reach: disable or remove the last
    // sync plugin. Leaving its schedulers behind fires a nightly job
    // against a source the registry cannot name. The rebuild's health is the
    // caller's to establish (worker/index.ts rebuilds first and reconciles
    // second, so a failed rebuild throws before a single queue write).
    const queue = fakeQueue(["catalog-sync:cex", "tracked-refresh:cex", "catalog-sync:cex_es"]);
    await reconcileSchedulers(queue, []);
    expect(queue.removed).toEqual([
      "catalog-sync:cex",
      "tracked-refresh:cex",
      "catalog-sync:cex_es",
    ]);
    expect(queue.upserted).toEqual([]);
  });

  it("still leaves another owner's schedulers alone when it removes everything", async () => {
    // The id-shape rule of point 1 is what protects `plugin-health` — this
    // tick's own heartbeat — and it has to hold on the pass that removes the
    // most, not only when something survives.
    const queue = fakeQueue(["plugin-health", "some-other-app:job", "catalog-sync:cex"]);
    await reconcileSchedulers(queue, []);
    expect(queue.removed).toEqual(["catalog-sync:cex"]);
  });

  it("keeps the schedulers of a source that is still there", async () => {
    const queue = fakeQueue(["catalog-sync:cex", "tracked-refresh:cex"]);
    await reconcileSchedulers(queue, [
      syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
    ]);
    expect(queue.removed).toEqual([]);
    expect(queue.upserted.map(([id]) => id)).toEqual(["catalog-sync:cex", "tracked-refresh:cex"]);
  });

  it("does not re-upsert a scheduler whose cadence is already what the registry wants", async () => {
    // The tick runs every five minutes and bullmq's upsert always overrides:
    // its script deletes the pending iteration's job — from `delayed`, and by
    // LREM from `wait`, so one that has already come due is deleted too — and
    // for a cron `pattern` the replacement is computed in JS as the next
    // occurrence STRICTLY AFTER now. Re-upserting an unchanged nightly cron at
    // 03:00:05, while tonight's job waits for a busy single worker, therefore
    // deletes tonight's sweep and schedules tomorrow's, with nothing logged and
    // nothing failed. The nightly CeX catalogue refresh is what that would be.
    const queue = fakeQueue([
      { key: "catalog-sync:cex", pattern: "0 3 * * *" },
      { key: "tracked-refresh:cex", every: 4 * 3_600_000 },
    ]);
    await reconcileSchedulers(queue, [
      syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
    ]);
    expect(queue.upserted).toEqual([]);
    expect(queue.removed).toEqual([]);
  });

  it("upserts a scheduler that is missing, and one whose cadence changed", async () => {
    // The other branch: leaving an unchanged scheduler alone must not turn into
    // never creating one. A build that moved CeX's sweep an hour earlier, and a
    // plugin approved since the last tick, both have to land.
    const queue = fakeQueue([
      { key: "catalog-sync:cex", pattern: "0 2 * * *" },
      { key: "tracked-refresh:cex", every: 4 * 3_600_000 },
    ]);
    await reconcileSchedulers(queue, [
      syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
      syncAdapter("shop_gb", { catalogCron: "0 4 * * *", trackedRefreshHours: 6 }),
    ]);
    expect(queue.upserted).toEqual([
      [
        "catalog-sync:cex",
        { pattern: "0 3 * * *" },
        { name: "catalog-sync", data: { source: "cex" } },
      ],
      [
        "catalog-sync:shop_gb",
        { pattern: "0 4 * * *" },
        { name: "catalog-sync", data: { source: "shop_gb" } },
      ],
      [
        "tracked-refresh:shop_gb",
        { every: 6 * 3_600_000 },
        { name: "tracked-refresh", data: { source: "shop_gb" } },
      ],
    ]);
    expect(queue.removed).toEqual([]);
  });

  it("skips the catalog scheduler of a cron bullmq would throw on, and keeps the source", async () => {
    // The manifest validator checks the SHAPE of a cron and not its fields
    // (CRON_5 in packages/shared/src/pluginManifest.ts says so), so an approved
    // plugin can carry "99 99 99 99 99" — measured: cron-parser answers
    // "Constraint error, got value 99 expected range 0-59". bullmq parses the
    // pattern OUTSIDE its own try/catch (defaultRepeatStrategy in
    // classes/job-scheduler.js), so passing it on would reject out of
    // upsertJobScheduler and fail the whole tick: every source after this one
    // would lose its upsert and no removal would run, once every five minutes,
    // forever. The source stays WANTED so its own schedulers are not removed.
    const queue = fakeQueue([{ key: "catalog-sync:shop_gb", pattern: "0 4 * * *" }]);
    await reconcileSchedulers(queue, [
      syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
      syncAdapter("shop_gb", { catalogCron: "99 99 99 99 99", trackedRefreshHours: 6 }),
    ]);
    const ids = queue.upserted.map(([id]) => id);
    expect(ids).not.toContain("catalog-sync:shop_gb");
    expect(ids).toContain("tracked-refresh:shop_gb");
    expect(ids).toContain("catalog-sync:cex");
    expect(queue.removed).toEqual([]);
  });

  it("still creates its schedulers when the queue cannot say what it holds", async () => {
    // Only the boot caller reads the queue itself, and at boot a rejection has
    // nothing above it to catch: the worker would not start, and would sweep no
    // catalogue at all. bullmq can reject this read on a data condition (a
    // legacy repeatable key), not only on an outage, so the fallback is "assume
    // nothing exists and upsert" — which costs at most one postponed firing per
    // restart.
    const queue = fakeQueue();
    queue.getJobSchedulers = async () => {
      throw new Error("Legacy repeatable job metadata is not supported in BullMQ v6");
    };
    await expect(
      ensureSchedulers(queue, [
        syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
      ]),
    ).resolves.toEqual(new Set(["cex"]));
    expect(queue.upserted.map(([id]) => id)).toEqual(["catalog-sync:cex", "tracked-refresh:cex"]);
  });

  it("schedules nothing for a live source, and drops the catalog jobs it used to have", async () => {
    // A live source has no cadence to schedule from, and being in the registry
    // must not keep a stale catalog scheduler alive: a plugin re-approved as
    // live, or a market whose catalogue this build stopped sweeping, would
    // otherwise go on firing a job forever.
    const queue = fakeQueue(["catalog-sync:cex", "tracked-refresh:cex", "catalog-sync:vinted_uk"]);
    await reconcileSchedulers(queue, [
      syncAdapter("cex", { catalogCron: "0 3 * * *", trackedRefreshHours: 4 }),
      stubAdapter({ source: "vinted_uk" }),
    ]);
    expect(queue.upserted.map(([id]) => id)).toEqual(["catalog-sync:cex", "tracked-refresh:cex"]);
    expect(queue.removed).toEqual(["catalog-sync:vinted_uk"]);
  });
});
