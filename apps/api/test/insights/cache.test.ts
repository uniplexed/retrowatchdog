import { describe, expect, it } from "vitest";
import { cachedFor, clearInsightsCache } from "../../src/routes/insights.js";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("cachedFor", () => {
  it("runs one computation for concurrent callers", async () => {
    clearInsightsCache();
    let calls = 0;
    const d = deferred<number>();
    const compute = () => ((calls += 1), d.promise);
    const both = Promise.all([cachedFor("k1", compute), cachedFor("k1", compute)]);
    d.resolve(7);
    expect(await both).toEqual([7, 7]);
    expect(calls).toBe(1);
  });

  it("never serves or stores a body computed before a clear", async () => {
    clearInsightsCache();
    const old = deferred<string>();
    const before = cachedFor("k2", () => old.promise);
    clearInsightsCache();
    const after = cachedFor("k2", async () => "fresh");
    old.resolve("stale");
    expect(await before).toBe("stale");
    expect(await after).toBe("fresh");
    expect(await cachedFor("k2", async () => "recomputed")).toBe("fresh");
  });
});
