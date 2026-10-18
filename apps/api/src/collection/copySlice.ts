import type { Condition, ItemGrade, PricePointDto, Region, SourceInfo } from "@retrowatchdog/shared";
import type { SignalInput } from "../signals/computeSignals.js";

/** the dimensions of an owned copy that decide which stored points may speak for it */
export interface CopyDimensions {
  region: Region;
  condition: Condition;
  itemGrade: ItemGrade | null;
}

/**
 * Whether one stored point may enter an owned copy's signal slice, keyed on
 * the source's declared `reach`, never its id:
 * - a graded point fits only a copy of that grade; ungraded fits every copy;
 * - `local` reach: region AND condition must equal the copy's;
 * - `global` reach: each may also be "unknown" (the ladder labels that rung).
 * Never another concrete region or tier. An unknown source is held to exactness.
 */
export function admitsCopyPoint(
  copy: CopyDimensions,
  point: PricePointDto,
  sources: Record<string, SourceInfo>,
): boolean {
  if (point.grade != null && point.grade !== copy.itemGrade) return false;
  const reach = sources[point.source]?.reach ?? "local";
  const sameRegion = point.region === copy.region;
  const sameCondition = point.condition === copy.condition;
  if (reach === "local") return sameRegion && sameCondition;
  return (sameRegion || point.region === "unknown") && (sameCondition || point.condition === "unknown");
}

/**
 * The ONE region input an owned copy is judged in. When its region has no
 * points of its own, an empty input still carries the unknown-region
 * references, so the ladder's undeclared-region rungs stay reachable.
 */
export function copyRegionInput(inputs: SignalInput[], region: Region): SignalInput {
  return (
    inputs.find((i) => i.region === region) ?? {
      region,
      storeOffers: [],
      bids: [],
      listings: [],
      referenceByCondition: {},
      referenceUnknownRegion: inputs.find((i) => i.region === "unknown")?.referenceByCondition,
    }
  );
}
