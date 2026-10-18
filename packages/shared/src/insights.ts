import type { Platform } from "./platforms.js";
import type { GameSummary, SignalType, SourceId } from "./index.js";

/** The recommendation thresholds: the values Settings shows as recommended. */
export const RECOMMENDATION_DEFAULTS = {
  /** sell_now: the bid is the highest in this many days */
  sellHighDays: 90,
  /** sell_now / buy_now: the window a trend is read over */
  trendDays: 30,
  /** buy_now: the price is the lowest in this many days … */
  buyLowDays: 90,
  /** … or this many percent under that window's mean */
  buyBelowAvgPct: 15,
  /** raise/lower_target: the window a target is judged over */
  targetWindowDays: 180,
  /** raise_target: never met, and the low is within this percent of the target */
  targetNearPct: 20,
  /** lower_target: under the target on more than this percent of observed days */
  targetOftenPct: 50,
  /** unwatch: no price move bigger than this percent … */
  quietPct: 5,
  /** … and no signal, for this many days (review_copy: no price for this long) */
  quietDays: 120,
  /** prefer_source: the window sources are compared over */
  sourceWindowDays: 90,
  /** prefer_source: one source wins in at least this percent of games … */
  sourceDominancePct: 60,
  /** … of a console with at least this many games */
  minGamesPerConsole: 5,
  /** review_thresholds: a signal type held less often than this percent */
  reliabilityMinPct: 40,
  /** signal_log: a signal is judged this many days after it first appeared */
  evalDays: 14,
  /** signal_log: a price this many percent better than the signal's beats it */
  beatenPct: 5,
  /** signal_log: rows older than this many days are deleted */
  logRetentionDays: 365,
  /** the watchlist history and row sparklines, in days */
  historyDays: 90,
} as const;

export type RecommendationThresholds = { -readonly [K in keyof typeof RECOMMENDATION_DEFAULTS]: number };

export type RecommendationAction =
  | "sell_now"
  | "buy_now"
  | "raise_target"
  | "lower_target"
  | "unwatch"
  | "review_copy"
  | "prefer_source"
  | "review_thresholds";

/** money before clean-up: the order a list of recommendations is read in */
export const ACTION_ORDER: readonly RecommendationAction[] = [
  "sell_now",
  "buy_now",
  "raise_target",
  "lower_target",
  "unwatch",
  "review_copy",
  "prefer_source",
  "review_thresholds",
];

export type RecommendationSubject =
  | { kind: "copy"; copyId: number; game: GameSummary }
  | { kind: "watch"; watchId: number; game: GameSummary }
  | { kind: "console"; platform: Platform }
  | { kind: "signal_type"; type: SignalType };

/** One thing to do, with the figures that justify it. */
export interface Recommendation {
  action: RecommendationAction;
  subject: RecommendationSubject;
  /** one sentence with the verb: "Sell Shenmue to CeX UK for £38" */
  title: string;
  /** one sentence with the figures, in the currency the comparison used */
  reason: string;
  /** what is at stake, USD; null for clean-ups */
  gainUsd: number | null;
  confidence: "high" | "potential";
  /** ISO date the condition first held */
  since: string;
  link?: { label: string; url: string };
}

/** How often one signal type (and source) was right, from signal_log. */
export interface ReliabilityRow {
  type: SignalType;
  /** null on the aggregate row of a type */
  source: SourceId | null;
  logged: number;
  evaluated: number;
  held: number;
  beaten: number;
  unknown: number;
  /** held / (held + beaten); null under 10 evaluated */
  heldPct: number | null;
  meanGainUsd: number | null;
}

/** GET /api/insights */
export interface InsightsResponse {
  recommendations: Recommendation[];
  reliability: ReliabilityRow[];
  /** the first signal_log row; null before any */
  measuredSince: string | null;
  computedAt: string;
}

/** GET /api/settings/signals/suggested: thresholds derived from this deployment's history */
export interface SuggestedThresholdsResponse {
  /** one line on what the values were derived from; null when there is not enough history */
  basis: string | null;
  values: Partial<Pick<RecommendationThresholds, "quietDays" | "buyBelowAvgPct" | "targetNearPct" | "minGamesPerConsole">>;
  /** per key, why it has (or has no) data-derived value */
  notes: Record<string, string>;
}

/** ACTION_ORDER, then the larger gain (null last), then the title. */
export function compareRecommendations(a: Recommendation, b: Recommendation): number {
  const byAction = ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action);
  if (byAction !== 0) return byAction;
  if (a.gainUsd !== b.gainUsd) {
    if (a.gainUsd === null) return 1;
    if (b.gainUsd === null) return -1;
    return b.gainUsd - a.gainUsd;
  }
  return a.title.localeCompare(b.title);
}
