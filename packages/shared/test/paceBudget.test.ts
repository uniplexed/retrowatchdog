import { describe, it, expect } from "vitest";
import { PLUGIN_CALL_ALLOWANCE_MS, paceBudget, pacedSourceCount } from "../src/index.js";

/**
 * The arithmetic behind the one plugin setting that has already taken markets
 * dark in production.
 *
 * A plugin's sources share ONE limiter, so a pace does not slow one call down
 * — it decides when the LAST of its sources starts. The rule tested here is
 * that starting is not enough: the call still has to finish inside the same
 * budget a game view races it against.
 */
describe("paceBudget", () => {
  // The live numbers: five eBay markets, an 8000 ms adapter budget.
  const EBAY = 5;
  const BUDGET = 8000;

  it("refuses the pace that actually took four markets dark", () => {
    // 3000 ms was the default in force during the incident. The fifth market
    // would start twelve seconds into a budget of eight.
    const at3000 = paceBudget(EBAY, 3000, BUDGET);
    expect(at3000.lastStartMs).toBe(12000);
    expect(at3000.fits).toBe(false);
  });

  it("refuses a pace whose last call starts in time but cannot finish", () => {
    // THE BUG THIS TEST EXISTS FOR. Judging a pace by whether the last call
    // has STARTED admits 1999 ms for five markets: the fifth starts at 7996 ms
    // of an 8000 ms budget, with 4 ms left to complete an eBay round trip. It
    // would time out on every game view — the very outage the setting exists
    // to prevent — and the app would have called it a pass.
    const naivelyFine = paceBudget(EBAY, 1999, BUDGET);
    expect(naivelyFine.lastStartMs).toBe(7996);
    expect(naivelyFine.lastStartMs).toBeLessThan(BUDGET);
    expect(naivelyFine.fits).toBe(false);
  });

  it("names the largest pace that leaves the last call room to answer", () => {
    const budget = paceBudget(EBAY, 3000, BUDGET);
    expect(budget.largestThatFitsMs).toBe(1500);
    // and that value is itself accepted, while one millisecond more is not
    expect(paceBudget(EBAY, 1500, BUDGET).fits).toBe(true);
    expect(paceBudget(EBAY, 1501, BUDGET).fits).toBe(false);
  });

  it("passes the pace this deployment actually runs at", () => {
    const live = paceBudget(EBAY, 250, BUDGET);
    expect(live.lastStartMs).toBe(1000);
    expect(live.fits).toBe(true);
  });

  it("has no gap to fit when a plugin serves one source", () => {
    // Nothing queues behind anything, so any pace is survivable and there is
    // no "largest" to name.
    const one = paceBudget(1, 60_000, BUDGET);
    expect(one.lastStartMs).toBe(0);
    expect(one.fits).toBe(true);
    expect(one.largestThatFitsMs).toBeNull();
  });

  it("scales with the number of sources, not with a fixed count", () => {
    // The same pace passes or fails on how many markets share the queue. Three
    // at 3000 ms fit exactly — the last starts at 6000 ms and has its full
    // 2000 ms allowance inside the 8000 — and a fourth is what breaks it.
    expect(paceBudget(2, 3000, BUDGET).fits).toBe(true);
    expect(paceBudget(3, 3000, BUDGET).fits).toBe(true);
    expect(paceBudget(4, 3000, BUDGET).fits).toBe(false);
  });

  it("keeps the allowance a stated constant, not a number hidden in a formula", () => {
    // The panel's warning and the API's refusal both read it from here, so a
    // change moves both at once or neither.
    expect(PLUGIN_CALL_ALLOWANCE_MS).toBe(2000);
    expect(paceBudget(2, BUDGET - PLUGIN_CALL_ALLOWANCE_MS, BUDGET).fits).toBe(true);
    expect(paceBudget(2, BUDGET - PLUGIN_CALL_ALLOWANCE_MS + 1, BUDGET).fits).toBe(false);
  });
});

/**
 * Which sources a pace has to answer for. The pace is a promise about a game
 * view, and a sync source is not in one.
 */
describe("pacedSourceCount", () => {
  const BUDGET = 8000;
  const live = (id: string) => ({ id, kind: "live" as const });
  const sync = (id: string) => ({ id, kind: "sync" as const });

  it("counts a live plugin's markets, as it always did", () => {
    expect(pacedSourceCount([live("a"), live("b"), live("c"), live("d"), live("e")])).toBe(5);
  });

  it("frees a three-source sync plugin from a budget it is not in", () => {
    // THE CASE THIS EXISTS FOR: CeX ported as a plugin declares three sync
    // sources and is held to one Algolia application's 10 s pace. Counted as
    // three, the budget capped it at 3000 ms and the pace endpoint refused
    // the only correct value.
    const cex = [sync("cex"), sync("cex_es"), sync("cex_ie")];
    expect(pacedSourceCount(cex)).toBe(1);
    expect(paceBudget(pacedSourceCount(cex), 10_000, BUDGET).fits).toBe(true);
  });

  it("still holds a mixed plugin to its live half", () => {
    expect(pacedSourceCount([live("a"), sync("b"), live("c")])).toBe(2);
  });

  it("floors at one, so an empty or sync-only plugin has no gap to fit", () => {
    expect(pacedSourceCount([])).toBe(1);
    expect(paceBudget(pacedSourceCount([]), 60_000, BUDGET).fits).toBe(true);
  });
});
