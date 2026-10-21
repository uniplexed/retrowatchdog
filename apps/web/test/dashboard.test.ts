import { describe, expect, it } from "vitest";
import type { GameSummary, OwnedCopyDto, PluginDto, Signal, WatchlistItemDto } from "@retrowatchdog/shared";
import { actOnToday, needsYou, pluginsLine, valueDelta, watchesWithSignals } from "../src/lib/dashboard.js";

const game = (id: number): GameSummary => ({ id, title: `Game ${id}`, platform: "snes", year: 1995, coverUrl: null });
const sig = (over: Partial<Signal> & Pick<Signal, "type">): Signal => ({ reasoning: "why", confidence: "high", ...over });
const label = (s: Signal) => `title ${s.type}`;

const watch = (id: number, signals: Signal[]): WatchlistItemDto => ({
  id, game: game(id), region: "PAL", condition: null, targetPriceOriginal: null, targetCurrency: null,
  targetPriceUsd: null, storeOffer: null, storeBids: [], storeSource: null, priceDisplayAt: null,
  signalsAboveTarget: 0, signals,
});
const copy = (id: number, signals: Signal[], status: OwnedCopyDto["status"] = "owned", matchBasis: OwnedCopyDto["matchBasis"] = null) =>
  ({ id, game: game(100 + id), region: "PAL", condition: "cib", status, signals, matchBasis }) as OwnedCopyDto;

describe("actOnToday", () => {
  it("ranks across watches and copies and caps at 20", () => {
    const watches = Array.from({ length: 25 }, (_, i) => watch(i + 1, [sig({ type: "UNDERPRICED", edgePct: i })]));
    const copies = [copy(1, [sig({ type: "PROFIT", edgePct: 99 })])];
    const rows = actOnToday(watches, copies, label);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ key: "c:1", meta: "Your copy · PAL · cib" });
    expect(rows[1]).toMatchObject({ key: "w:25", meta: "Watch · PAL · any" });
    expect(rows[1].verdict.title).toBe("title UNDERPRICED");
  });

  it("ignores potential signals, sold copies and types the surface hides", () => {
    const rows = actOnToday(
      [watch(1, [sig({ type: "UNDERPRICED", confidence: "potential" })]), watch(2, [sig({ type: "PROFIT" })])],
      [copy(1, [sig({ type: "PROFIT" })], "sold"), copy(2, [sig({ type: "UNDERPRICED" })])],
      label,
    );
    expect(rows).toEqual([]);
  });
});

describe("valueDelta", () => {
  const p = (day: string, estimatedUsd: number) => ({ day, estimatedUsd, paidUsd: 0 });
  it("is the change from the period's first point to its last, and needs two of them", () => {
    expect(valueDelta([p("2026-10-01", 10), p("2026-10-17", 20)])).toBe(10);
    expect(valueDelta([p("2026-09-10", 50), p("2026-09-17", 60), p("2026-10-17", 75)])).toBe(25);
    expect(valueDelta([p("2026-10-17", 75)])).toBeNull();
    expect(valueDelta([])).toBeNull();
  });
});

describe("watchesWithSignals", () => {
  it("counts watches with a high signal", () => {
    expect(watchesWithSignals([watch(1, [sig({ type: "FLIP" })]), watch(2, [sig({ type: "FLIP", confidence: "potential" })])])).toBe(1);
  });
});

describe("needsYou", () => {
  const plugin = (id: number, status: PluginDto["status"], proposed: unknown = null) => ({ id, status, proposed }) as PluginDto;
  const money = { currency: "GBP", rate: 0.8, fetchedAt: null, mode: "auto", fxFailed: false } as const;

  it("pluralises and skips zeros", () => {
    expect(needsYou([plugin(1, "approved")], [copy(1, [])], money)).toEqual([]);
    expect(
      needsYou(
        [plugin(1, "pending"), plugin(2, "approved", { fingerprint: "x" }), plugin(3, "approved")],
        [copy(1, [], "owned", "candidate")],
        { ...money, fxFailed: true },
      ),
    ).toEqual([
      { key: "plugins", text: "2 plugins need review", target: "settings", section: "plugins" },
      { key: "copies", text: "1 copy needs a match check", target: "collection" },
      { key: "fx", text: "Exchange rates unavailable", target: "settings", section: "fx" },
    ]);
  });

  it("a plugin turned off on purpose does not nag", () => {
    expect(needsYou([plugin(1, "disabled")], [], money)).toEqual([]);
  });

  it("says nothing about plugins it could not load", () => {
    expect(needsYou(null, [], money)).toEqual([]);
  });
});

describe("pluginsLine", () => {
  const healthy = { status: "approved", proposed: null, lastHealthAt: "2026-10-17T10:00:00Z", configured: true, lastError: null, requiredSecrets: [], baseUrl: "http://x" };
  const p = (over: Partial<PluginDto> = {}) => ({ ...healthy, ...over }) as unknown as PluginDto;

  it("all plugins ok", () => {
    expect(pluginsLine([p(), p(), p()])).toBe("3 plugins ok");
    expect(pluginsLine([p()])).toBe("1 plugin ok");
  });

  it("some need you; a plugin turned off is neither", () => {
    expect(pluginsLine([p(), p({ lastHealthAt: null }), p({ status: "disabled" })])).toBe("1 of 3 plugins needs you");
    expect(pluginsLine([p({ status: "disabled" }), p()])).toBe("1 plugin ok");
  });

  it("every plugin turned off says so", () => {
    expect(pluginsLine([p({ status: "disabled" }), p({ status: "disabled" })])).toBe("All plugins off");
  });

  it("no plugins", () => {
    expect(pluginsLine([])).toBe("No plugins");
  });
});
