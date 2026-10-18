import { pickVerdict, type OwnedCopyDto, type Signal, type WatchlistItemDto } from "@retrowatchdog/shared";
import { splitByConfidence } from "./signalVisibility.js";
import type { ControlGroupDef } from "../components/ListControls.js";

/**
 * A filter on one standard field of a list's rows. Options are built from the
 * values present, so a filter never offers something the list does not hold.
 */
export interface Facet<T> {
  id: string;
  label: string;
  /** the row's values for the field: several for a multi-valued field (a watch's signal types) */
  values: (item: T) => string[];
}

/** the value of a row that has nothing for the field; listed last */
const NONE = "none";

/** "all" first, then the values present, "none" last */
export function facetOptions<T>(facet: Facet<T>, items: T[]): string[] {
  const present = [...new Set(items.flatMap(facet.values))];
  const named = present.filter((v) => v !== NONE).sort((a, b) => a.localeCompare(b));
  return ["all", ...named, ...(present.includes(NONE) ? [NONE] : [])];
}

/** one predicate per chosen facet; "all" and unknown ids choose nothing */
export function facetFilters<T>(facets: Facet<T>[], chosen: Record<string, string>): Array<(item: T) => boolean> {
  return facets
    .filter((f) => chosen[f.id] !== undefined && chosen[f.id] !== "all")
    .map((f) => (item: T) => f.values(item).includes(chosen[f.id]));
}

/** stored facets: an object of strings, anything else dropped */
export function sanitizeFacets(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export const hasActiveFacets = (chosen: Record<string, string>): boolean => Object.values(chosen).some((v) => v !== "all");

/** the signal a watch's row leads with: the same ranking as the row's verdict line */
export function rowSignal(item: WatchlistItemDto): Signal | null {
  return pickVerdict(splitByConfidence(item.signals).high, () => "")?.signal ?? null;
}

export const WATCHLIST_FACETS: Facet<WatchlistItemDto>[] = [
  { id: "platform", label: "Console", values: (w) => [w.game.platform] },
  {
    id: "source",
    label: "Source",
    // the source behind the price the row shows: its verdict, else the shop's offer
    values: (w) => {
      const s = rowSignal(w);
      return [s?.source ?? s?.buySource ?? s?.sellSource ?? w.storeSource ?? NONE];
    },
  },
  {
    id: "signal",
    label: "Bark (Signal)",
    values: (w) => {
      const types = [...new Set(w.signals.filter((s) => s.type !== "INSUFFICIENT_DATA").map((s) => s.type))];
      return types.length === 0 ? [NONE] : types;
    },
  },
  {
    id: "confidence",
    label: "Confidence",
    values: (w) => {
      const real = w.signals.filter((s) => s.type !== "INSUFFICIENT_DATA");
      const { high, potential } = splitByConfidence(real);
      return [high.length > 0 ? "high" : potential.length > 0 ? "potential" : NONE];
    },
  },
  { id: "target", label: "Target", values: (w) => [w.targetPriceUsd === null ? NONE : "set"] },
];

export const COLLECTION_FACETS: Facet<OwnedCopyDto>[] = [
  {
    id: "source",
    label: "Valued by",
    values: (c) => [c.valueBasis?.readAs === "reading" ? c.valueBasis.source : NONE],
  },
  { id: "working", label: "Working", values: (c) => [c.workingState ?? NONE] },
  { id: "authenticity", label: "Authenticity", values: (c) => [c.authenticity ?? NONE] },
  { id: "acquiredFrom", label: "Bought from", values: (c) => [c.acquiredSource ?? NONE] },
  { id: "currency", label: "Paid in", values: (c) => [c.acquiredCurrency ?? NONE] },
];

/** the Filters & sort groups for a list's facets: only those whose rows hold two values or more */
export function facetGroups<T>(
  facets: Facet<T>[],
  items: T[],
  chosen: Record<string, string>,
  onChange: (facets: Record<string, string>) => void,
  labelOf: (facetId: string, value: string) => string,
): ControlGroupDef[] {
  return facets.flatMap((f) => {
    const options = facetOptions(f, items);
    const current = chosen[f.id] ?? "all";
    // a filter with one value narrows nothing; keep it while chosen so it can be cleared
    if (options.length < 3 && current === "all") return [];
    return [
      {
        id: `facet-${f.id}`,
        label: f.label,
        options: options.map((v) => ({ value: v, label: v === "all" || v === NONE ? v : labelOf(f.id, v) })),
        value: current,
        defaultValue: "all",
        onChange: (v: string) => onChange({ ...chosen, [f.id]: v }),
      },
    ];
  });
}
