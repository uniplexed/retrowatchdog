import { pickVerdict, verdictTitle, type Signal } from "@retrowatchdog/shared";
import { formatOriginal } from "../lib/money.js";
import { splitByConfidence } from "../lib/signalVisibility.js";
import { sourceLabel, useSources, type SourcesState } from "../lib/sources.js";
import { PILL_SURFACE_TYPES, type PillSurface } from "./SignalBadge.js";

/** The verdict title as every list words it: the source's label, the amount as quoted. */
export const verdictLabel =
  (sources: SourcesState) =>
  (s: Signal): string =>
    verdictTitle(s, (id) => sourceLabel(id, sources), (a) => formatOriginal(a.original, a.currency));

/**
 * A list row's right-hand line: the verdict of the signals this surface may
 * show, and how many possible ones were folded. The same ranking as the game
 * page, so a row and its game never disagree. `fallback` shows when there is
 * no verdict.
 */
export function VerdictLine({
  signals,
  surface,
  fallback,
}: {
  signals: Signal[];
  surface: PillSurface;
  fallback?: string | null;
}) {
  const sources = useSources();
  const allowed = signals.filter((s) => PILL_SURFACE_TYPES[surface].includes(s.type));
  // the visibility rule first: a signal without a confidence field counts as high
  const { high, potential } = splitByConfidence(allowed);
  const verdict = pickVerdict(high, verdictLabel(sources));
  const line = verdict?.title ?? fallback ?? null;
  if (line === null && potential.length === 0) return null;
  return (
    <span className="verdict-line">
      {line !== null && <span className={verdict === null ? "meta" : `verdict-${verdict.tone}`}>{line}</span>}
      {potential.length > 0 && <span className="meta possible-count">+{potential.length} possible</span>}
    </span>
  );
}
