import { PLATFORMS, type Platform } from "@retrowatchdog/shared";

const IGDB_TO_PLATFORM = new Map<number, Platform>(
  (Object.entries(PLATFORMS) as [Platform, { igdbId: number; extraIgdbIds?: number[] }][]).flatMap(
    ([key, info]) => [info.igdbId, ...(info.extraIgdbIds ?? [])].map((id) => [id, key] as [number, Platform]),
  ),
);

export function igdbIdToPlatform(igdbPlatformId: number): Platform | null {
  return IGDB_TO_PLATFORM.get(igdbPlatformId) ?? null;
}
