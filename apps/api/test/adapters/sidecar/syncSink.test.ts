import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MockAgent, setGlobalDispatcher } from "undici";
import { setupTestDb } from "../../helpers/testDb.js";
import { catalogItems } from "../../../src/db/schema.js";
import { saveEnabledSources } from "../../../src/settings/markets.js";
import { loadRanAt, makeBulkSink } from "../../../src/worker/catalogSink.js";
import { runCatalogSyncUnit } from "../../../src/worker/jobs.js";
import { PluginCatalogAdapter } from "../../../src/adapters/sidecar/catalogAdapter.js";
import { SidecarSyncCapability } from "../../../src/adapters/sidecar/sync.js";
import { RateLimiter } from "../../../src/lib/rateLimiter.js";
import { CircuitBreaker } from "../../../src/lib/circuitBreaker.js";

/**
 * The delete-unseen rule, driven by the real worker job against the real
 * database — not a fake sink.
 *
 * This is the one place in the plugin protocol where a plugin's momentary
 * hiccup can destroy data the app cannot re-fetch: a unit reported COMPLETE
 * makes `deleteUnseen` remove every row of that unit the run did not see. Each
 * test here therefore asserts on the surviving ROWS, which is what the user
 * would lose, rather than on the report that led to them.
 */
let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const BASE = "http://shop:8000";
const SOURCE = "shop_gb";
let agent: MockAgent;

const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceProductId: id,
  title: `Game ${id}`,
  categoryText: "Toys",
  prices: { sell: 38, cash: 20 },
  currency: "GBP",
  available: true,
  ...extra,
});

const page = (
  rows: unknown[],
  next: string | null,
  complete: boolean,
): Record<string, unknown> => ({ rows, next, complete });

const unitPath = (cursor?: string): string =>
  `/catalog/units/Toys?source=${SOURCE}${cursor === undefined ? "" : `&cursor=${cursor}`}`;

function adapter(overrides: Record<string, unknown> = {}): PluginCatalogAdapter {
  return new PluginCatalogAdapter({
    db: ctx!.db,
    source: SOURCE,
    baseUrl: BASE,
    snapshotStrategy: "per_listing",
    family: "shop",
    declaredKinds: ["sell", "cash"],
    expectedCurrencies: ["GBP"],
    catalogSync: new SidecarSyncCapability({
      source: SOURCE,
      baseUrl: BASE,
      schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
      approvedKinds: ["sell", "cash"],
      expectedCurrencies: ["GBP"],
      limiter: new RateLimiter(0),
      breaker: new CircuitBreaker({ failureThreshold: 5, holdMs: 1000 }),
      ...overrides,
    }),
  });
}

/** A row the previous sweep stored, which this run may or may not see again. */
async function seedStoredRow(id: string): Promise<void> {
  await makeBulkSink(ctx!.db, SOURCE, "Toys", new Date("2026-09-01T03:00:00Z")).upsert([
    {
      sourceProductId: id,
      title: `Game ${id}`,
      categoryText: "Toys",
      prices: { sell: "38.00" },
      currency: "GBP",
    },
  ]);
}

const storedIds = async (): Promise<string[]> =>
  (await ctx!.db.select().from(catalogItems).where(eq(catalogItems.source, SOURCE)))
    .map((r) => r.sourceProductId)
    .sort();

describe.skipIf(ctx === null)("a plugin's catalog sweep against the real sink", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    await saveEnabledSources(ctx!.db, [SOURCE]);
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });
  afterAll(async () => ctx?.pool.end());

  it("deletes the rows a COMPLETE sweep did not see", async () => {
    // The mechanism the tests below are about: without this one passing,
    // "nothing was deleted" would prove nothing.
    await seedStoredRow("OLD");
    agent.get(BASE).intercept({ path: unitPath(), method: "GET" }).reply(200, page([row("A1")], null, true));
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    expect(await storedIds()).toEqual(["A1"]);
  });

  it("keeps them when a sweep stores NOTHING but claims to be complete", async () => {
    // The cheapest way for a plugin to destroy this app's data: answer one
    // page of zero rows with `complete: true`. Nothing above this line refuses
    // it — it is not malformed, not over a cap, and its cursor ends the unit —
    // so the worker would delete every stored row of the category.
    //
    // What it costs: a category the shop GENUINELY emptied keeps these rows
    // until `sweepStale` removes them 30 days later. That is the right side to
    // be wrong on, because the other side is a plugin hiccup wiping a
    // catalogue the app then cannot price a single game against.
    await seedStoredRow("OLD");
    agent.get(BASE).intercept({ path: unitPath(), method: "GET" }).reply(200, page([], null, true));
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    expect(await storedIds()).toEqual(["OLD"]);
  });

  it("keeps them when only one row of a page survives", async () => {
    // The same deletion, bought for one usable row instead of none. The
    // survivor is stored; what is withheld is the claim that entitles the
    // worker to delete everything the sweep could not read.
    await seedStoredRow("OLD");
    const rows: unknown[] = [row("A1")];
    for (let i = 0; i < 9; i += 1) rows.push({ nope: i });
    agent.get(BASE).intercept({ path: unitPath(), method: "GET" }).reply(200, page(rows, null, true));
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    expect(await storedIds()).toEqual(["A1", "OLD"]);
  });

  it("drops a row carrying a NUL byte instead of losing the page to it", async () => {
    // Postgres refuses U+0000 in text and in jsonb alike, and `sink.upsert`
    // runs OUTSIDE the try that guards a page — so an unchecked row of this
    // shape does not cost itself, it costs the whole unit. Both halves are
    // measured here: that the database really refuses it, and that the page
    // survives because the parser got there first.
    const NUL = String.fromCharCode(0);
    await expect(
      makeBulkSink(ctx!.db, SOURCE, "Toys", new Date()).upsert([
        {
          sourceProductId: "NUL",
          title: `Game${NUL}`,
          categoryText: "Toys",
          prices: { sell: "38.00" },
          currency: "GBP",
        },
      ]),
    ).rejects.toThrow();
    await ctx!.truncateAll();
    await saveEnabledSources(ctx!.db, [SOURCE]);
    agent
      .get(BASE)
      .intercept({ path: unitPath(), method: "GET" })
      .reply(
        200,
        page(
          [
            row("A1"),
            row("BAD", { title: `Game${NUL}` }),
            // sourceMetadata is an ignored key (S3b): a NUL inside it never
            // reaches the database, so this row is NOT dropped — it is kept
            // here to pin exactly that.
            row("META", { sourceMetadata: { note: `a${NUL}b` } }),
            row("A2"),
          ],
          null,
          true,
        ),
      );
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    expect(await storedIds()).toEqual(["A1", "A2", "META"]);
  });

  it("keeps them when a page fails mid-unit", async () => {
    // A plugin that dies halfway through a category has not told the app that
    // category is empty. Deleting here would wipe a catalogue the app then
    // cannot price against, on the strength of one failed request.
    await seedStoredRow("OLD");
    agent
      .get(BASE)
      .intercept({ path: unitPath(), method: "GET" })
      .reply(200, page([row("A1")], "c2", true));
    agent.get(BASE).intercept({ path: unitPath("c2"), method: "GET" }).reply(500, "");
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    expect(await storedIds()).toEqual(["A1", "OLD"]);
  });

  it("keeps them when the unit hits the page cap", async () => {
    await seedStoredRow("OLD");
    for (let i = 0; i < 2; i += 1) {
      agent
        .get(BASE)
        .intercept({ path: i === 0 ? unitPath() : unitPath(`c${i}`), method: "GET" })
        .reply(200, page([row(`A${i}`)], `c${i + 1}`, true));
    }
    await runCatalogSyncUnit(ctx!.db, adapter({ maxPages: 2 }), "Toys");
    expect(await storedIds()).toEqual(["A0", "A1", "OLD"]);
  });

  it("keeps them when EVERY row of a later page is malformed", async () => {
    await seedStoredRow("OLD");
    agent
      .get(BASE)
      .intercept({ path: unitPath(), method: "GET" })
      .reply(200, page([row("A1")], "c2", true));
    agent
      .get(BASE)
      .intercept({ path: unitPath("c2"), method: "GET" })
      .reply(200, page([{ nope: 1 }], null, true));
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    expect(await storedIds()).toEqual(["A1", "OLD"]);
  });

  it("fails the job outright when the FIRST page fails, and records no run", async () => {
    // A unit that produced nothing at all is a failed job, not an empty
    // catalogue — and a sync_state marker would tell the boot catch-up this
    // unit is fresh, so the next chance to notice would be tomorrow's cron.
    await seedStoredRow("OLD");
    agent.get(BASE).intercept({ path: unitPath(), method: "GET" }).reply(500, "");
    await expect(runCatalogSyncUnit(ctx!.db, adapter(), "Toys")).rejects.toThrow(/HTTP 500/);
    expect(await storedIds()).toEqual(["OLD"]);
    expect(await loadRanAt(ctx!.db, `catalog-sync:${SOURCE}:Toys`)).toBeNull();
  });

  it("survives a page that names the same product twice", async () => {
    // Measured: the sink upserts in chunks of 500, and Postgres refuses a
    // statement that touches a row twice ("ON CONFLICT DO UPDATE command cannot
    // affect row a second time") — so a duplicate inside one chunk costs the
    // whole sweep (upsert runs outside syncUnit's try), while one straddling a
    // chunk boundary would instead let the second row silently overwrite the
    // first. Deduplicating is what makes the page mean one thing either way.
    agent
      .get(BASE)
      .intercept({ path: unitPath(), method: "GET" })
      .reply(200, page([row("A1"), row("A1", { title: "Game A1 again" }), row("A2")], null, true));
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    expect(await storedIds()).toEqual(["A1", "A2"]);
  });

  it("writes amounts a price column can hold, and drops the ones it cannot", async () => {
    // catalog_items.prices is jsonb TEXT, so a bad string is stored happily
    // and only explodes later, at the first game view that matches the row.
    // The pricing service catches it per source (service.ts), so that one
    // source's block reports `error` and shows whatever was stored before,
    // labelled old — for that game. Nothing says which row is unreadable, and
    // the row keeps sitting in the catalogue, so the same game breaks again on
    // every view until someone goes looking. That is why the amount is
    // refused here, at the door, rather than stored and discovered later.
    agent
      .get(BASE)
      .intercept({ path: unitPath(), method: "GET" })
      .reply(
        200,
        page(
          [
            row("ROUND", { prices: { sell: 0.1 + 0.2, cash: 38.567 } }),
            row("ZERO", { prices: { sell: 0 } }),
            row("CEILING", { prices: { sell: 99_999_999.99 } }),
            row("HUGE", { prices: { sell: 1e21 } }),
            row("BIG", { prices: { sell: Number.MAX_SAFE_INTEGER } }),
          ],
          null,
          true,
        ),
      );
    await runCatalogSyncUnit(ctx!.db, adapter(), "Toys");
    const rows = await ctx!.db.select().from(catalogItems).where(eq(catalogItems.source, SOURCE));
    const byId = new Map(rows.map((r) => [r.sourceProductId, r.prices]));
    expect([...byId.keys()].sort()).toEqual(["CEILING", "ROUND", "ZERO"]);
    // two decimals, the precision the price columns keep — never
    // "0.30000000000000004", and never exponential notation
    expect(byId.get("ROUND")).toEqual({ sell: "0.30", cash: "38.57" });
    expect(byId.get("ZERO")).toEqual({ sell: "0.00" });
    expect(byId.get("CEILING")).toEqual({ sell: "99999999.99" });
    // and every one of them is a value the price column actually accepts
    for (const prices of byId.values()) {
      for (const amount of Object.values(prices)) {
        await expect(
          ctx!.db.execute(`SELECT '${amount}'::numeric(10,2)`),
        ).resolves.toBeDefined();
      }
    }
  });
});
