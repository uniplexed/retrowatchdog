import { readFileSync } from "node:fs";
import type { PluginManifest, SourceId, SourceInfo } from "@retrowatchdog/shared";

/**
 * The sources the RetroWatchdog plugins declare, recorded from each plugin's
 * `GET /manifest` (src/adapters/sidecar/fixtures/*-manifest.json) — for unit tests that tag a fixture `source: "cex"`
 * or `"ebay_uk"` and must pass a `sources` Record to resolve its role. Never
 * hand-typed: the conformance suite runs the app's real `validateManifest` over
 * the same files, so this cannot drift from what the plugins declare.
 *
 * A test that needs the DATABASE to know a source needs an approved plugin row
 * instead: `seedEbayPlugin` and `seedCexPlugin` in this directory.
 */
export function pluginManifest(pkg: "cex" | "ebay"): PluginManifest {
  return JSON.parse(
    readFileSync(new URL(`../../src/adapters/sidecar/fixtures/${pkg}-manifest.json`, import.meta.url), "utf8"),
  ) as PluginManifest;
}

const sourcesOf = (pkg: "cex" | "ebay"): Record<SourceId, SourceInfo> =>
  Object.fromEntries(pluginManifest(pkg).sources.map(({ id, ...info }) => [id, info as SourceInfo]));

export const CEX_PLUGIN_SOURCES = sourcesOf("cex");
export const PLUGIN_SOURCES: Record<SourceId, SourceInfo> = { ...sourcesOf("ebay"), ...CEX_PLUGIN_SOURCES };
