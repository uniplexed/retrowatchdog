/**
 * Demotes confirmed CeX mappings with a numeral mismatch to needs_review and
 * invalidates the stale price_points they left (see
 * src/matching/reviewNumeralMismatches.ts). Idempotent.
 *
 * Run (dry run first):
 *   pnpm --filter @retrowatchdog/api exec tsx scripts/review-numeral-mismatched-mappings.ts --dry-run
 *   pnpm --filter @retrowatchdog/api exec tsx scripts/review-numeral-mismatched-mappings.ts
 */
import { createDb } from "../src/db/index.js";
import { config } from "../src/config.js";
import { buildSourceRuntime } from "../src/sources/registry.js";
import {
  demoteNumeralMismatchedMappings,
  type NumeralMismatchedMapping,
  type StaleCacheInvalidation,
} from "../src/matching/reviewNumeralMismatches.js";

const SOURCE = "cex" as const;
const dryRun = process.argv.includes("--dry-run");
const { db, pool } = createDb(config.DATABASE_URL);

function printGroupedByGame(rows: NumeralMismatchedMapping[]): void {
  const byGame = new Map<number, NumeralMismatchedMapping[]>();
  for (const row of rows) {
    const group = byGame.get(row.gameId) ?? [];
    group.push(row);
    byGame.set(row.gameId, group);
  }
  for (const [gameId, group] of byGame) {
    const { gameTitle, platform } = group[0];
    console.log(`  "${gameTitle}" [${platform}] game id=${gameId} (${group.length})`);
    for (const r of group) {
      console.log(`    - ${r.sourceProductId} "${r.sourceTitle}" score=${r.matchScore.toFixed(2)}`);
    }
  }
}

function printInvalidation(inv: StaleCacheInvalidation, verb: string): void {
  if (!inv.supported) {
    console.log(`  (listing URLs are not derivable for ${SOURCE}: no cache invalidation)`);
    return;
  }
  console.log(
    `  ${inv.stalePricePoints} stale price_points rows across ${inv.games.length} games ${verb} deleted, ` +
      `and each game's ${SOURCE} fetch marker ${verb} expired (next view refetches):`,
  );
  for (const g of inv.games) {
    console.log(`    "${g.gameTitle}" [${g.platform}] game id=${g.gameId}: ${g.pricePoints} rows`);
  }
}

async function main(): Promise<void> {
  // the runtime registry is the only one that knows plugin sources
  const { registry } = await buildSourceRuntime(db);
  const family = registry.get(SOURCE)?.family;
  if (family === undefined) {
    console.log(`warning: ${SOURCE} is not a source this deployment serves; no cache invalidation is possible`);
  }
  const result = await demoteNumeralMismatchedMappings(db, { source: SOURCE, dryRun });
  if (dryRun) {
    console.log(
      `[dry-run] ${result.mismatched.length} of ${result.scanned} confirmed ${SOURCE} mappings ` +
        "would be demoted to needs_review (numeral mismatch against the game title and every alternative name):",
    );
    printGroupedByGame(result.mismatched);
    console.log("[dry-run] cache invalidation:");
    printInvalidation(result.invalidation, "would be");
    console.log("nothing written.");
    return;
  }
  console.log(`demoted to needs_review, grouped by game (${result.mismatched.length}):`);
  printGroupedByGame(result.mismatched);
  console.log("cache invalidation:");
  printInvalidation(result.invalidation, "were");
  console.log("=== summary ===");
  console.log(`scanned (confirmed ${SOURCE}): ${result.scanned}`);
  console.log(`demoted to needs_review:       ${result.demoted}`);
  console.log(`kept confirmed:                ${result.scanned - result.demoted}`);
  console.log(`price_points deleted:          ${result.invalidation.pricePointsDeleted}`);
  console.log(`fetch markers expired:         ${result.invalidation.fetchMarkersExpired}`);
}

await main();
await pool.end();
