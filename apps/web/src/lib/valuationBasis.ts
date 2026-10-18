import type { PriceKind, SourceInfo, ValuationBasis, ValueBasis } from "@retrowatchdog/shared";
import { VALUATION_BASES } from "@retrowatchdog/shared";

/**
 * The user's collection valuation basis: a client-side preference, sent as
 * `?valuation=`. An unknown stored value falls back to the default.
 */
const STORAGE_KEY = "valuationBasis";

export const DEFAULT_VALUATION_BASIS: ValuationBasis = "market";

function isValuationBasis(value: string | null): value is ValuationBasis {
  return value !== null && (VALUATION_BASES as readonly string[]).includes(value);
}

export function loadValuationBasis(): ValuationBasis {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isValuationBasis(stored)) return stored;
  } catch {
    // storage unavailable: fall through to the default
  }
  return DEFAULT_VALUATION_BASIS;
}

export function saveValuationBasis(basis: ValuationBasis): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, basis);
  } catch {
    // persistence is a convenience; the in-memory choice still applies
  }
}

/** display name of each selectable basis (Settings options, totals label) */
export const VALUATION_BASIS_LABEL: Record<ValuationBasis, string> = {
  market: "market",
  trade_in: "trade-in",
  replacement: "replacement",
};

/**
 * The one-line reading of each basis. Names the mechanism, not a brand: any
 * `bid`/`buy_store` source can serve it; the market is on each copy's tag.
 */
export const VALUATION_BASIS_EXPLANATION: Record<ValuationBasis, string> = {
  market: "what similar copies are listed for",
  trade_in: "what a shop would pay you",
  replacement: "what it costs to rebuy in a shop",
};

/** The stem of a value tag per price kind; exhaustive, so a new kind fails to compile. */
const READING_STEM: Record<PriceKind, string> = {
  active_median: "market",
  active_listing: "listing",
  voucher: "voucher",
  cash: "cash",
  sell: "sell",
  guide: "guide",
};

/** Why a copy carries no value; exhaustive over the excluded reasons. */
const EXCLUSION_LABEL: Record<
  Extract<ValueBasis, { readAs: "excluded" }>["reason"],
  string
> = {
  faulty: "excluded (faulty)",
  counterfeit: "excluded (counterfeit)",
  outside_valuation_markets: "priced, but outside your valuation markets",
};

/**
 * Short tag for the reading behind a copy's value: kind · market (fallback
 * rung), so a value from undeclared-condition/region points never passes for
 * an exact one. `sources` is `useSources().byId`.
 */
export function valueBasisTag(
  basis: ValueBasis | null | undefined,
  sources: Record<string, SourceInfo>,
): string | null {
  if (basis == null) return null;
  if (basis.readAs === "excluded") return EXCLUSION_LABEL[basis.reason];
  const rungs = [
    basis.viaUnknownRegion ? "undeclared region" : null,
    basis.viaUnknownCondition ? "undeclared condition" : null,
  ].filter((r): r is string => r !== null);
  // an id missing from the registry still renders honestly, as itself
  const label = sources[basis.source]?.label ?? basis.source;
  const stem = `${READING_STEM[basis.priceKind]} · ${label}`;
  return rungs.length > 0 ? `${stem} (${rungs.join(", ")})` : stem;
}
