import type {
  Condition,
  PricePointDto,
  SourceId,
  SourceInfo,
  ValuationBasis,
  ValuationMarkets,
  ValueBasis,
} from "@retrowatchdog/shared";
import { valuesCopies } from "@retrowatchdog/shared";
import {
  buildSignalInputs,
  lookupReference,
  type ChosenReference,
  type RolePricePoint,
  type SignalInput,
} from "../signals/computeSignals.js";
import { copyRegionInput, type CopyDimensions } from "./copySlice.js";

/** the dimensions of an owned copy that decide which points may value it */
export type CopyForValuation = CopyDimensions;

/** one honest number for a copy: the USD value, the reading it came from, its source */
export interface CopyValuation {
  value: number;
  basis: ValueBasis;
  source: SourceId;
}

/**
 * First reading that can speak for the copy wins. Replacement never falls
 * through to a bid: what a store PAYS is not what it COSTS to rebuy.
 */
const READING_ORDER: Record<ValuationBasis, readonly ValuationBasis[]> = {
  market: ["market", "trade_in", "replacement"],
  trade_in: ["trade_in", "market", "replacement"],
  replacement: ["replacement", "market"],
};

/** The market median's basis carries the ladder rung it was reached through. */
const marketBasis = (m: ChosenReference): ValueBasis => ({
  readAs: "reading",
  source: m.source,
  priceKind: m.kind,
  viaUnknownCondition: m.viaUnknownCondition,
  viaUnknownRegion: m.viaUnknownRegion,
});

/** store and bid readings only ever widen to the same region's undeclared-condition rung */
const tierBasis = (point: RolePricePoint, viaUnknownCondition: boolean): ValueBasis => ({
  readAs: "reading",
  source: point.source,
  priceKind: point.kind,
  viaUnknownCondition,
  viaUnknownRegion: false,
});

/**
 * Value one owned copy (USD) from stored points only, under the requested
 * basis; `basis` names the concrete reading used so a fallback is never
 * mistaken for the one asked for.
 *
 * Built on the signal engine's role model (availability gate, reference
 * ladder, same sample floor), so "market value" here and "market reference"
 * in a bark can never disagree.
 *
 * Grade honesty: a graded point values only a copy of that grade; a graded
 * copy tries its grade-matched pool first, per reading, then the ungraded one.
 * Completeness is strict: own condition, then the undeclared-condition rung,
 * never a neighbouring tier. Concrete regions never mix.
 *
 * `opts.sources` is the approved-plugin registry: it decides each source's
 * country (markets gate) and each price kind's role.
 */
export function estimateCopyValue(
  points: PricePointDto[],
  copy: CopyForValuation,
  basis: ValuationBasis,
  opts: { minSample: number; markets: ValuationMarkets; sources: Record<string, SourceInfo> },
): CopyValuation | null {
  // Markets gate: only the home country values a copy. Signals are NOT gated.
  const inMarket = points.filter((p) => valuesCopies(p.source, opts.markets, opts.sources));
  const gradeMatched =
    copy.itemGrade === null ? [] : inMarket.filter((p) => p.grade != null && p.grade === copy.itemGrade);
  const ungraded = inMarket.filter((p) => p.grade == null);
  const pools: SignalInput[] = [
    ...(gradeMatched.length > 0
      ? [copyRegionInput(buildSignalInputs(gradeMatched, opts.sources), copy.region)]
      : []),
    copyRegionInput(buildSignalInputs(ungraded, opts.sources), copy.region),
  ];

  /** the copy's own condition, then the undeclared-condition rung — nothing else */
  const conditionRungs: Array<{ condition: Condition; viaUnknownCondition: boolean }> =
    copy.condition === "unknown"
      ? [{ condition: "unknown", viaUnknownCondition: false }]
      : [
          { condition: copy.condition, viaUnknownCondition: false },
          { condition: "unknown", viaUnknownCondition: true },
        ];

  /** best point of a rung: the extreme by `better`, among the markets allowed to value */
  const pickOnRung = (
    candidates: RolePricePoint[],
    better: (a: number, b: number) => boolean,
  ): CopyValuation | null => {
    for (const rung of conditionRungs) {
      let best: RolePricePoint | null = null;
      for (const point of candidates) {
        if (point.condition !== rung.condition) continue;
        if (best === null || better(point.price.usd, best.price.usd)) best = point;
      }
      if (best !== null) {
        return { value: best.price.usd, basis: tierBasis(best, rung.viaUnknownCondition), source: best.source };
      }
    }
    return null;
  };

  const readings: Record<ValuationBasis, (input: SignalInput) => CopyValuation | null> = {
    market: (input) => {
      const m = lookupReference(input, copy.condition, opts.minSample);
      return m === null ? null : { value: m.price.usd, basis: marketBasis(m), source: m.source };
    },
    // highest payout wins; bids are already the highest per (source, kind, condition)
    trade_in: (input) => pickOnRung(input.bids, (a, b) => a > b),
    // cheapest in-stock offer wins; offers are already the lowest per (source, condition)
    replacement: (input) => pickOnRung(input.storeOffers, (a, b) => a < b),
  };

  // grade preference is per reading: every pool tries a reading before the next
  for (const reading of READING_ORDER[basis]) {
    for (const input of pools) {
      const found = readings[reading](input);
      if (found !== null) return found;
    }
  }
  return null;
}
