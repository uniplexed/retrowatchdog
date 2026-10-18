import type { Region } from "@retrowatchdog/shared";
import { REGION_IMPORT } from "../matching/vocabulary.js";

/**
 * A source's declared `defaultRegion`, applied only when the title declared
 * nothing, and never over a bare "import" marker: that marker says "not the
 * domestic region" without saying which, so filling it in would invent a fact.
 * One function so every source classifies the same SKU the same way.
 */
export function applyDefaultRegion(
  regionGuess: Region,
  title: string,
  defaultRegion: Region | null,
): Region {
  if (regionGuess !== "unknown") return regionGuess;
  if (defaultRegion === null) return regionGuess;
  if (REGION_IMPORT.test(title.toLowerCase())) return regionGuess;
  return defaultRegion;
}
