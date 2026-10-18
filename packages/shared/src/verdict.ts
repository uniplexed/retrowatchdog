import type { Signal, SignalType } from "./index.js";

/**
 * The one line a game leads with: its best high-confidence signal. API and web
 * share this ranking so the dashboard, the lists and the game page cannot
 * disagree about what matters for a game.
 */
export interface Verdict {
  tone: "buy" | "avoid";
  title: string;
  /** the signal's own reasoning, one line */
  reason: string;
  action?: { label: string; url: string } | { label: string; kind: "edit-watch" };
  signal: Signal;
}

/** what the UI says when pickVerdict returns null */
export const VERDICT_EMPTY_TITLE = "Nothing clear today";
/** the title of an avoid verdict: the only high signal says not to buy */
export const VERDICT_AVOID_TITLE = "Nothing to buy here";

/** signal types that point at something to do, ranked by edgePct */
const POSITIVE: ReadonlySet<SignalType> = new Set<SignalType>([
  "UNDERPRICED",
  "FLIP",
  "PROFIT",
  "PRICE_DROP",
  "NEW_LOW",
  "BACK_IN_STOCK",
  "RISING",
]);

export function isHigh(signal: Signal): boolean {
  return signal.confidence === "high";
}

/** the first signal with the largest edgePct (missing counts as 0) */
function best(signals: readonly Signal[]): Signal | undefined {
  let winner: Signal | undefined;
  for (const s of signals) {
    if (winner === undefined || (s.edgePct ?? 0) > (winner.edgePct ?? 0)) winner = s;
  }
  return winner;
}

function actionFor(signal: Signal): Verdict["action"] {
  if (signal.url !== undefined) return { label: "View listing →", url: signal.url };
  if (signal.type === "TARGET_HIT") return { label: "Edit watch", kind: "edit-watch" };
  return undefined;
}

/**
 * Order: a high TARGET_HIT (the user set that bar); else the high positive
 * signal with the largest edgePct; else a high OVERPRICED_STORE as an avoid
 * verdict; else null. Potential signals never lead. `label` titles a positive
 * verdict (callers own source labels and money formatting).
 */
export function pickVerdict(signals: readonly Signal[], label: (signal: Signal) => string): Verdict | null {
  const high = signals.filter(isHigh);
  const winner =
    best(high.filter((s) => s.type === "TARGET_HIT")) ?? best(high.filter((s) => POSITIVE.has(s.type)));
  if (winner !== undefined) {
    return { tone: "buy", title: label(winner), reason: winner.reasoning, action: actionFor(winner), signal: winner };
  }
  const avoid = high.find((s) => s.type === "OVERPRICED_STORE");
  if (avoid !== undefined) {
    return { tone: "avoid", title: VERDICT_AVOID_TITLE, reason: avoid.reasoning, signal: avoid };
  }
  return null;
}

/**
 * The verdict line for a signal, shared so the API (dashboard, settings
 * preview) and the web word it the same way. Callers pass their source-label
 * lookup and money formatting; a part the signal does not carry is dropped.
 */
export function verdictTitle(
  signal: Signal,
  sourceLabel: (id: string) => string,
  formatAmount: (amount: { original: number; currency: string; usd: number }) => string,
): string {
  const src = (id: string | undefined): string => (id === undefined ? "" : sourceLabel(id));
  const price = signal.price === undefined ? null : formatAmount(signal.price);
  const tail = (text: string): string => (price === null ? text : `${text}: ${price}`);
  switch (signal.type) {
    case "TARGET_HIT":
      return price === null ? `Target hit on ${src(signal.source)}` : `Target hit: ${price} on ${src(signal.source)}`;
    case "UNDERPRICED":
      return price === null ? `Buy on ${src(signal.source)}` : `Buy on ${src(signal.source)} for ${price}`;
    case "FLIP":
      // a flip without its sources names neither, rather than an empty pair
      return signal.buySource === undefined || signal.sellSource === undefined
        ? "Flip opportunity"
        : `Flip: buy on ${src(signal.buySource)}, sell to ${src(signal.sellSource)}`;
    case "PROFIT":
      return price === null ? `Sell to ${src(signal.sellSource)}` : `Sell to ${src(signal.sellSource)} for ${price}`;
    case "PRICE_DROP":
      return tail(`Price drop on ${src(signal.source)}`);
    case "NEW_LOW":
      return tail(`90-day low on ${src(signal.source)}`);
    case "BACK_IN_STOCK":
      return tail(`Back in stock at ${src(signal.source)}`);
    case "RISING":
      return "Your copy is rising";
    case "OVERPRICED_STORE":
      return VERDICT_AVOID_TITLE;
    case "INSUFFICIENT_DATA":
      return VERDICT_EMPTY_TITLE;
  }
}

/**
 * pickVerdict's order as a sort, for lists of verdicts (the dashboard): buys
 * before avoids; among buys a TARGET_HIT first, then the larger edgePct.
 * Array.prototype.sort is stable, so ties keep their input order.
 */
export function compareVerdicts(a: Verdict, b: Verdict): number {
  const rank = (v: Verdict): number => (v.tone === "avoid" ? 2 : v.signal.type === "TARGET_HIT" ? 0 : 1);
  return rank(a) - rank(b) || (b.signal.edgePct ?? 0) - (a.signal.edgePct ?? 0);
}
