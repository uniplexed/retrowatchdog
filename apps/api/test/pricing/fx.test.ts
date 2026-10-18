import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { ratesToUsd, rateFromUsd, autoRateFromUsd, resetFxCacheForTests } from "../../src/pricing/fx.js";

// db=null: pure network-layer tests. Override behavior (which needs a DB) is
// covered by the settingsFx route tests.
describe("fx layer (USD base)", () => {
  let agent: MockAgent;
  let prev: ReturnType<typeof getGlobalDispatcher>;

  beforeEach(() => {
    prev = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    resetFxCacheForTests();
  });
  afterEach(async () => {
    setGlobalDispatcher(prev);
    await agent.close();
    resetFxCacheForTests();
  });

  it("ratesToUsd returns 1 for USD without any network call", async () => {
    const rates = await ratesToUsd(null, ["USD"]);
    expect(rates.get("USD")).toBe(1);
  });

  it("ratesToUsd fetches and caches the GBP->USD rate", async () => {
    agent
      .get("https://api.frankfurter.app")
      .intercept({ path: "/latest?from=GBP&to=USD", method: "GET" })
      .reply(200, { rates: { USD: 1.27 } });
    const first = await ratesToUsd(null, ["GBP", "USD"]);
    expect(first.get("GBP")).toBe(1.27);
    expect(first.get("USD")).toBe(1);
    // second call must hit the cache: no second intercept is registered,
    // so a network attempt would throw under disableNetConnect
    const second = await ratesToUsd(null, ["GBP"]);
    expect(second.get("GBP")).toBe(1.27);
  });

  it("rateFromUsd serves the USD->X display rate with a fetchedAt and caches it", async () => {
    agent
      .get("https://api.frankfurter.app")
      .intercept({ path: "/latest?from=USD&to=GBP", method: "GET" })
      .reply(200, { rates: { GBP: 0.79 } });
    const first = await rateFromUsd(null, "GBP");
    expect(first.rate).toBe(0.79);
    expect(first.mode).toBe("auto");
    expect(first.fetchedAt).toBeInstanceOf(Date);
    const second = await rateFromUsd(null, "GBP"); // cache hit
    expect(second.rate).toBe(0.79);
  });

  it("rateFromUsd for USD itself is 1 without network", async () => {
    const r = await rateFromUsd(null, "USD");
    expect(r.rate).toBe(1);
    expect(r.mode).toBe("auto");
  });

  it("autoRateFromUsd shares the display-direction cache", async () => {
    agent
      .get("https://api.frankfurter.app")
      .intercept({ path: "/latest?from=USD&to=EUR", method: "GET" })
      .reply(200, { rates: { EUR: 0.91 } });
    expect((await autoRateFromUsd("EUR")).rate).toBe(0.91);
    expect((await rateFromUsd(null, "EUR")).rate).toBe(0.91); // no second fetch
  });

  it("propagates a hard FX failure instead of guessing", async () => {
    agent
      .get("https://api.frankfurter.app")
      .intercept({ path: "/latest?from=EUR&to=USD", method: "GET" })
      .reply(500, "boom");
    await expect(ratesToUsd(null, ["EUR"])).rejects.toThrow(/fx/);
  });
});
