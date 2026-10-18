import { describe, expect, it } from "vitest";
import type { Signal } from "@retrowatchdog/shared";
import { splitByConfidence } from "../src/lib/signalVisibility.js";

const s = (type: Signal["type"], confidence?: Signal["confidence"]): Signal => ({ type, reasoning: type, confidence });

describe("splitByConfidence", () => {
  it("puts high signals first-class and folds potential ones", () => {
    const { high, potential } = splitByConfidence([s("UNDERPRICED", "high"), s("FLIP", "potential"), s("NEW_LOW", "high")]);
    expect(high.map((x) => x.type)).toEqual(["UNDERPRICED", "NEW_LOW"]);
    expect(potential.map((x) => x.type)).toEqual(["FLIP"]);
  });

  it("reads a signal without a confidence field as high, as the pills always have", () => {
    const { high } = splitByConfidence([s("UNDERPRICED")]);
    expect(high).toHaveLength(1);
    expect(high[0].confidence).toBe("high");
  });

  it("keeps INSUFFICIENT_DATA out of both lists", () => {
    expect(splitByConfidence([s("INSUFFICIENT_DATA")])).toEqual({ high: [], potential: [] });
  });
});
