import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Signal } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { games, pricePoints, signalLog } from "../../src/db/schema.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";
import { defaultSignalConfig, withMinGainUsd } from "../../src/settings/signals.js";
import { evaluateSignals, logKey, purgeSignalLog, recordSignals, reliabilityRows } from "../../src/signals/log.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const DAY = 86_400_000;
afterAll(async () => ctx?.pool.end());
const bargain: Signal = {
  type: "UNDERPRICED",
  reasoning: "PAL/cib: £8 vs median £12",
  confidence: "high",
  source: "ebay_uk",
  url: "https://ebay.example/1",
  price: { usd: 10, original: 8, currency: "GBP" },
  edgePct: 33,
};
const maybe: Signal = { ...bargain, confidence: "potential", url: "https://ebay.example/2" };

describe.skipIf(ctx === null)("signal_log recording", () => {
  let gameId: number;
  beforeEach(async () => {
    await ctx!.truncateAll();
    const [g] = await ctx!.db.insert(games).values({ title: "Dr. Mario", platform: "nes" }).returning();
    gameId = g.id;
  });
  const cfg = async () => withMinGainUsd(ctx!.db, defaultSignalConfig());
  const item = (signal: Signal) => ({ key: logKey("w", 1, signal), gameId, watchId: 1, region: "PAL", condition: "any", signal });

  it("inserts one row per distinct signal, potential ones included", async () => {
    const now = new Date("2026-10-18T10:00:00Z");
    expect(await recordSignals(ctx!.db, [item(bargain), item(maybe)], await cfg(), now)).toEqual({ inserted: 2, refreshed: 0 });
    const rows = await ctx!.db.select().from(signalLog);
    expect(rows.map((r) => r.confidence).sort()).toEqual(["high", "potential"]);
    expect(rows[0]).toMatchObject({ gameId, watchId: 1, region: "PAL", condition: "any", type: "UNDERPRICED", source: "ebay_uk", currency: "GBP" });
    expect(Number(rows.find((r) => r.confidence === "high")!.priceOriginal)).toBe(8);
  });

  it("the same key within evalDays refreshes last_seen_at", async () => {
    const t0 = new Date("2026-10-01T10:00:00Z");
    await recordSignals(ctx!.db, [item(bargain)], await cfg(), t0);
    const t1 = new Date(t0.getTime() + 3 * DAY);
    expect(await recordSignals(ctx!.db, [item(bargain)], await cfg(), t1)).toEqual({ inserted: 0, refreshed: 1 });
    const [row] = await ctx!.db.select().from(signalLog);
    expect(row.firstSeenAt.toISOString()).toBe(t0.toISOString());
    expect(row.lastSeenAt.toISOString()).toBe(t1.toISOString());
  });

  it("the same key after evalDays is a new row", async () => {
    const t0 = new Date("2026-10-01T10:00:00Z");
    await recordSignals(ctx!.db, [item(bargain)], await cfg(), t0);
    await recordSignals(ctx!.db, [item(bargain)], await cfg(), new Date(t0.getTime() + 20 * DAY));
    expect(await ctx!.db.select().from(signalLog)).toHaveLength(2);
  });

  it("logKey separates watches from copies and keeps the alert fields", () => {
    expect(logKey("w", 3, bargain)).toBe("w|3|UNDERPRICED|ebay_uk||||https://ebay.example/1");
    expect(logKey("c", 3, bargain)).not.toBe(logKey("w", 3, bargain));
  });
});

describe.skipIf(ctx === null)("signal_log evaluation", () => {
  let gameId: number;
  const now = new Date("2026-10-18T10:00:00Z");
  const old = new Date(now.getTime() - 15 * DAY);
  beforeEach(async () => {
    await ctx!.truncateAll();
    const [g] = await ctx!.db.insert(games).values({ title: "Dr. Mario", platform: "nes" }).returning();
    gameId = g.id;
  });
  const cfg = async () => withMinGainUsd(ctx!.db, defaultSignalConfig());
  /** today's prices for the slice PAL/cib */
  const priceNow = (source: string, kind: string, usd: number, extra: Record<string, unknown> = {}) =>
    ctx!.db.insert(pricePoints).values({
      gameId, source, kind, region: "PAL", condition: "cib", priceUsd: String(usd), priceOriginal: String(usd),
      currencyOriginal: "GBP", fetchedAt: new Date(now.getTime() - 3_600_000), ...extra,
    });
  const logged = (type: string, source: string, usd: number, extra: Record<string, unknown> = {}) =>
    ctx!.db.insert(signalLog).values({
      key: `w|1|${type}|${source}`, gameId, watchId: 1, type, source, region: "PAL", condition: "cib",
      confidence: "high", priceUsd: String(usd), priceOriginal: String(usd), currency: "GBP",
      firstSeenAt: old, lastSeenAt: old, ...extra,
    });
  const outcome = async () => {
    await evaluateSignals(ctx!.db, PLUGIN_SOURCES, await cfg(), now);
    const [row] = await ctx!.db.select().from(signalLog);
    return { outcome: row.outcome, gain: row.gainUsd === null ? null : Number(row.gainUsd), evaluated: row.evaluatedAt !== null };
  };

  it("UNDERPRICED is held when no cheaper price appeared", async () => {
    await logged("UNDERPRICED", "ebay_uk", 10);
    await priceNow("ebay_uk", "active_listing", 12);
    expect(await outcome()).toEqual({ outcome: "held", gain: 2, evaluated: true });
  });

  it("UNDERPRICED is beaten by a price 5% under", async () => {
    await logged("UNDERPRICED", "ebay_uk", 10);
    await priceNow("ebay_uk", "active_listing", 9.5);
    expect(await outcome()).toMatchObject({ outcome: "beaten", gain: -0.5 });
  });

  it("FLIP is held while the bid still covers buy × flipFactor", async () => {
    await logged("FLIP", "cex", 10);
    const f = (await cfg()).flipFactor;
    await priceNow("cex", "voucher", Math.ceil(10 * f * 100) / 100 + 1);
    expect((await outcome()).outcome).toBe("held");
  });

  it("PROFIT is beaten when the bid rose 5%", async () => {
    await logged("PROFIT", "cex", 20);
    await priceNow("cex", "cash", 21);
    expect(await outcome()).toMatchObject({ outcome: "beaten", gain: -1 });
  });

  it("PROFIT is judged against its own kind, not a better-paying one", async () => {
    await logged("PROFIT", "cex", 20, { kind: "cash" });
    await priceNow("cex", "cash", 20);
    await priceNow("cex", "voucher", 27);
    expect(await outcome()).toMatchObject({ outcome: "held", gain: 0 });
  });

  it("PROFIT from a reference is judged on that reference net of the source's fee", async () => {
    const fee = PLUGIN_SOURCES.ebay_uk.sellFeeRate ?? 0;
    await logged("PROFIT", "ebay_uk", Math.round(40 * (1 - fee) * 100) / 100, { kind: "active_median" });
    await priceNow("ebay_uk", "active_median", 40, { sampleSize: 8 });
    expect((await outcome()).outcome).toBe("held");
  });

  it("unknown when the source has not been fetched since the signal", async () => {
    await logged("UNDERPRICED", "ebay_uk", 10);
    await priceNow("ebay_uk", "active_listing", 12, { fetchedAt: new Date(old.getTime() - 3_600_000) });
    expect(await outcome()).toEqual({ outcome: "unknown", gain: null, evaluated: true });
  });

  it("OVERPRICED_STORE holds while the store stays over reference × factor", async () => {
    await logged("OVERPRICED_STORE", "cex", 60);
    await priceNow("cex", "sell", 60);
    await priceNow("ebay_uk", "active_median", 30, { sampleSize: 8 });
    expect((await outcome()).outcome).toBe("held");
  });

  it("unknown when the slice has no price now", async () => {
    await logged("UNDERPRICED", "ebay_uk", 10);
    expect(await outcome()).toEqual({ outcome: "unknown", gain: null, evaluated: true });
  });

  it("leaves a signal younger than evalDays alone", async () => {
    await logged("UNDERPRICED", "ebay_uk", 10, { firstSeenAt: new Date(now.getTime() - 3 * DAY) });
    await priceNow("ebay_uk", "active_listing", 12);
    expect((await outcome()).evaluated).toBe(false);
  });

  it("purge removes rows older than logRetentionDays", async () => {
    await logged("UNDERPRICED", "ebay_uk", 10, { firstSeenAt: new Date(now.getTime() - 400 * DAY) });
    expect(await purgeSignalLog(ctx!.db, await cfg(), now)).toBe(1);
    expect(await ctx!.db.select().from(signalLog)).toHaveLength(0);
  });

  it("reliability rows: no percent under 10 evaluated, aggregate row per type", async () => {
    for (let i = 0; i < 12; i += 1) {
      await ctx!.db.insert(signalLog).values({
        key: `k${i}`, gameId, type: "UNDERPRICED", source: i < 6 ? "ebay_uk" : "ebay_de", region: "PAL", condition: "cib",
        confidence: "high", firstSeenAt: old, lastSeenAt: old, evaluatedAt: now,
        outcome: i % 4 === 0 ? "beaten" : "held", gainUsd: i % 4 === 0 ? "-1" : "2",
      });
    }
    const rows = await reliabilityRows(ctx!.db);
    const total = rows.find((r) => r.type === "UNDERPRICED" && r.source === null)!;
    expect(total).toMatchObject({ logged: 12, evaluated: 12, held: 9, beaten: 3, unknown: 0, heldPct: 75 });
    expect(total.meanGainUsd).toBeCloseTo(1.25);
    expect(rows.find((r) => r.source === "ebay_uk")!.heldPct).toBeNull();
  });

  it("reliability rows: no percent under 10 judged, however many came back unknown", async () => {
    for (let i = 0; i < 12; i += 1) {
      await ctx!.db.insert(signalLog).values({
        key: `u${i}`, gameId, type: "NEW_LOW", source: "ebay_uk", region: "PAL", condition: "cib",
        confidence: "high", firstSeenAt: old, lastSeenAt: old, evaluatedAt: now, outcome: i === 0 ? "beaten" : "unknown",
      });
    }
    const total = (await reliabilityRows(ctx!.db)).find((r) => r.type === "NEW_LOW" && r.source === null)!;
    expect(total).toMatchObject({ evaluated: 12, beaten: 1, unknown: 11, heldPct: null });
  });

  it("reliability rows for a period count only the signals first seen inside it", async () => {
    const seen = (key: string, day: string) =>
      ctx!.db.insert(signalLog).values({
        key, gameId, type: "UNDERPRICED", source: "ebay_uk", region: "PAL", condition: "cib",
        confidence: "high", firstSeenAt: new Date(`${day}T12:00:00Z`), lastSeenAt: new Date(`${day}T12:00:00Z`),
        evaluatedAt: now, outcome: "held",
      });
    await seen("before", "2026-08-31");
    await seen("inside-1", "2026-09-01");
    await seen("inside-2", "2026-09-30");
    await seen("after", "2026-10-01");
    const total = (await reliabilityRows(ctx!.db, { from: "2026-09-01", to: "2026-09-30" })).find((r) => r.source === null)!;
    expect(total.logged).toBe(2);
    expect((await reliabilityRows(ctx!.db)).find((r) => r.source === null)!.logged).toBe(4);
  });
});
