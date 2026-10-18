import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../../src/lib/rateLimiter.js";

describe("RateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spaces sequential calls by at least the interval", async () => {
    const limiter = new RateLimiter(1000);
    const calls: number[] = [];
    const task = () => {
      calls.push(Date.now());
      return Promise.resolve("x");
    };
    const p1 = limiter.schedule(task);
    const p2 = limiter.schedule(task);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    await expect(p1).resolves.toBe("x");
    await expect(p2).resolves.toBe("x");
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1000);
  });

  it("propagates errors without breaking the queue", async () => {
    const limiter = new RateLimiter(100);
    const p1 = limiter.schedule(() => Promise.reject(new Error("boom")));
    const p2 = limiter.schedule(() => Promise.resolve("ok"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(p1).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(100);
    await expect(p2).resolves.toBe("ok");
  });
});
