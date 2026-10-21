import { afterEach, describe, expect, it } from "vitest";
import { loadPeriod, resetPeriodForTests, resolvePeriod, setPeriod } from "../src/lib/period.js";

const TODAY = new Date("2026-10-21T15:00:00Z");

afterEach(() => {
  window.localStorage.clear();
  resetPeriodForTests();
});

describe("resolvePeriod: one window for every chart", () => {
  it.each([
    ["7d", "2026-10-15"],
    ["30d", "2026-09-22"],
    ["90d", "2026-07-24"],
    ["1y", "2025-10-22"],
    ["all", "2024-10-22"],
  ] as const)("%s runs to today from %s", (preset, from) => {
    expect(resolvePeriod({ preset }, TODAY)).toEqual({ from, to: "2026-10-21" });
  });

  it("a custom range is taken as given, in order", () => {
    expect(resolvePeriod({ preset: "custom", from: "2026-01-01", to: "2026-03-31" }, TODAY)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(resolvePeriod({ preset: "custom", from: "2026-03-31", to: "2026-01-01" }, TODAY)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("a custom range missing an end falls back to 90 days", () => {
    expect(resolvePeriod({ preset: "custom", from: "2026-01-01" }, TODAY)).toEqual({ from: "2026-07-24", to: "2026-10-21" });
  });
});

describe("the chosen period is shared and remembered", () => {
  it("defaults to 90 days", () => {
    expect(loadPeriod()).toEqual({ preset: "90d" });
  });

  it("is stored in this browser", () => {
    setPeriod({ preset: "custom", from: "2026-01-01", to: "2026-02-01" });
    resetPeriodForTests();
    expect(loadPeriod()).toEqual({ preset: "custom", from: "2026-01-01", to: "2026-02-01" });
  });

  it("ignores a stored value it does not understand", () => {
    window.localStorage.setItem("period", '{"preset":"forever"}');
    expect(loadPeriod()).toEqual({ preset: "90d" });
  });
});
