import type { PriceKind, Signal, SignalType, SourceId, SourceInfo } from "@retrowatchdog/shared";
import { Pill } from "../ui/Pill.js";
import { formatMoney } from "../lib/money.js";
import { useSources } from "../lib/sources.js";

const TONE: Record<Signal["type"], string> = {
  UNDERPRICED: "opportunity",
  FLIP: "opportunity",
  PROFIT: "opportunity",
  OVERPRICED_STORE: "warning",
  INSUFFICIENT_DATA: "info",
  TARGET_HIT: "opportunity",
  PRICE_DROP: "opportunity",
  NEW_LOW: "opportunity",
  BACK_IN_STOCK: "opportunity",
  RISING: "opportunity",
};

/** the pill wording of the single-source opportunity types */
const SOURCE_PILL: Partial<Record<SignalType, string>> = {
  TARGET_HIT: "🎯 target",
  PRICE_DROP: "↓ price drop",
  NEW_LOW: "↓ 90-day low",
  BACK_IN_STOCK: "↺ in stock",
  RISING: "↑ rising",
};

/** a rendered direction tag; `potential` pills render dashed */
export interface DirectionPillSpec {
  label: string;
  tone: "opportunity" | "warning";
  potential: boolean;
}

/**
 * Source label from the registry map (a REQUIRED argument on every exported
 * helper here); an unknown id falls back to the raw id.
 */
function sourceLabel(id: SourceId, sources: Record<string, SourceInfo>): string {
  return sources[id]?.label ?? id;
}

/** A signed gain in the display currency: "+$26.00" / "−$3.00" (never "+−$3.00"). */
function signedMoney(usd: number): string {
  return usd < 0 ? `−${formatMoney(-usd)}` : `+${formatMoney(usd)}`;
}

/**
 * The instrument word for a PROFIT reading ("voucher", "cash"): only a
 * bid-role kind gets one; anything else gets null rather than a guess. Shared
 * by the compact pill and GameDetail so one source's voucher and cash PROFITs
 * are told apart the same way everywhere.
 */
export function profitInstrument(
  source: SourceId,
  kind: PriceKind | undefined,
  sources: Record<string, SourceInfo>,
): string | null {
  if (kind === undefined) return null;
  return sources[source]?.kindRoles[kind] === "bid" ? kind.replaceAll("_", " ") : null;
}

/** Flip label from the signal's buy/sell fields, with a generic fallback. */
export function flipLabel(signal: Signal, sources: Record<string, SourceInfo>): string {
  if (signal.buySource !== undefined && signal.sellSource !== undefined) {
    return `⇄ buy ${sourceLabel(signal.buySource, sources)} → sell ${sourceLabel(signal.sellSource, sources)}`;
  }
  return "⇄ flip opportunity";
}

/**
 * The compact direction tag for a signal, derived ONLY from its structured
 * metadata (source/buySource/sellSource — never from a source hardcoded per
 * type):
 * - UNDERPRICED       → "🛒 buy @ <source>" (where the cheap price is)
 * - OVERPRICED_STORE  → "⚠ overpriced @ <store>" (don't buy there)
 * - FLIP              → "⇄ buy A → sell B" (flipLabel, with its fallback)
 * - PROFIT            → "💰 sell @ <source> <instrument> (+gain)" (see profitInstrument)
 * - INSUFFICIENT_DATA → no pill (nothing actionable to tag)
 * A metadata-less UNDERPRICED/OVERPRICED_STORE/PROFIT renders no pill
 * rather than a direction that names nobody.
 */
export function directionPill(
  signal: Signal,
  sources: Record<string, SourceInfo>,
): DirectionPillSpec | null {
  // a signal without the confidence field (old payloads) renders solid
  const potential = signal.confidence === "potential";
  switch (signal.type) {
    case "UNDERPRICED":
      return signal.source !== undefined
        ? { label: `🛒 buy @ ${sourceLabel(signal.source, sources)}`, tone: "opportunity", potential }
        : null;
    case "OVERPRICED_STORE":
      return signal.source !== undefined
        ? { label: `⚠ overpriced @ ${sourceLabel(signal.source, sources)}`, tone: "warning", potential }
        : null;
    case "FLIP":
      return { label: flipLabel(signal, sources), tone: "opportunity", potential };
    case "PROFIT": {
      if (signal.sellSource === undefined) return null;
      const instrument = profitInstrument(signal.sellSource, signal.sellKind, sources);
      return {
        label: `💰 sell @ ${sourceLabel(signal.sellSource, sources)}${instrument !== null ? ` ${instrument}` : ""}${
          signal.gainUsd !== undefined ? ` (${signedMoney(signal.gainUsd)})` : ""
        }`,
        tone: "opportunity",
        potential,
      };
    }
    case "INSUFFICIENT_DATA":
      return null;
    case "TARGET_HIT":
    case "PRICE_DROP":
    case "NEW_LOW":
    case "BACK_IN_STOCK":
    case "RISING":
      return signal.source !== undefined
        ? { label: `${SOURCE_PILL[signal.type]} @ ${sourceLabel(signal.source, sources)}`, tone: "opportunity", potential }
        : null;
  }
}

/** the ONE pill rendering every surface shares — look identical everywhere */
function PillTag({ pill }: { pill: DirectionPillSpec }) {
  const tone = pill.potential ? "potential" : pill.tone === "warning" ? "avoid" : "buy";
  return (
    <Pill tone={tone} className={`badge-compact ${pill.tone}${pill.potential ? " potential" : ""}`}>
      {pill.label}
    </Pill>
  );
}

/**
 * A signal's direction tag as an element; nothing for pill-less signals.
 * `sources` overrides the loaded registry — for tests only.
 */
export function SignalDirectionPill({
  signal,
  sources,
}: {
  signal: Signal;
  sources?: Record<string, SourceInfo>;
}) {
  const loaded = useSources();
  const pill = directionPill(signal, sources ?? loaded.byId);
  if (pill === null) return null;
  return <PillTag pill={pill} />;
}

/** the two list/card surfaces that render compact pills */
export type PillSurface = "watchlist" | "collection";

/**
 * Which signal types each surface may render as a pill. Two explicit
 * allow-lists, never merged: a watch is not a copy (no 💰 PROFIT), and a
 * cheap listing is not an alert about a copy you own (no 🛒 on collection).
 */
export const PILL_SURFACE_TYPES: Record<PillSurface, readonly SignalType[]> = {
  watchlist: ["UNDERPRICED", "FLIP", "OVERPRICED_STORE", "TARGET_HIT", "PRICE_DROP", "NEW_LOW", "BACK_IN_STOCK"],
  collection: ["FLIP", "OVERPRICED_STORE", "PROFIT", "RISING"],
};

/**
 * Extended alert badge (GameDetail's barks): pill, title, full reasoning and
 * listing link; potential badges render dashed with their caveats.
 */
export function SignalBadge({ signal }: { signal: Signal }) {
  const sources = useSources();
  const pill = directionPill(signal, sources.byId);
  const potential = signal.confidence === "potential";
  return (
    <span className={`signal-line ${TONE[signal.type]}${potential ? " potential" : ""}`}>
      {pill !== null && (
        <>
          <PillTag pill={pill} />
          <br />
        </>
      )}
      <strong>{signal.type.replaceAll("_", " ")}</strong>
      {signal.confidence !== undefined && (
        <span className="confidence-marker">
          {" "}
          {potential ? "❓ potential" : "✔ high confidence"}
        </span>
      )}
      <br />
      {signal.reasoning}
      {signal.url && (
        <>
          {" "}
          <a href={signal.url} target="_blank" rel="noreferrer">
            View listing →
          </a>
        </>
      )}
      {potential && signal.caveats !== undefined && signal.caveats.length > 0 && (
        <span className="source-note confidence-caveats">
          <br />
          why potential: {signal.caveats.join("; ")}
        </span>
      )}
    </span>
  );
}

/** high-before-potential sort key; a missing confidence counts as high */
export function confidenceRank(signal: Signal): number {
  return signal.confidence === "potential" ? 1 : 0;
}
