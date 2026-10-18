import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import type { SourceId } from "@retrowatchdog/shared";
import { SidecarAdapter } from "../../../src/adapters/sidecar/index.js";
import { SidecarHttpError, SidecarProtocolError } from "../../../src/adapters/sidecar/protocol.js";
import { NotConfiguredError } from "../../../src/adapters/types.js";
import { RateLimiter } from "../../../src/lib/rateLimiter.js";
import { CircuitBreaker, CircuitOpenError } from "../../../src/lib/circuitBreaker.js";

/**
 * The generic adapter every community source reuses. It is the app's half of
 * docs/sidecar-protocol.md: it paces the sidecar, breaks the circuit when the
 * sidecar is unwell, bounds every request, validates what comes back and
 * classifies it with the app's own pipeline.
 *
 * The fake sidecar below is an undici MockAgent, so no test in this file ever
 * reaches a network. `community_demo` stands in for a real source id on
 * purpose: this stage ships the protocol and the adapter, not a source.
 */
/**
 * The adapter's logger is module-level, and pino writes straight to fd 1
 * through SonicBoom rather than through `process.stdout.write` (measured on
 * this machine: a spy on `process.stdout.write` counts zero calls for a
 * `log.warn`). So neither a spy on the instance nor one on the stream can see
 * a line, and mocking the module is the only seam.
 *
 * It is needed for exactly one property, and a COUNT is the whole of it: the
 * report of kinds a source is not approved for is emitted ONCE PER BATCH, not
 * once per row. A plugin that sends an unapproved kind sends it on every row,
 * so per-row would bury the reasons that really are about one row each.
 */
const { logged } = vi.hoisted(() => ({
  logged: [] as { msg: string; obj: Record<string, unknown> }[],
}));
vi.mock("pino", () => {
  const record = (obj: unknown, msg?: string): void => {
    if (typeof obj === "string") logged.push({ msg: obj, obj: {} });
    else logged.push({ msg: msg ?? "", obj: (obj ?? {}) as Record<string, unknown> });
  };
  const logger = {
    fatal: record,
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    child: () => logger,
  };
  return { default: () => logger };
});

const ORIGIN = "http://sidecar.test:8000";
const SOURCE = "community_demo" as SourceId;

/** U+0000: never safe to paste raw into a source file, or to echo into a log line. */
const NUL = String.fromCharCode(0);

const listing = (id: string, title: string, amount: number) => ({
  sourceProductId: id,
  title,
  prices: [{ kind: "active_listing", amount, currency: "GBP" }],
  url: `${ORIGIN}/items/${id}`,
});

/**
 * `count` rows the app's non-game reading keeps, priced `from`, `from + 1`, …
 * so a window's cut can be read straight off the amounts. The title is one the
 * merchandise vocabulary is already measured against elsewhere in this file.
 */
const games = (count: number, opts: { from: number; prefix?: string }) =>
  Array.from({ length: count }, (_, i) =>
    listing(`${opts.prefix ?? "g"}${i}`, "F-Zero SNES cart only", opts.from + i),
  );

function adapter(
  overrides: Partial<ConstructorParameters<typeof SidecarAdapter>[0]> = {},
): SidecarAdapter {
  return new SidecarAdapter({
    source: SOURCE,
    baseUrl: ORIGIN,
    snapshotStrategy: "per_listing",
    // the real pace is seconds; tests that are not about pacing pay nothing
    rateLimitMs: 0,
    timeoutMs: 500,
    ...overrides,
  });
}

/**
 * A clock the "budgetMs" tests control instead of waiting on. `vi.spyOn`
 * scopes the mock to whichever test calls this and `restore()` undoes it in
 * that same test's own cleanup, so it cannot leak into the real-timer pacing
 * test elsewhere in this file (which asserts against actual elapsed ms).
 */
function mockClock(startAt = 1_000_000) {
  let now = startAt;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    advanceMs(ms: number): void {
      now += ms;
    },
    restore(): void {
      spy.mockRestore();
    },
  };
}

/**
 * Stands in for a real RateLimiter that would have made this call wait `ms`
 * milliseconds — except instead of a real `setTimeout`, it advances the
 * MOCKED clock above by exactly that amount before running the scheduled
 * request. That reproduces, deterministically and without spending any real
 * time, the one thing a real wait actually does to `SidecarAdapter.search`:
 * it moves `Date.now()` between the call at the top of `search()` and the
 * one made right before the request goes out. Cast through `unknown`
 * because it satisfies RateLimiter's one public method rather than being a
 * real instance — `search()` never constructs a limiter itself, callers
 * always provide one (this file's own `adapter()` calls do the same via a
 * real `RateLimiter` at `rateLimitMs: 0`).
 */
function limiterThatAdvancesClock(clock: ReturnType<typeof mockClock>, ms: number): RateLimiter {
  return {
    schedule: async <T>(fn: () => Promise<T>): Promise<T> => {
      clock.advanceMs(ms);
      return fn();
    },
  } as unknown as RateLimiter;
}

describe("SidecarAdapter", () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    logged.length = 0;
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  const search = () => agent.get(ORIGIN).intercept({ path: /\/search.*/, method: "GET" });

  describe("an absent sidecar", () => {
    /**
     * The honest distinction the whole feature rests on: a community source
     * nobody deployed is NOT an outage. Without a base URL the adapter is
     * unconfigured, the pricing service emits `not_configured` and the web
     * hides the block — no error, no empty table, no explaining to do.
     */
    it("is not configured and refuses to search rather than failing", async () => {
      for (const baseUrl of [undefined, "", "   "]) {
        const absent = adapter({ baseUrl });
        expect(absent.isConfigured()).toBe(false);
        await expect(absent.search("zelda")).rejects.toBeInstanceOf(NotConfiguredError);
      }
    });

    it("is configured as soon as a base URL is given", () => {
      expect(adapter().isConfigured()).toBe(true);
    });
  });

  describe("a well-behaved sidecar", () => {
    it("maps its rows to raw listings and passes the query and platform hint", async () => {
      let seenPath = "";
      let seenAccept = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        seenAccept = String((opts.headers as Record<string, string>).accept ?? "");
        return [listing("a1", "Super Mario World SNES boxed", 25), listing("a2", "Super Mario World SNES", 12)];
      });

      const listings = await adapter().search("super mario world", "snes");

      expect(listings).toHaveLength(2);
      expect(listings[0]).toEqual({
        sourceProductId: "a1",
        title: "Super Mario World SNES boxed",
        prices: [{ kind: "active_listing", amount: 25, currency: "GBP" }],
        url: `${ORIGIN}/items/a1`,
      });
      // v2: `source` first and always. One plugin may serve several sources,
      // so a request that did not name one would be answerable only by a
      // plugin that serves exactly one. Checked as a prefix, not full
      // equality: `snes` carries seller spellings and every request now
      // carries `budgetMs` (see "the console's seller spellings and the
      // app's remaining budget" below), both appended AFTER these three, so
      // an exact match here would break on their addition without this test
      // meaning to assert anything about either.
      expect(seenPath.startsWith("/search?source=community_demo&q=super+mario+world&platform=snes")).toBe(true);
      const params = new URLSearchParams(seenPath.slice(seenPath.indexOf("?") + 1));
      expect(params.get("source")).toBe("community_demo");
      expect(params.get("q")).toBe("super mario world");
      expect(params.get("platform")).toBe("snes");
      expect(seenAccept).toContain("application/json");
    });

    it("forwards the catalog's other names for the game, one `alt` each", async () => {
      // v2 carries them; v1 withheld them on the grounds that widening recall
      // was the app's business. It is not: the plugin is the half that
      // FETCHES, and the query it builds out of these is a fetching decision.
      // A plugin with no use for them ignores them.
      let seenPath = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        return [];
      });
      await adapter().search("Ocarina of Time", "n64", {
        alternativeNames: ["Zelda 64", "時のオカリナ"],
      });
      const params = new URLSearchParams(seenPath.slice(seenPath.indexOf("?") + 1));
      expect(params.getAll("alt")).toEqual(["Zelda 64", "時のオカリナ"]);
      expect(params.get("source")).toBe("community_demo");
      expect(params.get("q")).toBe("Ocarina of Time");
    });

    it("sends no `alt` at all when the caller has no other names", async () => {
      // An empty parameter is not the same as an absent one: `alt=` would be a
      // name of zero characters, and a plugin matching on it would find
      // everything.
      let seenPath = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        return [];
      });
      await adapter().search("zelda", undefined, { alternativeNames: [] });
      expect(seenPath).not.toContain("alt");
    });

    it("omits the platform hint when the caller has none", async () => {
      let seenPath = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        return [];
      });
      await adapter().search("ocarina of time");
      // Every request now carries `budgetMs` regardless of a platform hint
      // (see "the console's seller spellings and the app's remaining budget"
      // below), so this can no longer assert the exact path: `budgetMs`'s
      // value is a real elapsed-time measurement, not a fixed string. What
      // this test is actually about — no `platform` and no `spelling` appear
      // when the caller gave no hint — is asserted directly instead.
      const params = new URLSearchParams(seenPath.slice(seenPath.indexOf("?") + 1));
      expect(params.get("source")).toBe("community_demo");
      expect(params.get("q")).toBe("ocarina of time");
      expect(params.has("platform")).toBe(false);
      expect(params.has("spelling")).toBe(false);
      expect(Number(params.get("budgetMs"))).toBeGreaterThan(0);
    });

    it("accepts an empty array as a real answer", async () => {
      search().reply(200, []);
      await expect(adapter().search("nothing here")).resolves.toEqual([]);
    });

    it("does not double the base URL's trailing slash", async () => {
      let seenPath = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        return [];
      });
      await adapter({ baseUrl: `${ORIGIN}/` }).search("zelda");
      expect(seenPath.startsWith("/search?")).toBe(true);
    });
  });

  describe("the console's seller spellings and the app's remaining budget", () => {
    /**
     * Both additive, so neither one moves PLUGIN_PROTOCOL_VERSION (docs/sidecar-protocol.md).
     *
     * `spelling` carries PLATFORMS[platformHint].sellerSpellings, one
     * parameter per entry: the wire carries only an opaque platform id, and a
     * plugin cannot turn that id into the words sellers actually type — the
     * shipped Vinted sidecar logs the hint and ignores it for exactly that
     * reason. The app already sends words for the game itself (`q`, `alt`);
     * this is the same move one level up, for the console.
     */
    it("sends the console's seller spellings, one parameter each, in PLATFORMS' own order", async () => {
      let seenPath = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        return [];
      });
      await adapter().search("Ocarina of Time", "gbc");
      const params = new URLSearchParams(seenPath.slice(seenPath.indexOf("?") + 1));
      // PLATFORMS.gbc.sellerSpellings, verbatim (packages/shared/src/platforms.ts):
      // unlike the eBay query builder's own copy of this list, nothing here
      // sanitises commas or parentheses out of a spelling — that sanitisation
      // is a fetching decision an eBay-shaped query needs, not a wire rule.
      expect(params.getAll("spelling")).toEqual([
        "Game Boy Color", "Gameboy Color", "Game Boy Colour", "Gameboy Colour", "GBC",
      ]);
    });

    it("sends no `spelling` at all when the caller gave no platform hint", async () => {
      // Same rule as an absent `alt`: no evidence, no parameter — never a
      // parameter present with zero values.
      let seenPath = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        return [];
      });
      await adapter().search("Ocarina of Time");
      const params = new URLSearchParams(seenPath.slice(seenPath.indexOf("?") + 1));
      expect(params.has("spelling")).toBe(false);
    });

    /**
     * `budgetMs` is what is actually LEFT of this adapter's own timeout at
     * the moment the request goes out — not the raw timeout itself.
     * ADAPTER_TIMEOUT_MS is the whole race in pricing/service.ts, and the
     * rate limiter's wait happens INSIDE that race, so a plugin told the raw
     * number would believe it had time the app already spent.
     *
     * Proving that HONESTLY, without sleeping for real milliseconds, needs a
     * clock the test controls rather than one it waits on: `Date.now` is
     * mocked and a fake limiter (shaped like RateLimiter, standing in for a
     * real one that would have made this call wait) advances that mocked
     * clock by an EXACT amount before the scheduled request runs — the same
     * effect a real wait would have on the two Date.now() calls the
     * implementation must make (one at the top of search(), one right
     * before the request goes out), with no real elapsed time spent and
     * nothing left to flakiness.
     *
     * The number asserted is exact (7750 = 8000 - 250) rather than a range,
     * on purpose: `expect(budget).toBeGreaterThan(0)` and
     * `toBeLessThan(config.ADAPTER_TIMEOUT_MS)` both stay true for an
     * implementation that subtracts a hardcoded constant and never reads the
     * clock at all.
     * Deletion-proved: replacing the subtraction with `this.timeoutMs - 1`
     * turns this into `7999 !== 7750`, and no other test in this file moves.
     */
    it("tells the plugin how much of its own timeout is actually left, measured rather than assumed", async () => {
      let seenPath = "";
      search().reply(200, (opts) => {
        seenPath = opts.path;
        return [];
      });
      const clock = mockClock();
      try {
        const paced = adapter({ timeoutMs: 8000, limiter: limiterThatAdvancesClock(clock, 250) });
        await paced.search("Zelda");
        const params = new URLSearchParams(seenPath.slice(seenPath.indexOf("?") + 1));
        expect(Number(params.get("budgetMs"))).toBe(7750);
      } finally {
        clock.restore();
      }
    });

    it("fails fast when the limiter has already spent the whole budget, and sends nothing", async () => {
      // A limiter wait (or a slow clock, or a caller passing a tiny
      // timeoutMs) that exceeds the timeout leaves no time for the plugin.
      // Sending a request with budgetMs=0 would let a slow plugin hold a
      // connection the app has already given up on, and never trip its
      // breaker; refusing is the honest answer.
      let called = false;
      search().reply(200, () => {
        called = true;
        return [];
      });
      const clock = mockClock();
      try {
        const paced = adapter({ timeoutMs: 200, limiter: limiterThatAdvancesClock(clock, 500) });
        await expect(paced.search("Zelda")).rejects.toThrow();
        expect(called).toBe(false);
      } finally {
        clock.restore();
      }
    });
  });

  describe("a sidecar that gets one row wrong", () => {
    /**
     * One malformed listing costs that listing, never the source's whole
     * answer: a community scraper meeting an unusual item on page 2 must not
     * blank the price block for a game it also found correctly.
     */
    it("drops the bad row and keeps the good ones", async () => {
      search().reply(200, [
        listing("good-1", "Metroid Prime GameCube", 30),
        { ...listing("bad-currency", "Pokemon Red Game Boy", 20), prices: [{ kind: "active_listing", amount: 20, currency: "pounds" }] },
        { title: "no id at all", prices: [] },
        { ...listing("bad-time", "Pilotwings 64", 15), observedAt: "last tuesday" },
        listing("good-2", "F-Zero SNES", 18),
      ]);

      const listings = await adapter().search("anything");

      expect(listings.map((l) => l.sourceProductId)).toEqual(["good-1", "good-2"]);
    });

    /**
     * ...but a sidecar that gets EVERY row wrong is not "a source with nothing
     * for this game", which is what `ok` and an empty block say to the user.
     * It is the ordinary shape of a sidecar a source's redesign has broken, or
     * one whose package renamed a field, and the per-row drop rule was turning
     * it into a healthy-looking empty answer: the breaker counted nothing (a
     * resolved promise even RESETS its failure run), a fetch marker was
     * written, and the app kept calling it forever with a warn line per row as
     * the only trace. There is no good part to keep here.
     */
    it("fails the fetch when every row it sent breaks the protocol", async () => {
      search().reply(200, [
        { title: "no id at all", prices: [] },
        { ...listing("bad-currency", "Pokemon Red Game Boy", 20), prices: [{ kind: "active_listing", amount: 20, currency: "pounds" }] },
      ]);

      await expect(adapter().search("anything")).rejects.toBeInstanceOf(SidecarProtocolError);
    });

    it("keeps calling a batch of merchandise an honest empty answer", async () => {
      // dropped by the app's own reading, not by the protocol: the sidecar did
      // exactly what it was asked to do, and the marketplace really does
      // answer "zelda" with t-shirts
      search().reply(200, [
        listing("m1", "Legend of Zelda Ocarina of Time T-Shirt Size M", 8),
        listing("m2", "Pokemon Red Poster Print A3", 6),
      ]);

      await expect(adapter().search("zelda")).resolves.toEqual([]);
    });

    it("still fails the whole fetch when the body is not an array", async () => {
      search().reply(200, { listings: [listing("a1", "Super Mario World", 25)] });
      await expect(adapter().search("mario")).rejects.toBeInstanceOf(SidecarProtocolError);
    });

    it("fails the fetch when the body is not JSON at all", async () => {
      search().reply(200, "<html>login required</html>", { headers: { "content-type": "text/html" } });
      await expect(adapter().search("mario")).rejects.toBeTruthy();
    });
  });

  describe("a sidecar sending a kind its source declares no role for", () => {
    /**
     * The protocol lets a sidecar name any of the app's six price kinds, and
     * the app's manifest — never the plugin — says what each one MEANS. So the
     * kinds a given source may send are the ones its own manifest declares a
     * role for, and the rest are not "inert extra data": the signal engine
     * ignores a role-less kind while the price table renders it with the
     * fallback wording, which would print "pays cash" or "median (active)"
     * under the heading of a marketplace of private sellers. That is the app
     * making a claim about a source, in its own voice, on a plugin's say-so.
     *
     * The registry passes each market its manifest's kinds; an adapter built
     * without them (the stand-ins in this file) accepts every kind the
     * protocol defines.
     *
     * What such a price costs is the PRICE, not the row: `parseSidecarListing`
     * narrows the row to the kinds this source may speak for, exactly as the
     * sync path does, and only a row left with nothing storable is dropped
     * whole. The three rows in the first test below each carry a single price,
     * so for them "this price is refused" and "this row is refused" are the
     * same sentence; the batch test after it is the case where they are not.
     */
    const askingPricesOnly = () => adapter({ declaredKinds: ["active_listing"] });

    it("drops the row and keeps the ones it may speak for", async () => {
      search().reply(200, [
        { ...listing("shop", "Metroid Prime GameCube", 30), prices: [{ kind: "sell", amount: 30, currency: "GBP" }] },
        { ...listing("baseline", "F-Zero SNES", 18), prices: [{ kind: "active_median", amount: 18, currency: "GBP" }] },
        listing("asking", "Pokemon Red Game Boy", 20),
      ]);

      const listings = await askingPricesOnly().search("anything");

      expect(listings.map((l) => l.sourceProductId)).toEqual(["asking"]);
    });

    it("keeps every row that also carries an approved kind, and reports once for the batch", async () => {
      // The shape this whole rule exists for, and the one a multi-kind plugin
      // actually produces: every row carries both kinds, so the old rule
      // refused the entire answer — and a batch in which every row is
      // malformed is a protocol FAILURE, which is the source showing an error
      // on every screen and never saying why. Now each row keeps the price the
      // user approved and loses the other, and the loss is stated once for the
      // batch rather than once per row.
      search().reply(200, [
        {
          ...listing("a1", "Metroid Prime GameCube", 30),
          prices: [
            { kind: "active_median", amount: 30, currency: "GBP" },
            { kind: "active_listing", amount: 28, currency: "GBP" },
          ],
        },
        {
          ...listing("a2", "F-Zero SNES", 18),
          prices: [
            { kind: "active_median", amount: 18, currency: "GBP" },
            { kind: "active_listing", amount: 16, currency: "GBP" },
          ],
        },
      ]);

      const listings = await askingPricesOnly().search("anything");

      expect(listings.map((l) => l.sourceProductId)).toEqual(["a1", "a2"]);
      expect(listings.map((l) => l.prices)).toEqual([
        [{ kind: "active_listing", amount: 28, currency: "GBP" }],
        [{ kind: "active_listing", amount: 16, currency: "GBP" }],
      ]);
      const reports = logged.filter((line) => line.msg.includes("kinds this source is not approved for"));
      expect(reports).toHaveLength(1);
      expect(reports[0]?.obj).toMatchObject({ source: SOURCE, kinds: ["active_median"] });
    });

    it("reports a dropped kind even when the app then discards the row as merchandise", async () => {
      // Pins the ordering `collect` states in a comment and nothing was
      // checking: the consent report is collected BEFORE the non-game filter.
      // A row this app drops as merchandise still told the plugin's maintainer
      // something true about every row their plugin sends — the kind is being
      // sent for listings the user never approved it for, and that fact does
      // not depend on what the app then decides the listing IS. Move the
      // collection below the isNonGameListing check and this fails.
      search().reply(200, [
        {
          ...listing("m1", "Nintendo 64 Magazine N64 Manual Tips Book No8- Zelda Ocarina of Time", 30),
          prices: [
            { kind: "active_median", amount: 30, currency: "GBP" },
            { kind: "active_listing", amount: 28, currency: "GBP" },
          ],
        },
      ]);

      const listings = await askingPricesOnly().search("anything");

      // the row itself is gone: a magazine about the game is not the game
      expect(listings).toEqual([]);
      const reports = logged.filter((line) => line.msg.includes("kinds this source is not approved for"));
      expect(reports).toHaveLength(1);
      expect(reports[0]?.obj).toMatchObject({ source: SOURCE, kinds: ["active_median"] });
    });

    it("still accepts every known kind when no manifest narrows it", async () => {
      search().reply(200, [
        { ...listing("shop", "Metroid Prime GameCube", 30), prices: [{ kind: "sell", amount: 30, currency: "GBP" }] },
      ]);
      await expect(adapter().search("anything")).resolves.toHaveLength(1);
    });

    it("says nothing at all when no row lost a kind", async () => {
      // The report is a signal to a plugin's maintainer, so it must not fire
      // on the ordinary case: a silent log is what a well-behaved plugin earns.
      search().reply(200, [listing("asking", "Pokemon Red Game Boy", 20)]);
      await askingPricesOnly().search("anything");
      expect(logged.filter((line) => line.msg.includes("kinds this source is not approved for"))).toEqual([]);
    });
  });

  describe("a sidecar sending a kind this app has never heard of", () => {
    /**
     * Until 2026-09-09 this refused the whole row, the one live path still
     * did not agree with `parseSyncRow` about. It now costs the price, same
     * as an unapproved kind, but the two are reported SEPARATELY -- an
     * unapproved kind is a consent decision an operator made, an
     * unrecognised one is a plugin speaking a dialect this build does not
     * know, most likely a later protocol version -- so a maintainer reading
     * the log is pointed at the right fix for each.
     */
    it("keeps the row, drops just that price, and reports it apart from an unapproved kind", async () => {
      search().reply(200, [
        {
          ...listing("a1", "Metroid Prime GameCube", 30),
          prices: [
            { kind: "active_listing", amount: 28, currency: "GBP" },
            { kind: "auction_high", amount: 30, currency: "GBP" },
          ],
        },
      ]);

      const listings = await adapter().search("anything");

      expect(listings.map((l) => l.prices)).toEqual([[{ kind: "active_listing", amount: 28, currency: "GBP" }]]);
      expect(logged.filter((line) => line.msg.includes("kinds this source is not approved for"))).toEqual([]);
      const reports = logged.filter((line) => line.msg.includes("does not recognise"));
      expect(reports).toHaveLength(1);
      expect(reports[0]?.obj).toMatchObject({ source: SOURCE, kinds: [JSON.stringify("auction_high")] });
    });

    it("clips and quotes an invented kind before it reaches the log line", async () => {
      // The trap this task exists to avoid: this set is no longer bounded to
      // the app's own six kind names, so an entry can be any string a plugin
      // wrote -- unbounded in length and free to carry a control byte.
      const invented = `x${NUL}${"y".repeat(200)}`;
      search().reply(200, [
        {
          ...listing("a1", "Metroid Prime GameCube", 30),
          prices: [
            { kind: "active_listing", amount: 28, currency: "GBP" },
            { kind: invented, amount: 30, currency: "GBP" },
          ],
        },
      ]);

      await adapter().search("anything");

      const reports = logged.filter((line) => line.msg.includes("does not recognise"));
      expect(reports).toHaveLength(1);
      const kinds = reports[0]?.obj.kinds as string[];
      expect(kinds).toHaveLength(1);
      expect(kinds[0]).not.toContain(NUL);
      expect(kinds[0]!.length).toBeLessThan(40);
    });

    it("still fails the fetch when a row loses every price to it", async () => {
      search().reply(200, [{ ...listing("gone", "Metroid Prime GameCube", 30), prices: [{ kind: "auction_high", amount: 30, currency: "GBP" }] }]);
      await expect(adapter().search("anything")).rejects.toBeInstanceOf(SidecarProtocolError);
    });
  });

  describe("a sidecar quoting a currency its site does not use", () => {
    /**
     * A sidecar serves one source and one site, and a site quotes one
     * currency. The app declares which, and a price in another one is dropped
     * — for a blunter reason than tidiness: the FX table is asked for a rate
     * per currency of the whole batch, and a code Frankfurter does not quote
     * (XAU, KWD, a typo like GPB) makes that lookup throw. The throw escapes
     * the pricing service's try, so ONE such row would turn the entire source
     * into a permanent `error` block — the app reporting an outage of a market
     * that is answering perfectly, because a plugin fat-fingered a code.
     */
    const britishSite = () => adapter({ expectedCurrencies: ["GBP"] });

    it("drops the row rather than letting it fail the whole source", async () => {
      search().reply(200, [
        { ...listing("eur", "Metroid Prime GameCube", 30), prices: [{ kind: "active_listing", amount: 30, currency: "EUR" }] },
        { ...listing("typo", "F-Zero SNES", 18), prices: [{ kind: "active_listing", amount: 18, currency: "GPB" }] },
        listing("gbp", "Pokemon Red Game Boy", 20),
      ]);

      const listings = await britishSite().search("anything");

      expect(listings.map((l) => l.sourceProductId)).toEqual(["gbp"]);
    });

    it("accepts any ISO-shaped code when the market declares no expectation", async () => {
      search().reply(200, [
        { ...listing("eur", "Metroid Prime GameCube", 30), prices: [{ kind: "active_listing", amount: 30, currency: "EUR" }] },
      ]);
      await expect(adapter().search("anything")).resolves.toHaveLength(1);
    });
  });

  describe("a marketplace that sells more merchandise than games", () => {
    /**
     * The one thing a sidecar source needs that a catalog source does not: the
     * app's non-game reading, applied before anything can be matched to a
     * game. A second-hand marketplace answers "zelda" with t-shirts, posters
     * and keyrings, and the matcher scores on title similarity — "Pokemon Red
     * Poster A3" is a near-perfect trigram hit on "Pokémon Red". A confirmed
     * mapping is kept forever, so such a row would become a stored
     * buy_listing price and bark a £6 UNDERPRICED with a link to a poster.
     *
     * It lives in the app, never in the sidecar, for the same reason
     * classification does (docs/sidecar-protocol.md): one vocabulary, one
     * answer, and no plugin able to poison stored prices by being careless.
     * The vocabulary itself is the shared one every adapter reading seller
     * prose uses, so its measured traps apply here unchanged.
     */
    it("drops what is plainly not the game, before it can be matched to one", async () => {
      search().reply(200, [
        listing("m1", "Legend of Zelda Ocarina of Time T-Shirt Size M", 8),
        listing("g1", "Legend of Zelda Ocarina of Time N64 PAL boxed", 38),
        listing("m2", "Pokemon Red Poster Print A3", 6),
        listing("m3", "Zelda Ocarina of Time N64 Instruction Manual Only", 5),
        listing("g2", "Pokemon Red Game Boy cart only", 20),
      ]);

      const listings = await adapter().search("zelda");

      expect(listings.map((l) => l.sourceProductId)).toEqual(["g1", "g2"]);
    });

    it("keeps the games the vocabulary was tuned not to lose", async () => {
      // The traps are measured ones: a game whose own name contains a
      // merchandise word must survive, and so must a completeness phrase.
      search().reply(200, [
        listing("t1", "Nintendo World Cup NES PAL boxed", 15),
        listing("t2", "Paper Mario Sticker Star Nintendo 3DS", 22),
        listing("t3", "Metal Gear Solid 2 PS2 DVD Case, complete", 12),
        listing("t4", "Zelda Ocarina of Time N64 PAL boxed with manual", 40),
      ]);

      const listings = await adapter().search("anything");

      expect(listings.map((l) => l.sourceProductId)).toEqual(["t1", "t2", "t3", "t4"]);
    });
  });

  describe("a sidecar that answers with more than the app asked for", () => {
    /**
     * Every other adapter is bounded by the API it calls (eBay asks for 50 and
     * re-slices to 50). A sidecar is bounded by nothing: the protocol declares
     * no page size, the doc tells authors to send everything rather than
     * pre-filter, and the cost of a big answer is not paid in the adapter — it
     * is paid AFTER it, in the pricing service's per-listing matcher loop (two
     * sequential queries per row), which sits outside the fetch's timeout.
     *
     * So both dimensions are bounded here, where every other honesty rule for
     * a community source already lives.
     */
    it("stops reading a body past the byte cap and counts it as a failure", async () => {
      const padded = Array.from({ length: 40 }, (_, i) => listing(`pad-${i}`, `Some Game ${i} SNES`, 10));
      search().reply(200, padded);

      await expect(adapter({ maxBytes: 512 }).search("anything")).rejects.toBeInstanceOf(SidecarProtocolError);
    });

    /**
     * ...in the same words it always used. The bounded read itself now lives
     * in plugins/http.ts, shared with the health and manifest calls, and that
     * module reports a failure against the CALL ("GET /search"). A sidecar
     * failure is reported against the SOURCE, because that is what the pricing
     * service stores and what a maintainer reads, so the adapter re-forms the
     * sentence. Pinned here because "the same errors for the same inputs" was
     * the condition on moving the reader out at all.
     */
    it("reports an oversized answer against the source, not against the call", async () => {
      const padded = Array.from({ length: 40 }, (_, i) => listing(`pad-${i}`, `Some Game ${i} SNES`, 10));
      search().reply(200, padded);

      await expect(adapter({ maxBytes: 512 }).search("anything")).rejects.toThrow(
        "community_demo sidecar broke the protocol: GET /search answered more than 512 bytes",
      );
    });

    it("reads only the first rows of a batch past the row cap", async () => {
      search().reply(200, [
        listing("a1", "Metroid Prime GameCube", 30),
        listing("a2", "F-Zero SNES", 18),
        listing("a3", "Pokemon Red Game Boy", 20),
        listing("a4", "Pilotwings 64", 15),
      ]);

      const listings = await adapter({ maxListings: 2 }).search("anything");

      // capped before parsing, not after: the point is to bound the WORK a
      // sidecar can make the app do, not just the rows it gets back
      expect(listings.map((l) => l.sourceProductId)).toEqual(["a1", "a2"]);
    });

    it("leaves an ordinary answer alone", async () => {
      search().reply(200, [listing("a1", "Metroid Prime GameCube", 30)]);
      await expect(adapter().search("anything")).resolves.toHaveLength(1);
    });
  });

  describe("the merged cheapest-N window", () => {
    /**
     * A median source's sample is the cheapest N of the listings the app is
     * willing to COUNT, and the app's own non-game reading is what decides
     * which those are. The filter is the app's and never the plugin's, so a
     * plugin answers with its own window and the app would otherwise be
     * deleting merchandise from an already-cut set.
     *
     * Applying the cap here, AFTER the filter, is what makes the two orders
     * the same set: filtering is per row, so the cheapest N of the filtered
     * rows is the filtered cheapest N of everything that arrived.
     */
    const medianSite = (
      overrides: Partial<ConstructorParameters<typeof SidecarAdapter>[0]> = {},
    ): SidecarAdapter =>
      adapter({
        snapshotStrategy: "median_of_listings",
        expectedCurrencies: ["GBP"],
        maxWindow: 50,
        // eBay's own roles, matching `listing()`'s single "active_listing"
        // price — every test below that does not override this is ranking
        // on that price, exactly as production does for the one source this
        // strategy actually reaches today.
        kindRoles: { active_listing: "buy_listing", active_median: "reference" },
        ...overrides,
      });

    it("keeps the cheapest N of what survives the non-game filter, not of what arrived", async () => {
      // Three merchandise rows priced below every real listing — the shape the
      // 2026-09-03 marketplace probes recorded, where the cheapest listing in
      // four of five markets was a magazine, a keyring, a guide book and a
      // manual. Windowed first they would take 3 of the 50 slots and then be
      // deleted, leaving a 47-row sample; filtered first, 50 real listings
      // survive. The sample has no room to absorb the difference: most stored
      // eBay medians sit near the signal engine's minimum sample of 5.
      search().reply(200, [
        listing("m1", "Legend of Zelda Ocarina of Time T-Shirt Size M", 1),
        listing("m2", "Pokemon Red Poster Print A3", 2),
        listing("m3", "Zelda Ocarina of Time N64 Instruction Manual Only", 3),
        ...games(60, { from: 10 }),
      ]);

      const got = await medianSite().search("zelda");

      expect(got).toHaveLength(50);
      expect(got.map((l) => l.prices[0]?.amount)).toEqual(
        Array.from({ length: 50 }, (_, i) => 10 + i),
      );
    });

    it("does not window a per_listing source", async () => {
      // per_listing stores every matched row as its own price point, so a cap
      // here would silently decide which of a source's listings exist at all —
      // and there is no median for it to protect.
      search().reply(200, games(60, { from: 10 }));

      await expect(medianSite({ snapshotStrategy: "per_listing" }).search("zelda")).resolves.toHaveLength(60);
    });

    it("does not window a source that quotes more than one currency", async () => {
      // The window ranks raw amounts, which is a price ranking inside one
      // currency and nothing at all across two — the reason the adapter this
      // replaces logs `unexpectedCurrencies` before it cuts its own window.
      // Ranking EUR against GBP would pick a cheap-LOOKING set that is not the
      // cheapest one, and the median taken over it would be a number nobody
      // quoted.
      search().reply(200, games(60, { from: 10 }));

      await expect(
        medianSite({ expectedCurrencies: ["GBP", "EUR"] }).search("zelda"),
      ).resolves.toHaveLength(60);
    });

    it("sorts a priceless listing last, so it fills leftover slots only", async () => {
      // Same rule as the +Infinity in the function this ports: a listing with
      // no price carries none into the median and must not displace one that
      // does. The row reaches collect at all because a row that ARRIVED with
      // `prices: []` is legal and is kept (adapters/sidecar/protocol.ts) —
      // only a row that LOST every price it sent is dropped whole.
      search().reply(200, [
        { ...listing("p1", "Pilotwings 64", 0), prices: [] },
        { ...listing("p2", "Wave Race 64", 0), prices: [] },
        listing("dear", "Metroid Prime GameCube", 30),
        listing("mid", "F-Zero SNES", 20),
        listing("cheap", "Pokemon Red Game Boy", 10),
      ]);

      const got = await medianSite({ maxWindow: 4 }).search("anything");

      // three priced rows first, cheapest up; the one leftover slot goes to a
      // priceless row, and the second priceless row is the one that falls out
      expect(got.map((l) => l.sourceProductId)).toEqual(["cheap", "mid", "dear", "p1"]);
    });

    it("restores a SINGLE price cutoff when a plugin answers with two merged windows", async () => {
      // Two 40-row windows, 10..49 and 5..44, arriving as ONE 80-row answer:
      // 80 distinct listings with two price cutoffs, and a sample size the UI
      // would print ("80 listings") that no single query could produce. Taking
      // the cheapest 50 of the union restores one cutoff, at 32 — five
      // singletons at 5..9, then 22 full pairs at 10..31, then one of the 32s.
      //
      // 100 rows out would mean the cap never ran; a maximum of 49 would mean
      // the union came back unranked. Neither number is a knob to turn.
      search().reply(200, [
        ...games(40, { from: 10, prefix: "a" }),
        ...games(40, { from: 5, prefix: "b" }),
      ]);

      const got = await medianSite().search("mario kart 64");

      expect(got).toHaveLength(50);
      const amounts = got.map((l) => l.prices[0]?.amount ?? Number.POSITIVE_INFINITY);
      expect(Math.max(...amounts)).toBe(32);
      expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    });

    /**
     * The third `prices[0]` reader, proved directly: the window must
     * rank on the ROLE this source gave `buy_listing`, not on array
     * position. Kind names invented for this test, never eBay's.
     */
    it("windows on the buy_listing-role price, not the position in a row's own price array", async () => {
      // Each row carries a decoy price FIRST (role "bid", e.g. a trade-in
      // offer) and its real buy_listing price SECOND, in the OPPOSITE
      // order from the decoy: by position the window would keep the three
      // cheapest decoys (a, b, c); by role it must keep the three cheapest
      // real prices (c, d, e).
      const priced = (id: string, decoy: number, real: number) => ({
        sourceProductId: id,
        title: "F-Zero SNES cart only",
        prices: [
          { kind: "cash", amount: decoy, currency: "GBP" },
          { kind: "sell", amount: real, currency: "GBP" },
        ],
        url: `${ORIGIN}/items/${id}`,
      });
      search().reply(200, [
        priced("a", 1, 50),
        priced("b", 2, 40),
        priced("c", 3, 30),
        priced("d", 4, 20),
        priced("e", 5, 10),
      ]);

      const got = await medianSite({
        maxWindow: 3,
        kindRoles: { sell: "buy_listing", cash: "bid", guide: "reference" },
      }).search("anything");

      expect(got.map((l) => l.sourceProductId).sort()).toEqual(["c", "d", "e"]);
    });
  });

  describe("when the sidecar is unwell", () => {
    /** Threshold and hold are the app's, never the plugin's — one place for the honesty rules. */
    const breaking = (threshold: number) =>
      adapter({ breaker: new CircuitBreaker({ failureThreshold: threshold, holdMs: 60_000 }) });

    it("reports an HTTP failure and opens the circuit after the threshold", async () => {
      let calls = 0;
      agent
        .get(ORIGIN)
        .intercept({ path: /\/search.*/, method: "GET" })
        .reply(500, () => {
          calls += 1;
          return "boom";
        })
        .times(2);
      const broken = breaking(2);

      await expect(broken.search("zelda")).rejects.toBeInstanceOf(SidecarHttpError);
      await expect(broken.search("zelda")).rejects.toBeInstanceOf(SidecarHttpError);
      expect(calls).toBe(2);

      // open: the next search never reaches the sidecar at all, and the
      // pricing service turns that throw into a `error` block
      await expect(broken.search("zelda")).rejects.toBeInstanceOf(CircuitOpenError);
      expect(calls).toBe(2);
    });

    /**
     * A sidecar answers searches; it does not get to send the app somewhere
     * else. Following a redirect would let the least-trusted process in the
     * stack choose a URL for the api container to fetch — any HTTP service on
     * its network, or anywhere on the internet, with the user's search text in
     * the path — and would quietly make the documented rule ("any non-2xx
     * status is a failure") untrue, since the 3xx would never be seen as a
     * status at all.
     *
     * The redirect TARGET is mocked as well, and that is load-bearing: with
     * only the 302 mocked, this test passed whether the rule was there or not,
     * because a MockAgent with net connect disabled has nothing to follow to.
     * With a reachable target, following SUCCEEDS — measured — so the
     * rejection below is evidence about the app's rule and not about the
     * fixture. The interceptor left pending afterwards is the other half: the
     * app never went there.
     */
    it("refuses to be redirected, and counts that as a failure", async () => {
      agent
        .get(ORIGIN)
        .intercept({ path: /\/search.*/, method: "GET" })
        .reply(302, "", { headers: { location: `${ORIGIN}/elsewhere` } });
      agent.get(ORIGIN).intercept({ path: "/elsewhere", method: "GET" }).reply(200, []);
      const redirected = breaking(1);

      await expect(redirected.search("zelda")).rejects.toBeTruthy();
      expect(agent.pendingInterceptors().map((i) => i.path)).toEqual(["/elsewhere"]);
      await expect(redirected.search("zelda")).rejects.toBeInstanceOf(CircuitOpenError);
    });

    it("counts a timeout as a failure too, so a hung sidecar opens the circuit", async () => {
      agent
        .get(ORIGIN)
        .intercept({ path: /\/search.*/, method: "GET" })
        .reply(200, [])
        .delay(300)
        .times(2);
      const slow = adapter({
        timeoutMs: 30,
        breaker: new CircuitBreaker({ failureThreshold: 2, holdMs: 60_000 }),
      });

      await expect(slow.search("zelda")).rejects.toBeTruthy();
      await expect(slow.search("zelda")).rejects.toBeTruthy();
      await expect(slow.search("zelda")).rejects.toBeInstanceOf(CircuitOpenError);
    });
  });

  describe("pacing", () => {
    /**
     * The pace lives here rather than in the sidecar precisely because the
     * sidecar is the part the app does not control: a plugin that forgot to
     * pace itself, or was written against a friendlier source, still cannot
     * make this app hammer anyone.
     */
    it("spaces consecutive searches by the configured interval", async () => {
      const seenAt: number[] = [];
      agent
        .get(ORIGIN)
        .intercept({ path: /\/search.*/, method: "GET" })
        .reply(200, () => {
          seenAt.push(Date.now());
          return [];
        })
        .times(2);
      const paced = adapter({ limiter: new RateLimiter(150) });

      await Promise.all([paced.search("one"), paced.search("two")]);

      expect(seenAt).toHaveLength(2);
      expect(seenAt[1] - seenAt[0]).toBeGreaterThanOrEqual(140);
    });
  });

  describe("normalize", () => {
    /**
     * The point of the whole split: a sidecar sends words, the app decides
     * what they mean — and it decides it the same way for every source,
     * because this adapter's normalize IS the shared classifier and nothing
     * else. Pinned end to end on one title carrying all four readings.
     */
    const TITLE = "Legend of Zelda Ocarina of Time N64 Boxed Complete PAL Mint";

    it("reads a title exactly as any other adapter would", () => {
      const raw = { sourceProductId: "x", title: TITLE, url: null, prices: [] };
      const mine = adapter().normalize(raw);

      expect(mine.cleanTitle).toBe("legend of zelda ocarina of time");
      expect(mine.platformGuess).toBe("n64");
      expect(mine.regionGuess).toBe("PAL");
      expect(mine.conditionGuess).toBe("cib");
      expect(mine.gradeGuess).toBe("mint");
    });

    /**
     * The row contract's point, made concrete: a live row's category decides
     * its platform exactly as a catalog row's does
     * (`PluginCatalogAdapter.normalize`, adapters/sidecar/catalogAdapter.ts) --
     * until this task the live parser validated `categoryText` and this method
     * dropped it on the floor. Modelled on that adapter's own equivalent test
     * ("lets the shop's own category win over a title that names another
     * console", test/adapters/sidecar/catalogAdapter.test.ts) so the two are
     * visibly the same rule: "Super Mario Advance" is a GBA cartridge whose
     * name carries the SNES original, the ordinary shape of a re-release or
     * compilation, so the category has to win for the SKU to confirm against
     * the right release.
     *
     * The reading itself is the app's CeX hint list
     * (`detectPlatformFromCategory`, adapters/familyReading.ts), applied here
     * to whatever category text this community plugin sent -- it has no idea
     * this row came from a live search rather than CeX's own sweep.
     */
    it("lets a live row's own category win over a title that names another console, exactly as a catalog row's does", () => {
      const raw = {
        sourceProductId: "x",
        title: "Super Mario Advance SNES",
        categoryText: "GBA Games",
        url: null,
        prices: [],
      };
      expect(adapter().normalize(raw).platformGuess).toBe("gba");
    });

    it("falls back to the title when the category is one this hint list cannot read", () => {
      // The hint list is CeX's own vocabulary, so a category outside it is
      // not evidence of anything -- falling through to the title is the safe
      // direction to be wrong in, same as the sync path's own equivalent case.
      const raw = {
        sourceProductId: "x",
        title: "Super Mario 64 N64 cart",
        categoryText: "Retro Bundles",
        url: null,
        prices: [],
      };
      expect(adapter().normalize(raw).platformGuess).toBe("n64");
    });

    /**
     * Availability is the source's claim, not the app's. eBay stamps `true`
     * because a Browse item summary IS a live listing; a sidecar has to say so
     * itself, and saying nothing means unknown rather than buyable.
     */
    it("takes availability from the sidecar and never invents it", async () => {
      search().reply(200, [
        { ...listing("live", "F-Zero SNES", 18), available: true },
        { ...listing("gone", "F-Zero SNES boxed", 40), available: false },
        listing("silent", "F-Zero SNES cart only", 12),
      ]);
      const built = adapter();
      const normalized = (await built.search("f-zero")).map((l) => built.normalize(l));
      expect(normalized.map((l) => l.available)).toEqual([true, false, undefined]);
    });
  });
});
