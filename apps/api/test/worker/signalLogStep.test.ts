import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CollectionResponse, OwnedCopyDto, Signal, WatchlistResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { games, signalLog } from "../../src/db/schema.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";
import { defaultSignalConfig, withMinGainUsd } from "../../src/settings/signals.js";
import { runSignalLogStep } from "../../src/worker/signalLog.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}
afterAll(async () => ctx?.pool.end());

const DAY = 86_400_000;
const sig = (over: Partial<Signal> & Pick<Signal, "type">): Signal => ({ reasoning: "r", confidence: "high", source: "ebay_uk", price: { usd: 10, original: 8, currency: "GBP" }, ...over });

describe.skipIf(ctx === null)("the worker's signal log step", () => {
  let gameId: number;
  beforeEach(async () => {
    await ctx!.truncateAll();
    const [g] = await ctx!.db.insert(games).values({ title: "Dr. Mario", platform: "nes" }).returning();
    gameId = g.id;
  });

  it("records watchlist and collection signals, then evaluates and purges", async () => {
    const game = { id: gameId, title: "Dr. Mario", platform: "nes" as const, year: 1990, coverUrl: null };
    const watchlist = {
      items: [
        {
          id: 4, game, region: "PAL", condition: null, signals: [sig({ type: "UNDERPRICED" }), sig({ type: "INSUFFICIENT_DATA", price: undefined })],
        },
      ],
    } as unknown as WatchlistResponse;
    const collection = {
      items: [
        { id: 9, game, region: "PAL", condition: "cib", status: "owned", signals: [sig({ type: "PROFIT", source: undefined, sellSource: "cex" })] } as unknown as OwnedCopyDto,
        { id: 10, game, region: "PAL", condition: "cib", status: "sold", signals: [sig({ type: "PROFIT", source: undefined, sellSource: "cex" })] } as unknown as OwnedCopyDto,
      ],
    } as unknown as CollectionResponse;
    const now = new Date("2026-10-18T10:00:00Z");
    // a year-and-a-half-old row the step must purge
    await ctx!.db.insert(signalLog).values({
      key: "w|1|OLD", gameId, type: "UNDERPRICED", region: "PAL", condition: "any", confidence: "high",
      firstSeenAt: new Date(now.getTime() - 500 * DAY), lastSeenAt: new Date(now.getTime() - 500 * DAY),
    });
    const result = await runSignalLogStep(
      ctx!.db,
      {
        fetchWatchlist: async () => watchlist,
        fetchCollection: async () => collection,
        registry: PLUGIN_SOURCES,
        config: await withMinGainUsd(ctx!.db, defaultSignalConfig()),
      },
      now,
    );
    expect(result).toEqual({ recorded: 2, evaluated: 1, purged: 1 });
    const rows = await ctx!.db.select().from(signalLog);
    expect(rows.map((r) => [r.key.split("|")[0], r.type, r.condition]).sort()).toEqual([
      ["c", "PROFIT", "cib"],
      ["w", "UNDERPRICED", "any"],
    ]);
  });
});
