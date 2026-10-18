import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { SidecarSyncCapability } from "../../../src/adapters/sidecar/sync.js";
import { SidecarAdapter } from "../../../src/adapters/sidecar/index.js";
import { RateLimiter } from "../../../src/lib/rateLimiter.js";
import { CircuitBreaker } from "../../../src/lib/circuitBreaker.js";
import { FakeCatalogSink } from "../../helpers/fakeCatalogSink.js";

const BASE = "http://shop:8000";
let agent: MockAgent;

function capability(overrides: Record<string, unknown> = {}): SidecarSyncCapability {
  return new SidecarSyncCapability({
    source: "shop_gb",
    baseUrl: BASE,
    schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
    approvedKinds: ["sell", "cash"],
    expectedCurrencies: ["GBP"],
    limiter: new RateLimiter(0),
    breaker: new CircuitBreaker({ failureThreshold: 5, holdMs: 1000 }),
    ...overrides,
  });
}

const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceProductId: id,
  title: `Game ${id}`,
  categoryText: "Game Boy Games",
  prices: { sell: 38, cash: 20 },
  currency: "GBP",
  available: true,
  ...extra,
});

/** One page of a unit, in the envelope protocol A.3 defines. */
const page = (
  rows: unknown[],
  next: string | null,
  complete: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ rows, next, complete, ...extra });

const unitPath = (unit: string, cursor?: string): string =>
  `/catalog/units/${unit}?source=shop_gb${cursor === undefined ? "" : `&cursor=${cursor}`}`;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
});

describe("listSyncUnits", () => {
  it("reads the plugin's units for this source", async () => {
    agent
      .get(BASE)
      .intercept({ path: "/catalog/units?source=shop_gb", method: "GET" })
      .reply(200, ["Game Boy Games", "SNES Games"]);
    await expect(capability().listSyncUnits()).resolves.toEqual(["Game Boy Games", "SNES Games"]);
  });

  it("refuses a unit that is not a non-empty string of at most 128 characters", async () => {
    agent.get(BASE).intercept({ path: "/catalog/units?source=shop_gb", method: "GET" }).reply(200, ["", "x"]);
    await expect(capability().listSyncUnits()).rejects.toThrow(/unit ""/);
  });

  /**
   * F12/F19 (whole-branch review, 2026-09-09): before the `typeof unit !==
   * "string"` check runs, `unit` is `unknown` and can be an object or array
   * bounded only by SIDECAR_SYNC_MAX_BYTES (16 MB) -- and the message this
   * throws is `err.message`, read verbatim by `worker/jobs.ts` and
   * `worker/index.ts`. `echo` must keep it short regardless of what was sent.
   */
  it("keeps the refusal short even when a unit is a huge object, not a bare unbounded echo", async () => {
    const huge = { junk: "x".repeat(10_000) };
    agent
      .get(BASE)
      .intercept({ path: "/catalog/units?source=shop_gb", method: "GET" })
      .reply(200, [huge, "x"]);
    await expect(capability().listSyncUnits()).rejects.toThrow(
      /unit .{0,90} is not a non-empty string of at most 128 characters/,
    );
  });

  /**
   * F13 (whole-branch review, 2026-09-09): a unit name reached
   * `catalog_items.sync_unit` (`text`) with none of the control-character
   * checks an id/title/categoryText gets on either transport, and Postgres
   * refuses U+0000 outright -- with `sink.upsert` running OUTSIDE the try
   * that guards a page, that throw would end the WHOLE unit, not one chunk.
   */
  it("refuses a unit name carrying a control character", async () => {
    const NUL = String.fromCharCode(0);
    agent
      .get(BASE)
      .intercept({ path: "/catalog/units?source=shop_gb", method: "GET" })
      .reply(200, [`Toys${NUL}`]);
    await expect(capability().listSyncUnits()).rejects.toThrow(/control character/);
  });

  it("refuses more than 200 units", async () => {
    // Each unit is a sweep of a whole category, run one after another: a list
    // this long describes a job that never finishes.
    agent
      .get(BASE)
      .intercept({ path: "/catalog/units?source=shop_gb", method: "GET" })
      .reply(200, Array.from({ length: 201 }, (_, i) => `Unit ${i}`));
    await expect(capability().listSyncUnits()).rejects.toThrow(/1 to 200 units/);
  });

  it("refuses the same unit twice", async () => {
    // `worker/jobs.ts` takes a fresh `runStartedAt` per unit, so a unit listed
    // twice is swept against two timestamps and the second sweep's
    // delete-unseen judges the first sweep's rows as unseen — removing every
    // one the second pass did not fetch again, and paying for the first pass at
    // the plugin's promised pace for nothing.
    agent
      .get(BASE)
      .intercept({ path: "/catalog/units?source=shop_gb", method: "GET" })
      .reply(200, ["Toys", "Toys"]);
    await expect(capability().listSyncUnits()).rejects.toThrow(/Toys is listed twice/);
  });

  it("refuses a unit named for a path segment the URL parser removes", async () => {
    // Measured with node's WHATWG URL: `/catalog/units/.` normalises to
    // `/catalog/units/` and `/catalog/units/..` to `/catalog/`, and encoding
    // harder does not save it — `%2E%2E` resolves to the same `/catalog/`,
    // since dot segments are matched after percent-decoding. So the app would
    // ask for a URL other than the one it meant. Refusing says so.
    expect(new URL(`http://shop:8000/catalog/units/${encodeURIComponent("..")}`).pathname).toBe("/catalog/");
    expect(new URL("http://shop:8000/catalog/units/%2E%2E").pathname).toBe("/catalog/");
    agent
      .get(BASE)
      .intercept({ path: "/catalog/units?source=shop_gb", method: "GET" })
      .reply(200, ["Toys", ".."]);
    await expect(capability().listSyncUnits()).rejects.toThrow(/the URL parser removes/);
  });
});

describe("syncUnit", () => {
  it("follows the cursor and feeds the app's sink page by page", async () => {
    agent
      .get(BASE)
      .intercept({ path: unitPath("Game%20Boy%20Games"), method: "GET" })
      .reply(200, page([row("A1"), row("A2")], "c2", false));
    agent
      .get(BASE)
      .intercept({ path: unitPath("Game%20Boy%20Games", "c2"), method: "GET" })
      .reply(200, page([row("A3")], null, true));

    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Game Boy Games", sink);
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1", "A2", "A3"]);
    // fed page by page, not in one batch at the end: what arrived is stored
    expect(sink.batches).toHaveLength(2);
    // prices reach the sink as the string form catalog_items stores
    expect(sink.all[0].prices).toEqual({ sell: "38.00", cash: "20.00" });
    expect(sink.all[0].currency).toBe("GBP");
    expect(report).toEqual({ itemsUpserted: 3, complete: true });
  });

  it("percent-encodes the unit into the path and gets the same string back", async () => {
    // The unit is a path SEGMENT, and a plugin may well name a category with a
    // slash, a space, a percent sign or an accent. Encoded wrong it becomes a
    // second path segment or a broken byte, and the plugin answers about a
    // category nobody asked for.
    const unit = "Toys/Games 50% café";
    const encoded = "Toys%2FGames%2050%25%20caf%C3%A9";
    expect(decodeURIComponent(encoded)).toBe(unit);
    agent
      .get(BASE)
      .intercept({ path: unitPath(encoded), method: "GET" })
      .reply(200, page([row("A1")], null, true));
    const report = await capability().syncUnit(unit, new FakeCatalogSink());
    expect(report.itemsUpserted).toBe(1);
    agent.assertNoPendingInterceptors();
  });

  it("carries the answer of the page that ENDED the unit, and its note", async () => {
    // `complete` means "every item of this unit was in the pages", so the page
    // that ends the unit is the one that can answer it. Note what this case
    // does NOT prove: with the pages walked in order, the last assignment wins
    // whether or not the reading is guarded. The test below is the one that
    // holds the guard down.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1")], "c2", true));
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys", "c2"), method: "GET" })
      .reply(200, page([row("A2")], null, false, { notes: "hit the 1000-hit ceiling" }));
    const report = await capability().syncUnit("Toys", new FakeCatalogSink());
    expect(report.complete).toBe(false);
    expect(report.notes).toMatch(/ceiling/);
  });

  it("never lets a MIDDLE page's `complete: true` end a unit that stopped early", async () => {
    // The guard, and the deletion that proves it: reading `complete` on every
    // page instead of only on the one whose `next` is null. The ordinary
    // two-page case above survives that change — the last page assigns last —
    // but a unit that stops before any last page then carries a middle page's
    // claim, and the worker deletes every row it did not see. Measured against
    // the real sink with the guard removed: the previous sweep's row was gone.
    for (let i = 0; i < 2; i += 1) {
      agent
        .get(BASE)
        .intercept({ path: i === 0 ? unitPath("Toys") : unitPath("Toys", `c${i}`), method: "GET" })
        .reply(200, page([row(`A${i}`)], `c${i + 1}`, true));
    }
    const report = await capability({ maxPages: 2 }).syncUnit("Toys", new FakeCatalogSink());
    expect(report.complete).toBe(false);
  });

  it("does not let a middle page's `false` deny a last page's `true`", async () => {
    // The other direction of the same rule, so "last page wins" cannot be
    // mistaken for "any false wins".
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1")], "c2", false));
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys", "c2"), method: "GET" })
      .reply(200, page([row("A2")], null, true));
    await expect(capability().syncUnit("Toys", new FakeCatalogSink())).resolves.toEqual({
      itemsUpserted: 2,
      complete: true,
    });
  });

  it("refuses a page that does not answer whether it completed the unit", async () => {
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, { rows: [row("A1")], next: null });
    await expect(capability().syncUnit("Toys", new FakeCatalogSink())).rejects.toThrow(
      /complete must be a boolean/,
    );
  });

  it("refuses to ask for a unit whose name the URL parser would remove", async () => {
    // Guarded in `syncUnit` as well as in the listing, because a unit reaches
    // it from a queue payload that may have been enqueued long ago. No
    // interceptor: a request would fail the test rather than pass quietly.
    await expect(capability().syncUnit("..", new FakeCatalogSink())).rejects.toThrow(
      /the URL parser removes/,
    );
    await expect(capability().syncUnit(".", new FakeCatalogSink())).rejects.toThrow(
      /the URL parser removes/,
    );
  });

  it("keeps a row for its approved kinds and drops the others", async () => {
    // The whole page carries a kind the user did not approve, which is what a
    // plugin serving sell/cash/voucher to a sell-only approval looks like. The
    // old rule condemned every such row, so this page produced nothing usable,
    // the page counted as wholly malformed, and the sweep threw — a source that
    // never syncs, forever, with no explanation on any screen.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(
        200,
        page(
          [
            row("A1", { prices: { sell: 38, voucher: 26 } }),
            row("A2", { prices: { voucher: 26 } }),
          ],
          null,
          true,
        ),
      );
    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Toys", sink);
    // A1 keeps its approved price; A2 had nothing left to store, so it is gone
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1"]);
    expect(sink.all[0].prices).toEqual({ sell: "38.00" });
    expect(report.complete).toBe(true);
  });

  it("drops a malformed row and keeps the rest of the page", async () => {
    // Six rows, three of them unreadable: exactly the readable half, which is
    // the boundary at which a page may still end a unit as COMPLETE. One row
    // fewer on the good side and the sweep would withhold that claim (the test
    // below), which is the deletion gate and not a judgement about these rows.
    agent.get(BASE).intercept({ path: unitPath("Toys"), method: "GET" }).reply(
      200,
      page(
        [
          row("A1"),
          { sourceProductId: "A2" },
          row("A3", { currency: "EUR" }),
          row("A4", { prices: { voucher: 10 } }),
          row("A5"),
          row("A6"),
        ],
        null,
        true,
      ),
    );
    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Toys", sink);
    // A2 has no title; A3 quotes a currency this source's site does not;
    // A4 has no price left once the unapproved voucher is dropped.
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1", "A5", "A6"]);
    expect(report).toEqual({ itemsUpserted: 3, complete: true });
  });

  it("will not report a mostly unreadable page complete, however it claims", async () => {
    // One readable row among many broken ones is the same evidence as none, and
    // `complete` on it authorises deleting every stored row of the category the
    // sweep could not read. The rows that DID parse are still stored: the rule
    // withholds the irreversible step, it does not throw the page away.
    agent.get(BASE).intercept({ path: unitPath("Toys"), method: "GET" }).reply(
      200,
      page([row("A1"), { nope: 1 }, { nope: 2 }, { nope: 3 }], null, true),
    );
    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Toys", sink);
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1"]);
    expect(report.complete).toBe(false);
    expect(report.notes).toMatch(/readable share/);
  });

  it("will not report a sweep that stored NOTHING complete", async () => {
    // A page of zero rows passes every other check in this file happily — it is
    // not malformed, it is not over any cap, and its `complete: true` would let
    // the worker delete the whole category. A sweep that stored nothing saw
    // nothing, and a plugin is the least trusted process in the stack.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([], null, true));
    const report = await capability().syncUnit("Toys", new FakeCatalogSink());
    expect(report).toEqual({
      itemsUpserted: 0,
      complete: false,
      notes: "the sweep stored no row at all, so it is not reported complete",
    });
  });

  it("keeps the first of two rows sharing an id in one page", async () => {
    // Measured against the real sink (worker/catalogSink.ts): it upserts in
    // CHUNKS of 500, so two rows sharing an id land in one statement when they
    // fall in one chunk — and Postgres then refuses that statement with "ON
    // CONFLICT DO UPDATE command cannot affect row a second time" — while
    // across a chunk boundary the second silently overwrites the first. Passing
    // the duplicate on would make one page answer differently depending on
    // where in it the repeat fell, and in the failing case cost the whole unit:
    // `sink.upsert` runs outside `syncUnit`'s try.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1"), row("A1", { title: "Game A1 again" }), row("A2")], null, true));
    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Toys", sink);
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1", "A2"]);
    expect(sink.all[0].title).toBe("Game A1");
    expect(report.itemsUpserted).toBe(2);
  });

  it("fails the page when every row of it is malformed", async () => {
    // Not "a unit with nothing in it" — that is what a plugin looks like when
    // its source redesigned something underneath it, and a page that reported
    // itself complete would then have deleted the whole unit.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([{ nope: 1 }, { nope: 2 }], null, true));
    await expect(capability().syncUnit("Toys", new FakeCatalogSink())).rejects.toThrow(/malformed/);
  });

  it("leaves the unit incomplete when a LATER page is entirely malformed", async () => {
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1")], "c2", true));
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys", "c2"), method: "GET" })
      .reply(200, page([{ nope: 1 }], null, true));
    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Toys", sink);
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1"]);
    expect(report.complete).toBe(false);
    expect(report.notes).toMatch(/page 2 failed.*malformed/);
  });

  it("refuses a page with more rows than the cap", async () => {
    // One row over, so the cap is the boundary and not a rounding.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1"), row("A2"), row("A3")], null, true));
    await expect(
      capability({ maxRowsPerPage: 2 }).syncUnit("Toys", new FakeCatalogSink()),
    ).rejects.toThrow(/3 rows, over the 2-row cap/);
  });

  it("accepts a page exactly at the cap", async () => {
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1"), row("A2")], null, true));
    await expect(
      capability({ maxRowsPerPage: 2 }).syncUnit("Toys", new FakeCatalogSink()),
    ).resolves.toEqual({ itemsUpserted: 2, complete: true });
  });

  it("stops at the page cap and reports the unit incomplete rather than looping forever", async () => {
    for (let i = 0; i < 3; i += 1) {
      agent
        .get(BASE)
        .intercept({
          path: i === 0 ? unitPath("Toys") : unitPath("Toys", `c${i}`),
          method: "GET",
        })
        .reply(200, page([row(`A${i}`)], `c${i + 1}`, true));
    }
    const report = await capability({ maxPages: 3 }).syncUnit("Toys", new FakeCatalogSink());
    expect(report.complete).toBe(false);
    expect(report.notes).toMatch(/3-page cap/);
    agent.assertNoPendingInterceptors();
  });

  it("stops the moment a cursor stops advancing, without spending the whole cap", async () => {
    // A plugin that answers with the cursor it was just given never ends. The
    // page cap would catch it too, ninety-odd paced requests later.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1")], "c2", true));
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys", "c2"), method: "GET" })
      .reply(200, page([row("A2")], "c2", true))
      .times(2);
    const report = await capability({ maxPages: 50 }).syncUnit("Toys", new FakeCatalogSink());
    expect(report.complete).toBe(false);
    expect(report.notes).toMatch(/repeated a cursor/);
    // the second page was requested once, not fifty times
    expect(report.itemsUpserted).toBe(2);
  });

  it("refuses a cursor that is not a non-empty string", async () => {
    // An empty cursor is not a page to ask for; it would ask for the FIRST
    // page again under a different URL, forever.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1")], "", true));
    await expect(capability().syncUnit("Toys", new FakeCatalogSink())).rejects.toThrow(/next must be null/);
  });

  it("asks the plugin for a cursor it then refuses, and keeps what arrived", async () => {
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1")], "c2", true));
    agent.get(BASE).intercept({ path: unitPath("Toys", "c2"), method: "GET" }).reply(400, "unknown cursor");
    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Toys", sink);
    expect(sink.all).toHaveLength(1);
    expect(report.complete).toBe(false);
    expect(report.notes).toMatch(/HTTP 400/);
  });

  it("keeps what arrived when a later page fails, and throws when the FIRST one does", async () => {
    // Partial evidence is still evidence: the rows that arrived are stored and
    // the unit is incomplete, so delete-unseen is skipped and the old rows
    // survive. A unit that produced nothing at all is a failed job.
    agent
      .get(BASE)
      .intercept({ path: unitPath("Toys"), method: "GET" })
      .reply(200, page([row("A1")], "c2", true));
    agent.get(BASE).intercept({ path: unitPath("Toys", "c2"), method: "GET" }).reply(500, "");
    const sink = new FakeCatalogSink();
    const report = await capability().syncUnit("Toys", sink);
    expect(sink.all).toHaveLength(1);
    expect(report.complete).toBe(false);

    agent.get(BASE).intercept({ path: unitPath("Empty"), method: "GET" }).reply(500, "");
    await expect(capability().syncUnit("Empty", new FakeCatalogSink())).rejects.toThrow(/HTTP 500/);
  });
});

describe("refreshItems", () => {
  it("posts the ids and upserts what came back", async () => {
    agent
      .get(BASE)
      .intercept({ path: "/catalog/refresh", method: "POST", body: JSON.stringify({ source: "shop_gb", ids: ["A1", "A2"] }) })
      .reply(200, { rows: [row("A1")] });
    const sink = new FakeCatalogSink();
    await capability().refreshItems(["A1", "A2"], sink);
    // A2 is missing from the answer: "delisted or unknown". The stored row is
    // LEFT for the nightly delete-unseen, exactly as a null answer does today.
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1"]);
  });

  it("ignores a row about a product it did not ask for", async () => {
    // It would land through the DETAIL sink, which touches neither
    // `last_seen_at` nor `sync_unit` on an existing row — so nothing but the
    // 30-day stale sweep would ever remove it again.
    agent
      .get(BASE)
      .intercept({ path: "/catalog/refresh", method: "POST" })
      .reply(200, { rows: [row("A1"), row("Z9")] });
    const sink = new FakeCatalogSink();
    await capability().refreshItems(["A1"], sink);
    expect(sink.all.map((i) => i.sourceProductId)).toEqual(["A1"]);
  });

  it("splits a long id list into several calls rather than one enormous body", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `A${i}`);
    const bodies: string[] = [];
    agent
      .get(BASE)
      .intercept({ path: "/catalog/refresh", method: "POST" })
      .reply(200, (opts) => {
        bodies.push(String(opts.body));
        return { rows: [] };
      })
      .times(2);
    await capability().refreshItems(ids, new FakeCatalogSink());
    expect(bodies).toHaveLength(2);
    expect((JSON.parse(bodies[0]) as { ids: string[] }).ids).toHaveLength(200);
    expect((JSON.parse(bodies[1]) as { ids: string[] }).ids).toEqual(["A200"]);
  });

  it("refuses an answer that is not { rows }", async () => {
    agent.get(BASE).intercept({ path: "/catalog/refresh", method: "POST" }).reply(200, [row("A1")]);
    await expect(capability().refreshItems(["A1"], new FakeCatalogSink())).rejects.toThrow(
      /did not answer \{ rows \}/,
    );
  });
});

describe("the plugin's pacing and breaker", () => {
  it("counts a catalog failure against the SAME breaker the live traffic uses", async () => {
    // One plugin is one process behind one base URL: a sweep that is failing
    // and a game view are the same conversation, and a breaker that only
    // watched /search would keep calling a plugin already known to be unwell.
    //
    // So the LIVE half is exercised here too, with a SidecarAdapter holding the
    // same two instances `sources/registry.ts` hands every source of one
    // plugin. Without it this test only ever proved a breaker stops its own
    // caller, which is a property of the breaker and not of the sharing.
    const breaker = new CircuitBreaker({ failureThreshold: 1, holdMs: 60_000 });
    const limiter = new RateLimiter(0);
    const capabilities = capability({ breaker, limiter });
    const live = new SidecarAdapter({
      source: "shop_gb",
      baseUrl: BASE,
      snapshotStrategy: "per_listing",
      declaredKinds: ["sell", "cash"],
      expectedCurrencies: ["GBP"],
      limiter,
      breaker,
    });
    agent.get(BASE).intercept({ path: unitPath("Toys"), method: "GET" }).reply(500, "");
    await expect(capabilities.syncUnit("Toys", new FakeCatalogSink())).rejects.toThrow(/HTTP 500/);
    // no interceptor for either call below: an open breaker must not reach the
    // wire, from the sweep OR from the game view
    await expect(capabilities.listSyncUnits()).rejects.toThrow(/circuit open/);
    await expect(live.search("Super Mario 64")).rejects.toThrow(/circuit open/);
  });

  it("counts a LIVE failure against the sweep's breaker, in the same direction", async () => {
    // The other direction of the same sharing: a plugin failing on game views
    // must not then be swept for a whole catalogue at three seconds a page.
    const breaker = new CircuitBreaker({ failureThreshold: 1, holdMs: 60_000 });
    const limiter = new RateLimiter(0);
    const live = new SidecarAdapter({
      source: "shop_gb",
      baseUrl: BASE,
      snapshotStrategy: "per_listing",
      declaredKinds: ["sell", "cash"],
      expectedCurrencies: ["GBP"],
      limiter,
      breaker,
    });
    agent
      .get(BASE)
      .intercept({ path: "/search?source=shop_gb&q=Super+Mario+64", method: "GET" })
      .reply(500, "");
    await expect(live.search("Super Mario 64")).rejects.toThrow();
    await expect(
      capability({ breaker, limiter }).syncUnit("Toys", new FakeCatalogSink()),
    ).rejects.toThrow(/circuit open/);
  });
});
