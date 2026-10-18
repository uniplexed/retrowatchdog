import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/lib/circuitBreaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const failing = () => Promise.reject(new Error("down"));

  it("opens after N consecutive failures and rejects fast while open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, holdMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.exec(failing)).rejects.toThrow("down");
    }
    await expect(breaker.exec(failing)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("closes again after holdMs and a success, resetting the count", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, holdMs: 60_000 });
    await expect(breaker.exec(failing)).rejects.toThrow("down");
    await expect(breaker.exec(failing)).rejects.toThrow("down");
    await expect(breaker.exec(failing)).rejects.toBeInstanceOf(CircuitOpenError);
    vi.advanceTimersByTime(60_001);
    await expect(breaker.exec(() => Promise.resolve("up"))).resolves.toBe("up");
    // one failure after recovery must NOT re-open (count was reset)
    await expect(breaker.exec(failing)).rejects.toThrow("down");
    await expect(breaker.exec(() => Promise.resolve("up"))).resolves.toBe("up");
  });

  it("reopens immediately when the half-open probe fails", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, holdMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.exec(failing)).rejects.toThrow("down");
    }
    // Circuit is now open.
    await expect(breaker.exec(failing)).rejects.toBeInstanceOf(CircuitOpenError);
    vi.advanceTimersByTime(60_001);
    // Past holdMs: half-open state, probe with a failing function.
    await expect(breaker.exec(failing)).rejects.toThrow("down");
    // Probe failed: circuit must be immediately open again.
    // Verify fast-fail without invoking fn.
    const fn = vi.fn();
    await expect(breaker.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("only one probe runs while half-open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, holdMs: 60_000 });
    await expect(breaker.exec(failing)).rejects.toThrow("down");
    await expect(breaker.exec(failing)).rejects.toThrow("down");
    // Circuit is now open.
    await expect(breaker.exec(failing)).rejects.toBeInstanceOf(CircuitOpenError);
    vi.advanceTimersByTime(60_001);
    // Past holdMs: half-open state. Start a probe with manual control.
    let resolveProbe: (value: string) => void;
    const probePromise = new Promise<string>((r) => {
      resolveProbe = r;
    });
    const fn1 = vi.fn(() => probePromise);
    // First exec starts the probe, but it is still pending.
    const p1 = breaker.exec(fn1);
    await vi.advanceTimersByTimeAsync(0);
    // Second concurrent exec should reject with CircuitOpenError, not invoke fn2.
    const fn2 = vi.fn();
    const p2 = breaker.exec(fn2);
    await expect(p2).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn2).not.toHaveBeenCalled();
    // Resolve the first probe.
    resolveProbe!("success");
    await expect(p1).resolves.toBe("success");
    // fn1 was called exactly once.
    expect(fn1).toHaveBeenCalledOnce();
  });
});
