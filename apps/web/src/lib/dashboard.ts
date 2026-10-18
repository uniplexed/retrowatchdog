import {
  compareVerdicts,
  pickVerdict,
  type CollectionHistoryResponse,
  type GameSummary,
  type OwnedCopyDto,
  type PluginDto,
  type Signal,
  type Verdict,
  type WatchlistItemDto,
} from "@retrowatchdog/shared";
import { PILL_SURFACE_TYPES, type PillSurface } from "../components/SignalBadge.js";
import { needsReview } from "../components/plugins/grants.js";
import { pluginState } from "../components/plugins/copy.js";
import { isBarking } from "./listControls.js";
import { splitByConfidence } from "./signalVisibility.js";
import type { MoneyState } from "./money.js";

/** One of today's good prices under "Recommended actions": a watch or a copy and the verdict it leads with. */
export interface ActRow {
  key: string;
  game: GameSummary;
  meta: string;
  verdict: Verdict;
}

const ACT_LIMIT = 20;
const DAY_MS = 86_400_000;

const verdictFor = (signals: Signal[], surface: PillSurface, label: (s: Signal) => string): Verdict | null =>
  // the visibility rule first: a signal without a confidence field counts as high
  pickVerdict(splitByConfidence(signals.filter((s) => PILL_SURFACE_TYPES[surface].includes(s.type))).high, label);

/**
 * Every watch and active copy with a verdict, best first (the verdict order),
 * at most 20. Each surface keeps its own allow-list: a cheap listing is not
 * news about a copy you own, a profit is not news about a watch.
 */
export function actOnToday(
  watchlist: WatchlistItemDto[],
  collection: OwnedCopyDto[],
  label: (s: Signal) => string,
): ActRow[] {
  const rows: ActRow[] = [];
  for (const w of watchlist) {
    const verdict = verdictFor(w.signals, "watchlist", label);
    if (verdict !== null) {
      rows.push({ key: `w:${w.id}`, game: w.game, meta: `Watch · ${w.region ?? "any"} · ${w.condition ?? "any"}`, verdict });
    }
  }
  for (const c of collection) {
    if (c.status === "sold" || c.status === "returned") continue;
    const verdict = verdictFor(c.signals, "collection", label);
    if (verdict !== null) {
      rows.push({ key: `c:${c.id}`, game: c.game, meta: `Your copy · ${c.region} · ${c.condition}`, verdict });
    }
  }
  return rows.sort((a, b) => compareVerdicts(a.verdict, b.verdict)).slice(0, ACT_LIMIT);
}

/** The value now against the newest point at least 30 days older; null without one. */
export function valueDelta(points: CollectionHistoryResponse["points"]): number | null {
  const last = points.at(-1);
  if (last === undefined) return null;
  const cutoff = Date.parse(last.day) - 30 * DAY_MS;
  const before = points.filter((p) => Date.parse(p.day) <= cutoff).at(-1);
  return before === undefined ? null : last.estimatedUsd - before.estimatedUsd;
}

export const watchesWithSignals = (items: WatchlistItemDto[]): number => items.filter(isBarking).length;

/** One "Needs you" line: where it leads, and for Settings which section. */
export interface NeedsYouLine {
  key: string;
  text: string;
  target: "settings" | "collection";
  section?: "plugins" | "fx";
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What waits on a person: consent, match checks, broken rates. Zero says nothing. */
export function needsYou(
  plugins: PluginDto[] | null,
  copies: OwnedCopyDto[],
  money: MoneyState,
): NeedsYouLine[] {
  const lines: NeedsYouLine[] = [];
  // a plugin turned off on purpose is a decision taken, not one waiting
  const reviews = (plugins ?? []).filter((p) => p.status !== "disabled" && needsReview(p)).length;
  if (reviews > 0) {
    lines.push({ key: "plugins", text: `${plural(reviews, "plugin needs", "plugins need")} review`, target: "settings", section: "plugins" });
  }
  const checks = copies.filter((c) => c.matchBasis === "candidate" || c.matchBasis === "manual").length;
  if (checks > 0) lines.push({ key: "copies", text: `${plural(checks, "copy needs", "copies need")} a match check`, target: "collection" });
  if (money.fxFailed) lines.push({ key: "fx", text: "Exchange rates unavailable", target: "settings", section: "fx" });
  return lines;
}

/** The sidebar footer's plugin fact: all fine, or how many need you. A plugin turned off is neither. */
export function pluginsLine(plugins: PluginDto[]): string {
  if (plugins.length === 0) return "No plugins";
  const tones = plugins.map((p) => pluginState(p).tone);
  const warn = tones.filter((t) => t === "warning").length;
  if (warn > 0) return `${warn} of ${plugins.length} plugins ${warn === 1 ? "needs" : "need"} you`;
  const ok = tones.filter((t) => t === "ok").length;
  return ok === 0 ? "All plugins off" : plural(ok, "plugin ok", "plugins ok");
}
