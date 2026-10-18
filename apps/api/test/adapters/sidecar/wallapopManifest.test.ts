import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest } from "@retrowatchdog/shared";

/**
 * The Wallapop sidecar's manifest, as this app validates it: the same check as
 * vintedManifest.test.ts, against a document generated from
 * retrowatchdog-wallapop-sidecar-plugin (its README says how to regenerate it).
 */
const manifest: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../src/adapters/sidecar/fixtures/wallapop-manifest.json", import.meta.url)), "utf8"),
);

describe("the Wallapop sidecar's manifest, as this app validates it", () => {
  it("is accepted whole, with the reason shown when it is not", () => {
    const result = validateManifest(manifest);
    expect(result.ok ? null : result.reason).toBeNull();
  });

  it("declares Spain, Italy and Portugal as asking prices, with no secrets", () => {
    const result = validateManifest(manifest);
    if (!result.ok) throw new Error(result.reason);
    expect(result.manifest.sources.map((s) => [s.id, s.country])).toEqual([
      ["wallapop_es", "ES"],
      ["wallapop_it", "IT"],
      ["wallapop_pt", "PT"],
    ]);
    for (const source of result.manifest.sources) {
      expect(source.kindRoles).toEqual({ active_listing: "buy_listing" });
      expect(source.defaultRegion).toBeNull();
    }
    expect(result.manifest.requiredSecrets).toEqual([]);
  });

  it("survives the rebuild: nothing the app does not name comes through", () => {
    const result = validateManifest(manifest);
    if (!result.ok) throw new Error(result.reason);
    const sent = (manifest as { sources: Record<string, unknown>[] }).sources[0];
    const kept = result.manifest.sources[0] as unknown as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(kept).sort());
  });
});
