import { describe, expect, it } from "vitest";
import { parseWindow } from "../../src/lib/window.js";

const NOW = new Date("2026-10-21T15:00:00Z");

describe("parseWindow: one date window for every history", () => {
  it("days counts whole UTC days back from today, today included", () => {
    expect(parseWindow({ days: "30" }, 90, NOW)).toEqual({ ok: true, from: "2026-09-22", to: "2026-10-21", days: 30 });
  });

  it("falls back to the route's own default when nothing is asked", () => {
    expect(parseWindow({}, 90, NOW)).toMatchObject({ ok: true, from: "2026-07-24", to: "2026-10-21", days: 90 });
  });

  it("an explicit from and to win, and the span is what they cover", () => {
    expect(parseWindow({ from: "2026-01-01", to: "2026-01-31" }, 90, NOW)).toEqual({ ok: true, from: "2026-01-01", to: "2026-01-31", days: 31 });
  });

  it("a to in the future is today: there is nothing after it", () => {
    expect(parseWindow({ from: "2026-10-01", to: "2027-01-01" }, 90, NOW)).toMatchObject({ ok: true, to: "2026-10-21", days: 21 });
  });

  it.each([
    [{ from: "2026-02-01", to: "2026-01-01" }, "from after to"],
    [{ from: "2026-13-01", to: "2026-12-01" }, "not a date"],
    [{ from: "2026-01-01" }, "from without to"],
    [{ from: "2023-01-01", to: "2026-01-01" }, "over two years"],
    [{ days: "0" }, "zero days"],
    [{ days: "731" }, "over two years by days"],
  ] as Array<[Record<string, string>, string]>)("refuses %j (%s) rather than guessing", (q) => {
    expect(parseWindow(q, 90, NOW).ok).toBe(false);
  });
});
