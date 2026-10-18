import type { Signal, SignalAmount, SourceId } from "@retrowatchdog/shared";
import { confidenceRank } from "../components/SignalBadge.js";
import { bestBy, descNullsLast } from "./listControls.js";

/**
 * One bark category's findings, collapsed into per-source groups (one
 * game/source pair was measured at 126 active listings). Pure arithmetic;
 * labels and amounts are formatted at render time.
 */

/** Which end of a group is the best one: the cheapest buy, the richest sell. */
export type BestSide = "min" | "max";

export interface SignalGroup {
  /** the source every finding here came from; null when a finding names none */
  source: SourceId | null;
  /** the findings, high-confidence first */
  signals: Signal[];
  /** the best amount in the group, or null when no finding carries a price */
  best: SignalAmount | null;
}

/**
 * Ranked on the USD leg (the only one comparable across currencies) and
 * returned whole, so the winner still renders its verbatim original.
 */
function bestAmount(signals: Signal[], side: BestSide): SignalAmount | null {
  const priced = signals.filter((s): s is Signal & { price: SignalAmount } => s.price !== undefined);
  return bestBy(priced, (s) => s.price.usd, side)?.price ?? null;
}

/** Best deal first; a group with no amount goes last regardless of side. */
function compareGroups(side: BestSide): (a: SignalGroup, b: SignalGroup) => number {
  return (a, b) => {
    if (a.best === null || b.best === null) return descNullsLast(a.best?.usd ?? null, b.best?.usd ?? null);
    return side === "min" ? a.best.usd - b.best.usd : b.best.usd - a.best.usd;
  };
}

/** High-before-potential, as a stable partition: confidenceRank is only 0 or 1. */
export function sortByConfidence(signals: Signal[]): Signal[] {
  return [...signals.filter((s) => confidenceRank(s) === 0), ...signals.filter((s) => confidenceRank(s) === 1)];
}

export function groupSignalsBySource(signals: Signal[], side: BestSide): SignalGroup[] {
  const ordered = sortByConfidence(signals);
  const byKey = new Map<string, SignalGroup>();
  for (const signal of ordered) {
    const source = signal.source ?? null;
    const existing = byKey.get(source ?? "");
    if (existing) existing.signals.push(signal);
    else byKey.set(source ?? "", { source, signals: [signal], best: null });
  }
  const groups = [...byKey.values()];
  for (const group of groups) group.best = bestAmount(group.signals, side);
  // stable sort again: groups whose best amounts tie keep first-seen order
  return groups.sort(compareGroups(side));
}
