import type { NormalizedListing, PriceSourceAdapter, RawListing } from "../../src/adapters/types.js";

/** Single place tests build adapters, so a new required SPI field costs one edit. */
export function stubAdapter(overrides: Partial<PriceSourceAdapter> = {}): PriceSourceAdapter {
  return {
    source: "cex",
    snapshotStrategy: "per_listing",
    isConfigured: () => true,
    search: async (): Promise<RawListing[]> => [],
    normalize: (raw): NormalizedListing => ({
      ...raw,
      cleanTitle: raw.title.toLowerCase(),
      platformGuess: null,
      regionGuess: "PAL",
      conditionGuess: "unknown",
    }),
    ...overrides,
  };
}
