import type { Recommendation, ReliabilityRow } from "@retrowatchdog/shared";
import type { SignalConfig } from "../signals/computeSignals.js";

/** review_thresholds: a signal type whose logged signals mostly did not hold their price */
export function reviewThresholds(rows: ReliabilityRow[], cfg: SignalConfig, now: Date = new Date()): Recommendation[] {
  return rows
    .filter((r) => r.source === null && r.held + r.beaten >= 10 && r.heldPct !== null && r.heldPct < cfg.reliabilityMinPct)
    .map((r) => {
      const name = r.type.toLowerCase().replace(/_/g, " ");
      return {
      action: "review_thresholds",
      subject: { kind: "signal_type", type: r.type },
      title: `Review the ${name} thresholds`,
      reason: `Only ${r.heldPct}% of ${r.held + r.beaten} ${name} signals held their price; under ${cfg.reliabilityMinPct}%`,
      gainUsd: null,
      confidence: "potential",
      since: now.toISOString().slice(0, 10),
      } satisfies Recommendation;
    });
}
