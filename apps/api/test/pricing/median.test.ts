import { describe, it, expect } from "vitest";
import { median, trimOutliers } from "../../src/pricing/median.js";

describe("median", () => {
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
  });
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("trimOutliers", () => {
  it("keeps everything when n < 5 (too small to trim)", () => {
    expect(trimOutliers([1, 2, 999, 4])).toEqual([1, 2, 999, 4]);
  });
  it("drops values outside the P10-P90 band", () => {
    const values = [5, 22, 23, 24, 25, 26, 27, 28, 29, 999];
    const trimmed = trimOutliers(values);
    expect(trimmed).not.toContain(5);
    expect(trimmed).not.toContain(999);
    expect(trimmed).toContain(22);
    expect(trimmed).toContain(29);
  });
  it("median of trimmed listing set matches spec behavior", () => {
    const prices = [8, 20, 21, 22, 23, 25, 27, 30, 32, 400];
    expect(median(trimOutliers(prices))).toBe(24);
  });
});
