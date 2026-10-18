import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest } from "@retrowatchdog/shared";

/**
 * The two halves of protocol 3 agree — checked, not assumed.
 *
 * The Python sidecar's own tests assert what its manifest CONTAINS, and this
 * app's tests assert what `validateManifest` ACCEPTS, and both suites can pass
 * while the two documents disagree about a field name, a spelling or a value
 * the app happens not to know. Nothing else in the tree crosses that line: the
 * app never imports Python and the sidecar never imports TypeScript, so the
 * first place a mismatch would show up is a user clicking Import and reading a
 * rejection.
 *
 * The fixture is a real response, generated from retrowatchdog-vinted-sidecar-plugin/ and
 * committed rather than hand-written — a hand-written one would test what we
 * believe the sidecar sends. Regenerate it after any change to that service's
 * manifest:
 *
 *   cd retrowatchdog-vinted-sidecar-plugin && python -c "import json; \
 *     from app.config import load_settings; from app.manifest import manifest_payload; \
 *     print(json.dumps(manifest_payload(load_settings({})), indent=2))" \
 *     > ../../apps/api/src/adapters/sidecar/fixtures/vinted-manifest.json
 *
 * What this does NOT prove: that the running container serves this document.
 * It proves that what that source code produces is importable. A deployment
 * running an older image is a live-smoke question, and the app answers it the
 * honest way — the plugin's stored `manifest_seen` is whatever it actually
 * served.
 */
const manifest: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../src/adapters/sidecar/fixtures/vinted-manifest.json", import.meta.url)), "utf8"),
);

describe("the Vinted sidecar's manifest, as this app validates it", () => {
  it("is accepted whole, with the reason shown when it is not", () => {
    const result = validateManifest(manifest);
    // The reason is asserted INTO the failure message rather than checked
    // separately: when this breaks, the useful output is which field the
    // validator refused, not `expected false to be true`.
    expect(result.ok ? null : result.reason).toBeNull();
  });

  it("declares the one role Vinted can honestly claim, and no secrets", () => {
    const result = validateManifest(manifest);
    if (!result.ok) throw new Error(result.reason);
    const [source] = result.manifest.sources;
    // A marketplace of private sellers quotes asking prices: never a sale,
    // never a bid, never a shop's posted price. `reference` here would let a
    // scraped sample become the baseline every other source is judged against
    // — which is why the approval screen leaves that role unchecked.
    expect(source.kindRoles).toEqual({ active_listing: "buy_listing" });
    expect(result.manifest.requiredSecrets).toEqual([]);
    // The app must not invent a region from the site's country.
    expect(source.defaultRegion).toBeNull();
  });

  it("survives the rebuild: nothing the app does not name comes through", () => {
    // validateManifest REBUILDS rather than spreads, so a key the app does not
    // know is dropped on the way in. This asserts the sidecar sends nothing
    // that would be silently lost — a field it thinks it is declaring and the
    // app never sees is a disagreement neither suite would report.
    const result = validateManifest(manifest);
    if (!result.ok) throw new Error(result.reason);
    const sent = (manifest as { sources: Record<string, unknown>[] }).sources[0];
    const kept = result.manifest.sources[0] as unknown as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(kept).sort());
  });
});
