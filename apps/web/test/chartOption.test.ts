import { describe, expect, it } from "vitest";
import { chartOption, withGaps, yDomain } from "../src/components/chartOption.js";

const day = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const fmt = (usd: number): string => `$${usd.toFixed(2)}`;

describe("withGaps: a line never crosses a day nobody observed", () => {
  it("keeps consecutive days joined", () => {
    expect(withGaps([{ day: "2026-01-01", usd: 1 }, { day: "2026-01-02", usd: 2 }])).toEqual([
      [day("2026-01-01"), 1],
      [day("2026-01-02"), 2],
    ]);
  });

  it("puts one break into a gap of any length", () => {
    expect(withGaps([{ day: "2026-01-01", usd: 1 }, { day: "2026-01-05", usd: 2 }])).toEqual([
      [day("2026-01-01"), 1],
      [day("2026-01-02"), null],
      [day("2026-01-05"), 2],
    ]);
  });
});

describe("yDomain", () => {
  it("floors a sub-2% span so FX noise reads flat, not as a climb", () => {
    const { min, max } = yDomain([100, 100.5]);
    expect(max - min).toBeCloseTo(2.01, 1);
  });

  it("leaves a real span alone", () => {
    expect(yDomain([10, 20])).toEqual({ min: 10, max: 20 });
  });
});

describe("chartOption", () => {
  const base = {
    series: [
      { points: [{ day: "2026-01-01", usd: 10 }, { day: "2026-01-02", usd: 12 }] },
      { points: [] },
      { points: [{ day: "2026-01-02", usd: 30 }] },
    ],
    from: "2025-12-01",
    to: "2026-01-31",
    format: fmt,
    labels: ["CeX", "empty", "eBay"],
    colours: ["#111", "#222", "#333"],
    text: "#999",
  };

  it("spans exactly the window asked for, whatever the data covers", () => {
    const o = chartOption(base);
    expect(o.xAxis).toMatchObject({ type: "time", min: day("2025-12-01"), max: day("2026-01-31") });
  });

  it("draws one line per series that has points, keeping each one's own label and colour", () => {
    const o = chartOption(base);
    expect(o.series.map((s) => s.name)).toEqual(["CeX", "eBay"]);
    expect(o.series.map((s) => s.itemStyle.color)).toEqual(["#111", "#333"]);
    expect(o.series.every((s) => s.connectNulls === false)).toBe(true);
  });

  it("offers a range slider, zoom by drag, a PNG export and min/max/average marks", () => {
    const o = chartOption(base);
    expect(o.dataZoom.map((z) => z.type)).toEqual(["inside", "slider"]);
    expect(o.toolbox.feature).toHaveProperty("saveAsImage");
    expect(o.series[0].markPoint.data.map((d) => d.type)).toEqual(["min", "max"]);
    expect(o.series[0].markLine.data.map((d) => d.type)).toEqual(["average"]);
  });

  it("dashes a series past the palette instead of silently reusing a colour", () => {
    const many = { ...base, series: Array.from({ length: 4 }, () => base.series[0]), labels: ["a", "b", "c", "d"], colours: ["#1", "#2", "#3"] };
    const o = chartOption(many);
    expect(o.series.map((s) => s.lineStyle.type)).toEqual(["solid", "solid", "solid", "dashed"]);
  });

  it("formats axis and tooltip values the way the app shows money", () => {
    const o = chartOption(base);
    expect(o.yAxis.axisLabel.formatter(12.5)).toBe("$12.50");
  });
});
