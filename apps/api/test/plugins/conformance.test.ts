import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest, type PluginManifest } from "@retrowatchdog/shared";

/**
 * The DECLARATION layer of the conformance suite, applied to every plugin this
 * repository ships rather than to one at a time (spec §7).
 *
 * The rule it makes executable: a plugin is conforming when it passes a suite
 * THE APP owns, so the contract is checked by the side that has to live with a
 * broken answer. Each plugin's own package proves it builds the manifest it
 * means to; this proves the app accepts it, under the app's real validator, and
 * that no two of them claim the same source.
 *
 * It DISCOVERS the fixtures rather than listing them, so a plugin added to this
 * repository is covered the day it commits one — and `COVERED` below is checked
 * against what was found, so a plugin that ships NO fixture is a visible
 * failure here rather than a silent gap.
 *
 * What this layer is not: the ROWS layer (a captured answer from each route
 * parsed through the app's own parsers, with its bounds applied) lives per
 * plugin, in `test/adapters/sidecar/{ebay,cex,vinted}PluginContract.test.ts`,
 * because each needs a real answer from the route it describes. All three
 * exist since 2026-09-19.
 */

const FIXTURES = fileURLToPath(new URL("../../src/adapters/sidecar/fixtures/", import.meta.url));

/**
 * Every plugin package that must publish a manifest fixture — all three.
 *
 * `vinted-sidecar-plugin`'s is RECORDED from the running service's own `GET /manifest`
 * (2026-09-19) rather than generated, because its manifest is built in Python
 * and nothing here can run that; its own suite asserts the same document on its
 * side (`tests/test_manifest.py`). Recorded is what makes it honest to include:
 * it is what the app actually receives, not a transcription of what somebody
 * believed it sends.
 */
const COVERED = ["cex", "ebay", "vinted", "wallapop"];

interface Fixture {
  pkg: string;
  manifest: unknown;
}

function fixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith("-manifest.json"))
    .map((name) => ({ pkg: name.slice(0, -"-manifest.json".length), path: `${FIXTURES}${name}` }))
    .map(({ pkg, path }) => ({ pkg, manifest: JSON.parse(readFileSync(path, "utf8")) as unknown }));
}

const found = fixtures();

describe("every plugin this repository ships declares a conforming manifest", () => {
  it("covers exactly the packages it is meant to", () => {
    // A new plugin with no fixture fails HERE, naming itself, instead of
    // quietly never being checked.
    expect(found.map((f) => f.pkg).sort()).toEqual([...COVERED].sort());
  });

  it.each(found.map((f) => [f.pkg, f.manifest] as const))(
    "%s validates under the app's own validator",
    (pkg, manifest) => {
      const result = validateManifest(manifest);
      expect(result.ok, result.ok ? "" : `${pkg}: ${result.reason}`).toBe(true);
    },
  );

  it.each(found.map((f) => [f.pkg, f.manifest] as const))(
    "%s declares a schedule on every sync source and none on a live one",
    (_pkg, manifest) => {
      const result = validateManifest(manifest);
      if (!result.ok) throw new Error(result.reason);
      for (const source of result.manifest.sources) {
        // A sync source's catalogue is swept on a cadence the app schedules
        // from; a live source has no catalogue, and a schedule there would be a
        // cadence nothing reads while telling its author the app agreed to it.
        if (source.kind === "sync") expect(source.schedule, source.id).toBeDefined();
        else expect(source.schedule, source.id).toBeUndefined();
      }
    },
  );

  it.each(found.map((f) => [f.pkg, f.manifest] as const))(
    "%s labels every kind it claims a role for",
    (_pkg, manifest) => {
      const result = validateManifest(manifest);
      if (!result.ok) throw new Error(result.reason);
      for (const source of result.manifest.sources) {
        // The app's own fallback wording is derived from the price KIND — "sells
        // for", "pays cash" — which is this app's vocabulary for a market it
        // does not run. A shop that calls its trade-in something else says so.
        for (const kind of Object.keys(source.kindRoles)) {
          expect(source.kindLabels?.[kind as keyof typeof source.kindLabels], `${source.id}.${kind}`).toBeTruthy();
        }
      }
    },
  );

  it("no two plugins claim the same source id", () => {
    // Import and approve both refuse a collision at runtime, and the read path
    // drops the later declaration — but a collision between two plugins THIS
    // REPOSITORY ships would mean one of them simply never answers on a
    // deployment that has both, which no runtime refusal makes obvious.
    const owners = new Map<string, string>();
    for (const { pkg, manifest } of found) {
      const result = validateManifest(manifest);
      if (!result.ok) throw new Error(`${pkg}: ${result.reason}`);
      for (const source of result.manifest.sources) {
        expect(owners.get(source.id), `${source.id} is declared by two plugins`).toBeUndefined();
        owners.set(source.id, pkg);
      }
    }
    // and the ids this deployment actually stores data under are among them
    for (const id of ["cex", "cex_es", "cex_ie", "ebay_uk"]) expect(owners.has(id)).toBe(true);
  });

  it("asks the app for no secret it does not name", () => {
    for (const { pkg, manifest } of found) {
      const result = validateManifest(manifest);
      if (!result.ok) throw new Error(`${pkg}: ${result.reason}`);
      const secrets = (result.manifest as PluginManifest).requiredSecrets ?? [];
      // Names of environment variables, never values, and the app never asks a
      // plugin for one: this only checks the author did not paste a credential
      // into the list of names.
      for (const name of secrets) expect(name, `${pkg}: ${name}`).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
    }
  });
});
