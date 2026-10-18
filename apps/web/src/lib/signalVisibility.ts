import type { Signal } from "@retrowatchdog/shared";

/**
 * The visibility rule: high-confidence signals are shown, potential ones are
 * counted and folded away. A signal without a confidence field (an older
 * payload) counts as high and is returned with `confidence: "high"`, the way
 * the pills have always read it. INSUFFICIENT_DATA belongs to neither list.
 */
export function splitByConfidence(signals: readonly Signal[]): { high: Signal[]; potential: Signal[] } {
  const high: Signal[] = [];
  const potential: Signal[] = [];
  for (const s of signals) {
    if (s.type === "INSUFFICIENT_DATA") continue;
    if (s.confidence === "potential") potential.push(s);
    else high.push(s.confidence === "high" ? s : { ...s, confidence: "high" });
  }
  return { high, potential };
}

/** "1 possible signal" / "N possible signals" */
export const possibleCount = (n: number): string => `${n} possible bark${n === 1 ? "" : "s"} (signal${n === 1 ? "" : "s"})`;
