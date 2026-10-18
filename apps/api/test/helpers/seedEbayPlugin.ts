import type { PluginManifest, PriceKind, SourceId } from "@retrowatchdog/shared";
import type { Db } from "../../src/db/index.js";
import { approvePlugin, getPlugin, insertPlugin } from "../../src/plugins/repo.js";
import { pluginManifest } from "./pluginSources.js";

/**
 * An approved eBay plugin row, for a test that needs the DATABASE to know the
 * five eBay markets: `app.deps.sources` is built from the `plugins` table alone,
 * never from a test's injected adapter list. The manifest is the plugin's own
 * committed fixture, approved for both kinds, through the same `insertPlugin` +
 * `approvePlugin` transaction a person's approval runs.
 */
export async function seedEbayPlugin(
  db: Db,
  baseUrl = "http://ebay-plugin:8000",
  opts: { configured?: boolean } = {},
): Promise<void> {
  const configured = opts.configured ?? true;
  // Protocol 2 on purpose: this goes straight into `manifestSeen` without
  // `validateManifest`, so it proves a row stored on an older protocol survives.
  const manifest: PluginManifest = { ...pluginManifest("ebay"), protocol: 2 };
  const row = await insertPlugin(db, {
    baseUrl,
    name: manifest.plugin.name,
    version: manifest.plugin.version,
    manifestSeen: manifest,
    lastHealth: { status: configured ? "ok" : "missing secrets", protocol: 2, configured },
  });
  const reviewed = (await getPlugin(db, row.id))!.manifestSeen!;
  const approvedKinds: Record<SourceId, PriceKind[]> = Object.fromEntries(
    manifest.sources.map((source) => [source.id, ["active_median", "active_listing"]]),
  );
  const result = await approvePlugin(db, row.id, approvedKinds, reviewed);
  if (!result.ok) throw new Error(`seedEbayPlugin: approval failed — ${JSON.stringify(result)}`);
}
