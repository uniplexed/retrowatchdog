import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionResponse, PricesResponse, Signal, WatchlistResponse } from "@retrowatchdog/shared";
import { VERDICT_EMPTY_TITLE } from "@retrowatchdog/shared";
import { GameDetail } from "../src/screens/GameDetail.js";
import { resetMoneyForTests } from "../src/lib/money.js";

const game = { id: 271, title: "Final Fantasy Tactics Advance", platform: "gba" as const, year: 2003, coverUrl: null };
const gbp = (n: number) => ({ usd: n, original: n, currency: "GBP" });

const pricesWith = (signals: Signal[]): PricesResponse => ({
  game,
  sources: [{ source: "ebay_uk", status: "ok", fetchedAt: "2026-10-17T10:00:00Z", points: [] }],
  signals,
  gamePriceMode: null,
});
const emptyCollection: CollectionResponse = {
  items: [], totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0,
  valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};
const emptyWatchlist: WatchlistResponse = { items: [] };

function stubFetch(prices: PricesResponse, insights: unknown = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/insights")) {
        if (insights === null) throw new Error("insights down");
        return new Response(JSON.stringify(insights));
      }
      if (u.includes("/api/fx")) return new Response(JSON.stringify({ base: "USD", to: "USD", rate: 1, fetchedAt: new Date().toISOString(), mode: "auto" }));
      if (u.includes("/prices")) return new Response(JSON.stringify(prices));
      if (u.includes("/history")) return new Response(JSON.stringify({ region: "PAL", condition: "cib", days: 30, from: "", to: "", series: [] }));
      if (u.includes("/collection")) return new Response(JSON.stringify(emptyCollection));
      if (u.includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  window.localStorage.clear();
});

describe("GameDetail verdict", () => {
  it("leads with the best high signal and links its listing", async () => {
    stubFetch(
      pricesWith([
        { type: "UNDERPRICED", reasoning: "PAL/cib: complete copy at £31.90 vs £99.99", source: "ebay_uk", url: "https://ebay.example/ffta", price: gbp(31.9), confidence: "high", edgePct: 68 },
        { type: "UNDERPRICED", reasoning: "unknown/unknown: loose cart at £15", source: "vinted_uk", price: gbp(15), confidence: "potential", edgePct: 57 },
      ]),
    );
    render(<GameDetail game={game} onBack={() => {}} />);
    expect(await screen.findByRole("heading", { name: /Buy on eBay UK for £31\.90/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View listing →" })).toHaveAttribute("href", "https://ebay.example/ffta");
    expect(screen.getByText("1 possible bark (signal) with incomplete data")).toBeInTheDocument();
  });

  it("folds every potential signal and shows the empty verdict", async () => {
    stubFetch(
      pricesWith([
        { type: "UNDERPRICED", reasoning: "unknown/unknown: loose cart at £15 vs £35.54", source: "vinted_uk", price: gbp(15), confidence: "potential", caveats: ["region not declared"] },
        { type: "FLIP", reasoning: "PAL/unknown: CeX pays cash £51 vs eBay listing £20", buySource: "ebay_uk", sellSource: "cex", price: gbp(20), confidence: "potential" },
      ]),
    );
    render(<GameDetail game={game} onBack={() => {}} />);
    expect(await screen.findByRole("heading", { name: VERDICT_EMPTY_TITLE })).toBeInTheDocument();
    const fold = screen.getByText("2 possible barks (signals) with incomplete data");
    const details = fold.closest("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(fold);
    expect(details.open).toBe(true);
    expect(details).toHaveTextContent("loose cart at £15");
  });

  it("shows the missing-data note only when there is no other signal", async () => {
    stubFetch(pricesWith([{ type: "INSUFFICIENT_DATA", reasoning: "PAL: not enough reference listings" }]));
    render(<GameDetail game={game} onBack={() => {}} />);
    expect(await screen.findByText(/not enough reference listings/)).toBeInTheDocument();
    expect(screen.queryByText(/possible signal/)).toBeNull();
  });

  describe("the game's recommendation", () => {
    const rec = (gameId: number, title: string, confidence: "high" | "potential" = "high") => ({
      action: "buy_now", subject: { kind: "watch", watchId: 1, game: { ...game, id: gameId } }, title, reason: "the lowest in 90 days",
      gainUsd: 5, confidence, since: "2026-10-18",
    });
    const insightsOf = (...recommendations: unknown[]) => ({ recommendations, reliability: [], measuredSince: null, computedAt: "x" });

    it("shows this game's recommendation under the verdict", async () => {
      stubFetch(pricesWith([]), insightsOf(rec(game.id, "Buy Final Fantasy Tactics Advance on eBay UK for £8")));
      render(<GameDetail game={game} onBack={() => {}} />);
      const line = await screen.findByText("Buy Final Fantasy Tactics Advance on eBay UK for £8");
      expect(line.closest(".game-rec")).toHaveTextContent("the lowest in 90 days");
    });

    it("a potential one says Possibly", async () => {
      stubFetch(pricesWith([]), insightsOf(rec(game.id, "Buy it for £8", "potential")));
      render(<GameDetail game={game} onBack={() => {}} />);
      expect(await screen.findByText("Possibly: Buy it for £8")).toBeInTheDocument();
    });

    it("another game's recommendation is not shown", async () => {
      stubFetch(pricesWith([]), insightsOf(rec(999, "Buy another game")));
      render(<GameDetail game={game} onBack={() => {}} />);
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(screen.queryByText("Buy another game")).toBeNull();
    });

    it("a high one wins over a potential one listed first", async () => {
      const sell = { ...rec(game.id, "Sell it for £30", "potential"), action: "sell_now" };
      stubFetch(pricesWith([]), insightsOf(sell, rec(game.id, "Buy it for £8")));
      render(<GameDetail game={game} onBack={() => {}} />);
      expect(await screen.findByText("Buy it for £8")).toBeInTheDocument();
      expect(screen.queryByText("Possibly: Sell it for £30")).toBeNull();
    });

    it("a late answer for the previous game is not shown on the next one", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const other = { ...game, id: 300, title: "Golden Sun" };
      let insightCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: RequestInfo | URL) => {
          const u = String(url);
          if (u.includes("/api/insights")) {
            // the first game's answer arrives after the second game's
            if (++insightCalls === 1) await gate;
            return new Response(JSON.stringify(insightsOf(rec(game.id, "Buy FFTA for £8"))));
          }
          if (u.includes("/prices")) return new Response(JSON.stringify({ ...pricesWith([]), game: other }));
          if (u.includes("/collection")) return new Response(JSON.stringify(emptyCollection));
          if (u.includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
          if (u.includes("/api/fx")) return new Response(JSON.stringify({ base: "USD", to: "USD", rate: 1, fetchedAt: new Date().toISOString(), mode: "auto" }));
          return new Response(JSON.stringify({ region: "PAL", condition: "cib", days: 30, from: "", to: "", series: [] }));
        }),
      );
      const { rerender } = render(<GameDetail game={game} onBack={() => {}} />);
      rerender(<GameDetail game={other} onBack={() => {}} />);
      await new Promise((r) => setTimeout(r, 30));
      release();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText("Buy FFTA for £8")).toBeNull();
    });

    it("an insights failure shows nothing extra", async () => {
      stubFetch(pricesWith([]));
      render(<GameDetail game={game} onBack={() => {}} />);
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(document.querySelector(".game-rec")).toBeNull();
    });
  });
});
