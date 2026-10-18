import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/index.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

/**
 * A `Db` that can hold ONE read open until the test says otherwise.
 *
 * The interleaving `reloadSources()` serialises is a race between two reads of
 * the `plugins` table and the two assignments that follow them, so observing
 * it needs the reads ordered rather than raced — and ordered from the TEST,
 * because production code has no hook for it and must not grow one. The seam
 * used here already exists: `buildApp` takes its `db`, so a test can hand it
 * one that reports when a query has run and waits to be let go.
 *
 * `armNext` arms exactly one query — the next one awaited through this db —
 * and disarms itself, so only the rebuild the test is timing is affected and
 * every other query (including the app's boot rebuild) runs at full speed.
 * Nothing here changes what a query RETURNS: the rows are the real rows, read
 * at the real moment.
 */
function gatedDb(db: Db): { db: Db; armNext: (hook: () => Promise<void>) => void } {
  let pending: (() => Promise<void>) | null = null;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        // `then` is where a drizzle builder actually executes. It is always
        // replaced by a bound wrapper, armed or not: handing the raw method
        // back would let `await` call it with the PROXY as `this`, and
        // drizzle's private fields do not survive that.
        if (prop === "then") {
          const hook = pending;
          pending = null;
          return (onOk: unknown, onErr: unknown) =>
            (async () => {
              const rows = await (t as PromiseLike<unknown>);
              if (hook) await hook();
              return rows;
            })().then(
              onOk as Parameters<Promise<unknown>["then"]>[0],
              onErr as Parameters<Promise<unknown>["then"]>[1],
            );
        }
        const value = Reflect.get(t, prop, t);
        if (typeof value !== "function") return value;
        // methods run against the REAL object and their object results are
        // wrapped again, so a whole builder chain stays gated
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(t, args);
          return typeof result === "object" && result !== null ? wrap(result) : result;
        };
      },
    });
  return {
    db: wrap(db as unknown as object) as Db,
    armNext: (hook) => {
      pending = hook;
    },
  };
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
      kindRoles: { sell: "buy_store" },
      kindLabels: { sell: "Shop GB sells for" },
    },
  ],
});

describe.skipIf(ctx === null)("two overlapping reloadSources() calls", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  /** Import and approve one plugin, through the UNGATED db so no test timing
   * depends on the fixture's own queries. */
  const approvedPlugin = async (): Promise<void> => {
    const row = await insertPlugin(ctx!.db, {
      baseUrl: "http://shop:8000",
      name: "shop",
      version: "1.0.0",
      manifestSeen: manifest(),
      lastHealth: { status: "ok", protocol: 2, configured: true },
    });
    const reviewed = (await getPlugin(ctx!.db, row.id))!.manifestSeen!;
    expect(await approvePlugin(ctx!.db, row.id, { shop_gb: ["sell"] }, reviewed)).toEqual({
      ok: true,
    });
  };

  const buildGated = async (): Promise<{
    app: Awaited<ReturnType<typeof buildApp>>;
    armNext: (hook: () => Promise<void>) => void;
  }> => {
    const gated = gatedDb(ctx!.db);
    const app = await buildApp({ db: gated.db, registry: [stubAdapter({ source: "cex" })] });
    return { app, armNext: gated.armNext };
  };

  it("reads the table it was told about, gate and all", async () => {
    // The fixture proving itself: the two views the ordering test plays off
    // each other are genuinely different, and the gated db returns real rows.
    const { app, armNext } = await buildGated();
    expect(app.deps.sources.has("shop_gb")).toBe(false);
    await approvedPlugin();

    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    armNext(() => gate);
    const reload = app.deps.reloadSources();
    // still the boot-time view while the read is held open
    expect(app.deps.sources.has("shop_gb")).toBe(false);
    open();
    await reload;
    expect(app.deps.sources.has("shop_gb")).toBe(true);
    await app.close();
  });

  it("leaves the LAST caller's view standing, not the last to finish", async () => {
    /**
     * The property `chain = chain.then(rebuild, rebuild)` exists for. Each
     * rebuild READS the `plugins` table and only then ASSIGNS, so unserialised
     * the winner is whichever read RESOLVES last — which can be the one that
     * started first, and therefore the one holding the older view. Here the
     * user approves a plugin, an approval-triggered rebuild reads the row,
     * the user then disables it, and a second rebuild follows: the deployment
     * must end up without the disabled plugin's source, not serving it until
     * something else happens to rebuild.
     *
     * The read of the FIRST rebuild is held open until after the second call
     * has had every chance to run, so "finished last" and "called last" are
     * different plugins' worth of registry and the assertion can only be
     * satisfied by the chaining.
     */
    const { app, armNext } = await buildGated();
    await approvedPlugin();

    let releaseFirstRead!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let firstReadDone!: () => void;
    const sawTheApprovedRow = new Promise<void>((resolve) => {
      firstReadDone = resolve;
    });
    armNext(async () => {
      firstReadDone();
      await held;
    });

    const first = app.deps.reloadSources();
    // rebuild #1 has now READ the plugins table, with the plugin approved
    await sawTheApprovedRow;

    // ...and the user disables it before that rebuild has assigned anything
    await ctx!.db.execute("UPDATE plugins SET status = 'disabled'");

    const second = app.deps.reloadSources();
    // an unserialised second rebuild is free to read and assign right now;
    // this gives it far more time than it needs to
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFirstRead();
    await Promise.all([first, second]);

    // the disable was the last thing the user did, so it is the view the
    // deployment is left holding
    expect(app.deps.sources.has("shop_gb")).toBe(false);
    expect(app.deps.sources.get("shop_gb")).toBeUndefined();
    await app.close();
  });
});
