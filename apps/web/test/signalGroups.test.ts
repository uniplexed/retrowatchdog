import { describe, expect, it } from "vitest";
import type { Signal } from "@retrowatchdog/shared";
import { groupSignalsBySource, sortByConfidence } from "../src/lib/signalGroups.js";

const gbp = (usd: number, original = usd) => ({ usd, original, currency: "GBP" });

const under = (source: string, usd: number, over: Partial<Signal> = {}): Signal => ({
  type: "UNDERPRICED",
  reasoning: `${source} at ${usd}`,
  source,
  price: gbp(usd),
  confidence: "high",
  caveats: [],
  ...over,
});

describe("groupSignalsBySource", () => {
  it("collapses a category into one group per source", () => {
    const groups = groupSignalsBySource(
      [under("ebay_uk", 19), under("cex", 24), under("ebay_uk", 21)],
      "min",
    );
    expect(groups.map((g) => g.source)).toEqual(["ebay_uk", "cex"]);
    expect(groups[0].signals).toHaveLength(2);
    expect(groups[1].signals).toHaveLength(1);
  });

  it("picks the MINIMUM amount for a buy-side category — the best deal, not the first row", () => {
    const [group] = groupSignalsBySource([under("ebay_uk", 21), under("ebay_uk", 19)], "min");
    expect(group.best).toEqual(gbp(19));
  });

  it("picks the MAXIMUM amount for a sell-side category", () => {
    const [group] = groupSignalsBySource([under("cex", 45), under("cex", 52)], "max");
    expect(group.best).toEqual(gbp(52));
  });

  it("ranks on the frozen USD leg but keeps the winner's own original", () => {
    // A GBP source and a EUR source in one category: only the USD legs are
    // comparable, and the amount that wins is rendered from its own currency.
    const groups = groupSignalsBySource(
      [
        under("ebay_uk", 30, { price: { usd: 30, original: 24, currency: "GBP" } }),
        under("ebay_de", 25, { source: "ebay_de", price: { usd: 25, original: 23, currency: "EUR" } }),
      ],
      "min",
    );
    expect(groups[0].source).toBe("ebay_de");
    expect(groups[0].best).toEqual({ usd: 25, original: 23, currency: "EUR" });
  });

  it("orders the groups best-deal-first, and sorts a group with no amount last", () => {
    const groups = groupSignalsBySource(
      [under("cex", 40), under("ebay_uk", 19), under("vinted_uk", 0, { price: undefined })],
      "min",
    );
    expect(groups.map((g) => g.source)).toEqual(["ebay_uk", "cex", "vinted_uk"]);
    expect(groups[2].best).toBeNull();
  });

  it("keeps high-confidence findings before potential ones inside a group", () => {
    // the ordering GameDetail applied to the ungrouped list (confidenceRank)
    // moves in here, so a collapsed group's first row is still its surest one
    const groups = groupSignalsBySource(
      [
        under("ebay_uk", 19, { reasoning: "potential-one", confidence: "potential", caveats: ["x"] }),
        under("ebay_uk", 21, { reasoning: "high-one" }),
      ],
      "min",
    );
    expect(groups[0].signals.map((s) => s.reasoning)).toEqual(["high-one", "potential-one"]);
  });

  it("puts a finding that names no source in its own source-less group", () => {
    // Nothing in this engine emits one — all three UNDERPRICED sites and the
    // OVERPRICED_STORE site set `source` — but the field is optional on the
    // type, and a header reading "undefined (1)" would be worse than no
    // header. The component renders a source-less group flat.
    const groups = groupSignalsBySource([under("ebay_uk", 19), under("", 5, { source: undefined })], "min");
    const orphan = groups.find((g) => g.source === null);
    expect(orphan?.signals).toHaveLength(1);
  });
});

describe("sortByConfidence", () => {
  it("moves high-confidence findings before potential ones, stably", () => {
    const potential = under("ebay_uk", 19, { reasoning: "potential-one", confidence: "potential", caveats: ["x"] });
    const highA = under("ebay_uk", 21, { reasoning: "high-a" });
    const highB = under("cex", 24, { reasoning: "high-b" });
    // potential listed FIRST in the input: the partition must still surface
    // both high-confidence findings ahead of it, in their original order
    const ordered = sortByConfidence([potential, highA, highB]);
    expect(ordered.map((s) => s.reasoning)).toEqual(["high-a", "high-b", "potential-one"]);
  });

  it("is exported for GameDetail's flat FLIP section to share, not reimplement", () => {
    // a missing confidence field counts as high (legacy payloads), same rule
    // confidenceRank documents
    const noConfidence = under("ebay_uk", 19, { reasoning: "no-confidence", confidence: undefined });
    const potential = under("ebay_uk", 21, { reasoning: "potential-one", confidence: "potential" });
    expect(sortByConfidence([potential, noConfidence]).map((s) => s.reasoning)).toEqual([
      "no-confidence",
      "potential-one",
    ]);
  });
});
