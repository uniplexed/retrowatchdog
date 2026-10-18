import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every module under test builds its own private logger with `pino({...})`,
 * and pino writes straight to file descriptor 1 -- so a spy on
 * `process.stdout.write` sees nothing and there is no logger to inject. The
 * factory itself is faked instead, which is the whole pino surface this tree
 * uses. `vi.hoisted` is required because `vi.mock` is lifted above the
 * imports, ahead of any ordinary `const`.
 */
const { warnings } = vi.hoisted(() => ({ warnings: [] as unknown[][] }));
vi.mock("pino", () => {
  const logger = {
    warn: (...args: unknown[]) => void warnings.push(args),
    info: () => {},
    debug: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    level: "warn",
    child: () => logger,
  };
  return { default: () => logger, pino: () => logger };
});
import type pg from "pg";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import type { Platform, SourceId } from "@retrowatchdog/shared";
import { setupTestDb } from "../../helpers/testDb.js";
import type { Db } from "../../../src/db/index.js";
import { games, gameNames, pricePoints, sourceMappings } from "../../../src/db/schema.js";
import { getPricesForGame } from "../../../src/pricing/service.js";
import { saveEnabledSources } from "../../../src/settings/markets.js";
import { SidecarAdapter, type SidecarAdapterOptions } from "../../../src/adapters/sidecar/index.js";
import { CircuitBreaker } from "../../../src/lib/circuitBreaker.js";

/**
 * The three states a sidecar-backed source can be in, seen from where the user
 * actually sees them: the `SourceBlock` the pricing service emits.
 *
 * The distinction between the first two is the honesty rule this whole feature
 * rests on, and it is only observable here — the adapter's own tests can see
 * `isConfigured()` and a thrown error, but not what the app then TELLS the
 * user. A community source nobody deployed is `not_configured` and its block
 * is hidden; a deployed one that is failing is `error` and shows what was
 * stored before, labelled old.
 *
 * The adapter is registered under `pricecharting` because `enabled_sources`
 * drops ids this build does not know (settings/markets.ts) and this stage of
 * the batch adds no source id of its own. That id's real adapter is dormant,
 * so nothing here can be confused with a live source.
 */
const ORIGIN = "http://sidecar.test:8000";
const STANDS_IN_FOR_A_COMMUNITY_SOURCE = "pricecharting" as SourceId;

const sidecar = (opts: Partial<SidecarAdapterOptions> = {}) =>
  new SidecarAdapter({
    source: STANDS_IN_FOR_A_COMMUNITY_SOURCE,
    snapshotStrategy: "per_listing",
    rateLimitMs: 0,
    timeoutMs: 500,
    ...opts,
  });

describe("a sidecar source as the pricing service reports it", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let agent: MockAgent;
  let previousDispatcher: Dispatcher;
  let game: { id: number; title: string; platform: Platform };

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll();
    warnings.length = 0;
    previousDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    // the fx stub the suite installs globally is replaced here, so this file
    // registers its own GBP->USD rate; nothing reaches a real network
    agent.disableNetConnect();
    agent
      .get("https://api.frankfurter.app")
      .intercept({ path: "/latest?from=GBP&to=USD", method: "GET" })
      .reply(200, { rates: { USD: 1 } })
      .persist();
    setGlobalDispatcher(agent);

    const [row] = await db
      .insert(games)
      .values({ title: "Pilotwings 64", platform: "n64" })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: row.id, name: "Pilotwings 64" });
    game = { id: row.id, title: "Pilotwings 64", platform: "n64" };
    await saveEnabledSources(db, [STANDS_IN_FOR_A_COMMUNITY_SOURCE]);
  });

  const block = async () =>
    (await getPricesForGame(db, [sidecar({ baseUrl: ORIGIN })], game)).find(
      (b) => b.source === STANDS_IN_FOR_A_COMMUNITY_SOURCE,
    );

  it("says not_configured when no sidecar is deployed", async () => {
    const blocks = await getPricesForGame(db, [sidecar()], game);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      source: STANDS_IN_FOR_A_COMMUNITY_SOURCE,
      status: "not_configured",
      points: [],
    });
  });

  it("stores what a healthy sidecar returned, in the currency the sidecar quoted", async () => {
    await db.insert(sourceMappings).values({
      gameId: game.id,
      source: STANDS_IN_FOR_A_COMMUNITY_SOURCE,
      sourceProductId: "listing-1",
      sourceTitle: "Pilotwings 64",
      matchScore: 1,
      status: "confirmed",
    });
    agent
      .get(ORIGIN)
      .intercept({ path: /\/search.*/, method: "GET" })
      .reply(200, [
        {
          sourceProductId: "listing-1",
          title: "Pilotwings 64 N64 boxed with manual PAL",
          prices: [{ kind: "active_listing", amount: 24, currency: "GBP" }],
          url: `${ORIGIN}/items/listing-1`,
          available: true,
        },
      ]);

    const result = await block();

    expect(result?.status).toBe("ok");
    expect(result?.points).toHaveLength(1);
    const [point] = result?.points ?? [];
    expect(point.kind).toBe("active_listing");
    // the sidecar's verbatim amount and currency survive; the app read the
    // region and condition off the title itself, as it does for every source
    expect(point.priceOriginal).toBe(24);
    expect(point.currencyOriginal).toBe("GBP");
    expect(point.region).toBe("PAL");
    expect(point.condition).toBe("cib");
    expect(point.available).toBe(true);
  });

  it("stores a plugin-sent sample size on the point it prices, and null when the price carries none", async () => {
    await db.insert(sourceMappings).values({
      gameId: game.id,
      source: STANDS_IN_FOR_A_COMMUNITY_SOURCE,
      sourceProductId: "listing-1",
      sourceTitle: "Pilotwings 64",
      matchScore: 1,
      status: "confirmed",
    });
    agent
      .get(ORIGIN)
      .intercept({ path: /\/search.*/, method: "GET" })
      .reply(200, [
        {
          sourceProductId: "listing-1",
          title: "Pilotwings 64 N64 boxed with manual PAL",
          prices: [{ kind: "active_listing", amount: 40, currency: "GBP", sampleSize: 9 }],
          url: `${ORIGIN}/items/listing-1`,
          available: true,
        },
        {
          sourceProductId: "listing-2",
          title: "Pilotwings 64 N64 boxed with manual PAL",
          prices: [{ kind: "active_listing", amount: 45, currency: "GBP" }],
          url: `${ORIGIN}/items/listing-2`,
          available: true,
        },
      ]);

    const result = await block();

    expect(result?.status).toBe("ok");
    const withSample = result?.points.find((p) => p.priceOriginal === 40);
    const withoutSample = result?.points.find((p) => p.priceOriginal === 45);
    expect(withSample?.sampleSize).toBe(9);
    expect(withoutSample?.sampleSize).toBeNull();
  });

  /**
   * The warning exists because the signal engine SILENTLY skips a reference
   * point with no sample (computeSignals.ts), so a plugin author who declares
   * the role and sends no sample sees their baseline ignored with nothing
   * saying why. The pure helper has its own tests; these three pin the wiring,
   * which is the part a refactor can drop without any test noticing.
   *
   * The logger is mocked rather than spied on: every module here builds its
   * own with `pino({...})` and keeps it private, and pino writes straight to
   * file descriptor 1, so `process.stdout.write` never sees the line. Only
   * the factory is faked -- nothing in this tree uses any other pino API.
   */
  describe("a declared reference that arrives without its sample", () => {
    const confirmMapping = async () => {
      await db.insert(sourceMappings).values({
        gameId: game.id,
        source: STANDS_IN_FOR_A_COMMUNITY_SOURCE,
        sourceProductId: "listing-1",
        sourceTitle: "Pilotwings 64",
        matchScore: 1,
        status: "confirmed",
      });
    };
    /** one row pricing a `guide` kind, with a sample only if asked for */
    const replyWithGuide = (sampleSize?: number) => {
      agent
        .get(ORIGIN)
        .intercept({ path: /\/search.*/, method: "GET" })
        .reply(200, [
          {
            sourceProductId: "listing-1",
            title: "Pilotwings 64 N64 boxed with manual PAL",
            prices: [
              {
                kind: "guide",
                amount: 30,
                currency: "GBP",
                ...(sampleSize === undefined ? {} : { sampleSize }),
              },
            ],
            url: `${ORIGIN}/items/listing-1`,
          },
        ]);
    };
    const baselineWarnings = () =>
      warnings.filter(([, message]) => String(message).includes("never used as a baseline"));

    it("is reported once, naming the source and the kind", async () => {
      await confirmMapping();
      replyWithGuide();

      await getPricesForGame(
        db,
        [sidecar({ baseUrl: ORIGIN, declaredKinds: ["guide"], kindRoles: { guide: "reference" } })],
        game,
      );

      const reported = baselineWarnings();
      expect(reported).toHaveLength(1);
      expect(reported[0][0]).toMatchObject({
        source: STANDS_IN_FOR_A_COMMUNITY_SOURCE,
        gameId: game.id,
        kinds: ["guide"],
      });
    });

    it("is not reported when the price carries its sample", async () => {
      await confirmMapping();
      replyWithGuide(8);

      await getPricesForGame(
        db,
        [sidecar({ baseUrl: ORIGIN, declaredKinds: ["guide"], kindRoles: { guide: "reference" } })],
        game,
      );

      expect(baselineWarnings()).toEqual([]);
    });

    it("is not reported for a median source, whose reference the app derives itself", async () => {
      await confirmMapping();
      agent
        .get(ORIGIN)
        .intercept({ path: /\/search.*/, method: "GET" })
        .reply(200, [
          {
            sourceProductId: "listing-1",
            title: "Pilotwings 64 N64 boxed with manual PAL",
            prices: [
              { kind: "active_listing", amount: 24, currency: "GBP" },
              { kind: "active_median", amount: 30, currency: "GBP" },
            ],
            url: `${ORIGIN}/items/listing-1`,
          },
        ]);

      await getPricesForGame(
        db,
        [
          sidecar({
            baseUrl: ORIGIN,
            snapshotStrategy: "median_of_listings",
            declaredKinds: ["active_listing", "active_median"],
            kindRoles: { active_listing: "buy_listing", active_median: "reference" },
            expectedCurrencies: ["GBP"],
          }),
        ],
        game,
      );

      expect(baselineWarnings()).toEqual([]);
    });
  });

  it("says error, and serves the stored points, once the breaker has opened", async () => {
    const stale = new Date(Date.now() - 24 * 3_600_000);
    await db.insert(pricePoints).values({
      gameId: game.id,
      source: STANDS_IN_FOR_A_COMMUNITY_SOURCE,
      region: "PAL",
      condition: "cib",
      kind: "active_listing",
      priceUsd: "19.00",
      priceOriginal: "19.00",
      currencyOriginal: "GBP",
      fetchedAt: stale,
    });
    let calls = 0;
    agent
      .get(ORIGIN)
      .intercept({ path: /\/search.*/, method: "GET" })
      .reply(500, () => {
        calls += 1;
        return "boom";
      })
      .times(2);
    // threshold 1: one failure is enough to open it, so the second call is the
    // open-circuit path rather than a second request
    const broken = sidecar({
      baseUrl: ORIGIN,
      breaker: new CircuitBreaker({ failureThreshold: 1, holdMs: 60_000 }),
    });

    const first = await getPricesForGame(db, [broken], game);
    const second = await getPricesForGame(db, [broken], game);

    // the interceptor would have answered twice; the open circuit is what
    // stops the second request, and the block is `error` either way
    expect(calls).toBe(1);
    for (const blocks of [first, second]) {
      expect(blocks[0].status).toBe("error");
      // stale-if-error: the old reading is shown, labelled with its own age,
      // and nothing is invented to fill the gap
      expect(blocks[0].points).toHaveLength(1);
      expect(blocks[0].fetchedAt).toBe(stale.toISOString());
    }
  });
});
