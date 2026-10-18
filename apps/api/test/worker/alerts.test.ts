import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { InsightsResponse, Recommendation, Signal, WatchlistItemDto, WatchlistResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { alertKey, recommendationKey, runRecommendationAlerts, runWatchlistAlerts, type Alert } from "../../src/worker/alerts.js";
import { defaultSignalConfig } from "../../src/settings/signals.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}
afterAll(async () => ctx?.pool.end());

/**
 * The alert job's one promise: tell the user about a signal ONCE, when it
 * appears, and again only if it goes away and comes back. Everything here runs
 * against the real `alerts_sent` table, because the dedupe IS the table.
 */

const underpriced = (source: string, reasoning = "£12 on eBay UK vs £30 median"): Signal => ({
  type: "UNDERPRICED",
  reasoning,
  source,
  url: `https://example.test/${source}`,
  confidence: "high",
});

const config = defaultSignalConfig();

const item = (id: number, title: string, signals: Signal[]): WatchlistItemDto =>
  ({ id, game: { id, title }, signals }) as unknown as WatchlistItemDto;

const watchlist = (...items: WatchlistItemDto[]): (() => Promise<WatchlistResponse>) =>
  async () => ({ items });

function recorder() {
  const sent: Alert[] = [];
  return { sent, send: async (alert: Alert) => void sent.push(alert) };
}

describe.skipIf(ctx === null)("runWatchlistAlerts", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    await ctx!.db.execute(sql`DELETE FROM alerts_sent`);
  });

  it("announces a new actionable signal once, with the game and the reasoning", async () => {
    const out = recorder();
    const list = watchlist(item(1, "Super Metroid", [underpriced("ebay_uk")]));
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: list, send: out.send, config });
    expect(out.sent).toEqual([
      {
        title: "Super Metroid: underpriced",
        message: "£12 on eBay UK vs £30 median",
        url: "https://example.test/ebay_uk",
      },
    ]);

    // the next refresh finds the same standing signal: silence
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: list, send: out.send, config });
    expect(out.sent).toHaveLength(1);
  });

  it("does not re-announce a standing signal whose price moved by a penny", async () => {
    // The price is not part of the key, on purpose: re-sending the same
    // opportunity every four hours teaches the user to ignore the channel.
    const out = recorder();
    await runWatchlistAlerts(ctx!.db, {
      fetchWatchlist: watchlist(item(1, "Super Metroid", [underpriced("ebay_uk", "£12.00 ...")])),
      send: out.send,
      config,
    });
    await runWatchlistAlerts(ctx!.db, {
      fetchWatchlist: watchlist(item(1, "Super Metroid", [underpriced("ebay_uk", "£11.99 ...")])),
      send: out.send,
      config,
    });
    expect(out.sent).toHaveLength(1);
  });

  it("announces a signal again once it has gone away and come back", async () => {
    const out = recorder();
    const present = watchlist(item(1, "Super Metroid", [underpriced("ebay_uk")]));
    const absent = watchlist(item(1, "Super Metroid", []));
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: present, send: out.send, config });
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: absent, send: out.send, config });
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: present, send: out.send, config });
    expect(out.sent).toHaveLength(2);
  });

  it("never interrupts anyone for advice or for missing data", async () => {
    const out = recorder();
    await runWatchlistAlerts(ctx!.db, {
      fetchWatchlist: watchlist(
        item(1, "Super Metroid", [
          { type: "OVERPRICED_STORE", reasoning: "CeX asks 40% over the median", source: "cex" },
          { type: "INSUFFICIENT_DATA", reasoning: "no baseline yet" },
        ]),
      ),
      send: out.send,
      config,
    });
    expect(out.sent).toEqual([]);
  });

  it("caps a burst and summarises the rest, so the first run is not thirty buzzes", async () => {
    // The first run after a topic is set finds every standing signal new.
    const out = recorder();
    const many = Array.from({ length: 8 }, (_, i) => item(i + 1, `Game ${i + 1}`, [underpriced("ebay_uk")]));
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(...many), send: out.send, config });
    expect(out.sent).toHaveLength(6);
    expect(out.sent[5]!.message).toBe("3 more new barks (signals) on your watchlist.");
    // ...and the summarised ones count as told: nothing more next time
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(...many), send: out.send, config });
    expect(out.sent).toHaveLength(6);
  });

  it("does not record an alert whose send failed, so the next run tries again", async () => {
    // Send first, record second: a failed send must not be marked as told.
    const list = watchlist(item(1, "Super Metroid", [underpriced("ebay_uk")]));
    await expect(
      runWatchlistAlerts(ctx!.db, {
        fetchWatchlist: list,
        send: async () => {
          throw new Error("ntfy answered HTTP 503");
        },
        config,
      }),
    ).rejects.toThrow("503");
    const out = recorder();
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: list, send: out.send, config });
    expect(out.sent).toHaveLength(1);
  });

  it("announces a NEW cheaper listing while an older one from the same source still stands", async () => {
    // The miss this closes: keyed without the listing, every cheap listing
    // from one source shared one key, so the second never alerted.
    const out = recorder();
    const first = { ...underpriced("ebay_uk"), url: "https://ebay.test/itm/1" };
    const second = { ...underpriced("ebay_uk", "£9 on eBay UK vs £30 median"), url: "https://ebay.test/itm/2" };
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(item(1, "Doom", [first])), send: out.send, config });
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(item(1, "Doom", [first, second])), send: out.send, config });
    expect(out.sent.map((a) => a.url)).toEqual(["https://ebay.test/itm/1", "https://ebay.test/itm/2"]);
  });

  it("does not send a potential signal by default", async () => {
    const out = recorder();
    const weak = { ...underpriced("vinted_uk"), confidence: "potential" as const };
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(item(1, "Doom", [weak])), send: out.send, config });
    expect(out.sent).toEqual([]);
  });

  it("sends it when alertLowConfidence is on", async () => {
    const out = recorder();
    const weak = { ...underpriced("vinted_uk"), confidence: "potential" as const };
    await runWatchlistAlerts(ctx!.db, {
      fetchWatchlist: watchlist(item(1, "Doom", [weak])),
      send: out.send,
      config: { ...config, alertLowConfidence: true },
    });
    expect(out.sent).toHaveLength(1);
  });

  it.each(["TARGET_HIT", "BACK_IN_STOCK", "PRICE_DROP", "NEW_LOW"] as const)("%s is actionable", async (type) => {
    const out = recorder();
    const signal: Signal = { type, reasoning: `${type} reasoning`, source: "cex", confidence: "high" };
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(item(1, "Doom", [signal])), send: out.send, config });
    expect(out.sent.map((a) => a.message)).toEqual([`${type} reasoning`]);
  });

  it("keys two different signals on one watch apart", () => {
    const a = alertKey(1, { type: "FLIP", reasoning: "", buySource: "ebay_uk", sellSource: "cex" });
    const b = alertKey(1, { type: "FLIP", reasoning: "", buySource: "ebay_de", sellSource: "cex" });
    const c = alertKey(1, { type: "PROFIT", reasoning: "", sellSource: "cex", sellKind: "voucher" });
    const d = alertKey(1, { type: "PROFIT", reasoning: "", sellSource: "cex", sellKind: "cash" });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe.skipIf(ctx === null)("runRecommendationAlerts", () => {
  beforeEach(async () => {
    await ctx!.db.execute(sql`TRUNCATE alerts_sent`);
  });

  const game = { id: 5, title: "Shenmue", platform: "dreamcast", year: 2000, coverUrl: null } as const;
  const rec = (action: Recommendation["action"], over: Partial<Recommendation> = {}): Recommendation => ({
    action,
    subject: { kind: "copy", copyId: 9, game },
    title: "Sell Shenmue to CeX UK for £38",
    reason: "CeX UK pays £38, the most in 90 days; you paid £18",
    gainUsd: 25,
    confidence: "high",
    since: "2026-10-18",
    ...over,
  });
  const insights = (...recommendations: Recommendation[]) => async (): Promise<InsightsResponse> => ({
    recommendations,
    reliability: [],
    measuredSince: null,
    computedAt: "2026-10-18T00:00:00Z",
  });

  it("sends each new sell or buy recommendation once", async () => {
    const out = recorder();
    const list = insights(rec("sell_now"), rec("buy_now", { subject: { kind: "watch", watchId: 2, game }, title: "Buy Shenmue for £8" }));
    expect(await runRecommendationAlerts(ctx!.db, { fetchInsights: list, send: out.send })).toEqual({ current: 2, sent: 2 });
    expect(out.sent[0]).toEqual({ title: "Sell Shenmue to CeX UK for £38", message: "CeX UK pays £38, the most in 90 days; you paid £18" });
    await runRecommendationAlerts(ctx!.db, { fetchInsights: list, send: out.send });
    expect(out.sent).toHaveLength(2);
  });

  it("potential and clean-up actions are not sent", async () => {
    const out = recorder();
    await runRecommendationAlerts(ctx!.db, {
      fetchInsights: insights(rec("sell_now", { confidence: "potential" }), rec("unwatch"), rec("raise_target")),
      send: out.send,
    });
    expect(out.sent).toEqual([]);
  });

  it("a standing recommendation whose since slides with the window is not sent again", async () => {
    const out = recorder();
    await runRecommendationAlerts(ctx!.db, { fetchInsights: insights(rec("sell_now")), send: out.send });
    await runRecommendationAlerts(ctx!.db, { fetchInsights: insights(rec("sell_now", { since: "2026-10-19" })), send: out.send });
    expect(out.sent).toHaveLength(1);
    expect(recommendationKey(rec("sell_now"))).toBe("rec|sell_now|c9");
  });

  it("a recommendation that goes away and comes back alerts again", async () => {
    const out = recorder();
    await runRecommendationAlerts(ctx!.db, { fetchInsights: insights(rec("sell_now")), send: out.send });
    await runRecommendationAlerts(ctx!.db, { fetchInsights: insights(), send: out.send });
    await runRecommendationAlerts(ctx!.db, { fetchInsights: insights(rec("sell_now")), send: out.send });
    expect(out.sent).toHaveLength(2);
  });

  it("the watchlist run keeps recommendation keys", async () => {
    const out = recorder();
    await runRecommendationAlerts(ctx!.db, { fetchInsights: insights(rec("sell_now")), send: out.send });
    // a watchlist run with nothing actionable used to clear the whole table
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(), send: out.send, config });
    await runWatchlistAlerts(ctx!.db, { fetchWatchlist: watchlist(item(1, "Mario", [underpriced("ebay_uk")])), send: out.send, config });
    await runRecommendationAlerts(ctx!.db, { fetchInsights: insights(rec("sell_now")), send: out.send });
    expect(out.sent.filter((a) => a.title.startsWith("Sell"))).toHaveLength(1);
  });
});
