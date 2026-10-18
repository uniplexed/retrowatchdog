import { describe, expect, it } from "vitest";
import type { SourceId } from "@retrowatchdog/shared";
import { applyDefaultRegion } from "../../../src/adapters/defaultRegion.js";
import { SidecarAdapter } from "../../../src/adapters/sidecar/index.js";

describe("applyDefaultRegion", () => {
  it("fills a region the title did not declare", () => {
    expect(applyDefaultRegion("unknown", "Dr. Mario", "PAL")).toBe("PAL");
  });

  it("never overrides a region the title DID declare", () => {
    expect(applyDefaultRegion("NTSC_J", "Dr. Mario (JAP)", "PAL")).toBe("NTSC_J");
  });

  it("leaves a bare import marker unknown, because it says 'not domestic' without saying which", () => {
    expect(applyDefaultRegion("unknown", "Dr. Mario import", "PAL")).toBe("unknown");
  });

  it("declares nothing when the source declared nothing", () => {
    expect(applyDefaultRegion("unknown", "Dr. Mario", null)).toBe("unknown");
  });
});

/**
 * The live-path proof: SidecarAdapter.normalize actually calls the shared
 * rule rather than just `classifyListing(raw)`. Built the same way the
 * neighbouring suite builds one (test/adapters/sidecar/adapter.test.ts's own
 * `adapter()`), copied rather than imported — that factory is not exported,
 * and a three-line local copy reads better here than exporting it just to
 * share it.
 */
const SOURCE = "community_demo" as SourceId;

function adapter(
  overrides: Partial<ConstructorParameters<typeof SidecarAdapter>[0]> = {},
): SidecarAdapter {
  return new SidecarAdapter({
    source: SOURCE,
    baseUrl: "http://sidecar.test:8000",
    snapshotStrategy: "per_listing",
    rateLimitMs: 0,
    timeoutMs: 500,
    ...overrides,
  });
}

describe("SidecarAdapter.normalize", () => {
  it("classifies a live plugin's unmarked listing under the region it declared", () => {
    const liveAdapter = adapter({ defaultRegion: "PAL" });
    expect(
      liveAdapter.normalize({ sourceProductId: "1", title: "Dr. Mario", prices: [], url: null }).regionGuess,
    ).toBe("PAL");
  });
});
