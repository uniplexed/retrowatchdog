import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionHistoryResponse, CollectionResponse, InsightsResponse, OwnedCopyDto, PluginDto, Recommendation, WatchlistResponse } from "@retrowatchdog/shared";
import { DashboardScreen } from "../src/screens/DashboardScreen.js";
import { resetSourcesForTests } from "../src/lib/sources.js";

const game = { id: 7, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998, coverUrl: null } as const;

const collection = {
  items: [{ id: 1, game: { ...game, id: 8, title: "Shenmue" }, region: "PAL", condition: "cib", status: "owned", signals: [], matchBasis: "candidate" } as unknown as OwnedCopyDto],
  valuationBasis: "market",
  valuationMarkets: { country: "GB", includeForeign: false },
  totalEstimatedUsd: 517.69,
  totalPaidUsd: 300,
  totalRealizedUsd: 12.5,
  totalReturnedUsd: 0,
} as CollectionResponse;

const history = (points: Array<[string, number]>): CollectionHistoryResponse => ({
  valuationBasis: "market",
  valuationMarkets: { country: "GB", includeForeign: false },
  days: 31,
  from: points[0]?.[0] ?? "2026-10-17",
  to: "2026-10-17",
  points: points.map(([day, estimatedUsd]) => ({ day, estimatedUsd, paidUsd: 300 })),
});

const watchlist: WatchlistResponse = {
  items: [
    {
      id: 3, game, region: "PAL", condition: null, targetPriceOriginal: null, targetCurrency: null, targetPriceUsd: null,
      storeOffer: null, storeBids: [], storeSource: null, priceDisplayAt: null, signalsAboveTarget: 0,
      signals: [
        { type: "UNDERPRICED", confidence: "high", reasoning: "cheap", edgePct: 30, source: "ebay_uk", url: "https://ebay.example/1", price: { usd: 40, original: 31.9, currency: "GBP" } },
      ],
    },
    {
      id: 4, game: { ...game, id: 9, title: "Radiant Silvergun" }, region: null, condition: null, targetPriceOriginal: null, targetCurrency: null, targetPriceUsd: null,
      storeOffer: null, storeBids: [], storeSource: null, priceDisplayAt: null, signalsAboveTarget: 0, signals: [],
    },
  ],
};

const rec = (action: Recommendation["action"], title: string, over: Partial<Recommendation> = {}): Recommendation => ({
  action, subject: { kind: "watch", watchId: 3, game }, title, reason: `${title} because`, gainUsd: 12, confidence: "high", since: "2026-10-18", ...over,
});
let insights: InsightsResponse = { recommendations: [], reliability: [], measuredSince: null, computedAt: "2026-10-18T00:00:00Z" };

const plugins = [{ id: 1, status: "pending", proposed: null }] as unknown as PluginDto[];

function stub(fail: string | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (fail !== null && u.includes(fail)) return new Response("{}", { status: 500 });
      if (u.startsWith("/api/collection/history")) return new Response(JSON.stringify(history([["2026-09-10", 480], ["2026-10-17", 517.69]])));
      if (u.startsWith("/api/collection")) return new Response(JSON.stringify(collection));
      if (u.startsWith("/api/watchlist")) return new Response(JSON.stringify(watchlist));
      if (u.startsWith("/api/insights")) return new Response(JSON.stringify(insights));
      if (u.startsWith("/api/plugins")) return new Response(JSON.stringify({ plugins, adapterTimeoutMs: 8000 }));
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
}

beforeEach(() => {
  resetSourcesForTests();
  insights = { ...insights, recommendations: [] };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderDash = () => {
  const onOpenGame = vi.fn();
  const onNavigate = vi.fn();
  render(<DashboardScreen onOpenGame={onOpenGame} onNavigate={onNavigate} />);
  return { onOpenGame, onNavigate };
};

describe("DashboardScreen", () => {
  it("shows the four KPIs with the delta over the chosen period (90 days by default)", async () => {
    stub();
    const { onNavigate } = renderDash();
    const value = await screen.findByRole("button", { name: /^Collection value/ });
    expect(value).toHaveTextContent("$517.69");
    expect(value).toHaveTextContent("+$37.69 in 90 days");
    expect(screen.getByRole("button", { name: /^Paid/ })).toHaveTextContent("$300.00");
    expect(screen.getByRole("button", { name: /^Realized/ })).toHaveTextContent("$12.50");
    const signals = screen.getByRole("button", { name: /^Barks \(Signals\)/ });
    expect(signals).toHaveTextContent("1");
    expect(signals).toHaveTextContent("of 2 watches");
    await userEvent.click(signals);
    expect(onNavigate).toHaveBeenCalledWith("watchlist");
  });

  it("a flat period says no change, not +$0.00", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith("/api/collection/history")) return new Response(JSON.stringify(history([["2026-09-10", 517.69], ["2026-10-17", 517.69]])));
        if (u.startsWith("/api/collection")) return new Response(JSON.stringify(collection));
        if (u.startsWith("/api/watchlist")) return new Response(JSON.stringify(watchlist));
        return new Response(JSON.stringify({ plugins: [], adapterTimeoutMs: 8000 }));
      }),
    );
    renderDash();
    const value = await screen.findByRole("button", { name: /^Collection value/ });
    expect(await within(value).findByText("No change in 90 days")).toBeInTheDocument();
    expect(value).not.toHaveTextContent("+$0.00");
  });

  it("good prices sit inside the one Recommended actions panel and open a game", async () => {
    insights = { ...insights, recommendations: [] };
    stub();
    const { onOpenGame, onNavigate } = renderDash();
    const panel = (await screen.findByRole("heading", { name: "Recommended actions" })).closest("section") as HTMLElement;
    const row = await within(panel).findByRole("button", { name: /Panzer Dragoon Saga/ });
    expect(row).toHaveTextContent("Watch · PAL · any");
    expect(row).toHaveTextContent("£31.90");
    expect(screen.queryByRole("heading", { name: "Good prices now" })).toBeNull();
    await userEvent.click(row);
    expect(onOpenGame).toHaveBeenCalledWith(game);
    await userEvent.click(within(panel).getByRole("button", { name: "All →" }));
    expect(onNavigate).toHaveBeenCalledWith("insights");
  });

  it("a watch that already has a recommendation is not listed again as a good price", async () => {
    insights = { ...insights, recommendations: [rec("buy_now", "Buy Panzer Dragoon Saga on eBay UK for £31.90")] };
    stub();
    renderDash();
    const panel = (await screen.findByRole("heading", { name: "Recommended actions" })).closest("section") as HTMLElement;
    await within(panel).findByText("Buy Panzer Dragoon Saga on eBay UK for £31.90");
    expect(within(panel).queryByText("Watch · PAL · any")).toBeNull();
  });

  it("needs-you lines navigate", async () => {
    stub();
    const { onNavigate } = renderDash();
    await userEvent.click(await screen.findByRole("button", { name: "1 plugin needs review" }));
    expect(onNavigate).toHaveBeenCalledWith("settings");
    // and Settings opens on the section the line is about
    expect(window.localStorage.getItem("settingsSection")).toBe("plugins");
    await userEvent.click(screen.getByRole("button", { name: "1 copy needs a match check" }));
    expect(onNavigate).toHaveBeenCalledWith("collection");
  });

  it("never says nothing needs you before it knows", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith("/api/plugins")) {
          await gate;
          return new Response(JSON.stringify({ plugins: [], adapterTimeoutMs: 8000 }));
        }
        if (u.startsWith("/api/collection/history")) return new Response(JSON.stringify(history([])));
        if (u.startsWith("/api/collection")) return new Response(JSON.stringify({ ...collection, items: [] }));
        if (u.startsWith("/api/insights")) return new Response(JSON.stringify(insights));
        return new Response(JSON.stringify({ items: [] }));
      }),
    );
    renderDash();
    const panel = (await screen.findByRole("heading", { name: "Needs you" })).closest("section") as HTMLElement;
    await screen.findByText("Nothing to do right now.");
    expect(within(panel).queryByText("Nothing needs you.")).toBeNull();
    expect(within(panel).getByText("Loading…")).toBeInTheDocument();
    release();
    expect(await within(panel).findByText("Nothing needs you.")).toBeInTheDocument();
  });

  it("renders the rest when one request fails", async () => {
    stub("/api/plugins");
    renderDash();
    expect(await screen.findByRole("button", { name: /Panzer Dragoon Saga/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 copy needs a match check" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Collection value/ })).toHaveTextContent("$517.69");
  });

  describe("Do next", () => {
    const set = (recommendations: Recommendation[]) => {
      insights = { ...insights, recommendations };
    };
    const panel = async () => (await screen.findByRole("heading", { name: "Recommended actions" })).closest(".ui-panel") as HTMLElement;

    it("Do next lists high money actions first, at most 10", async () => {
      set(Array.from({ length: 12 }, (_, i) => rec("buy_now", `Buy game ${i}`)));
      stub();
      renderDash();
      const p = await panel();
      expect(await within(p).findByText("Buy game 0")).toBeInTheDocument();
      expect(within(p).getByText("Buy game 9")).toBeInTheDocument();
      expect(within(p).queryByText("Buy game 10")).toBeNull();
      // the first panel of the grid
      expect(document.querySelector(".dash-main")?.firstElementChild).toBe(p);
    });

    it("nothing to do when there is neither a recommendation nor a good price", async () => {
      set([]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.startsWith("/api/collection/history")) return new Response(JSON.stringify(history([["2026-10-17", 517.69]])));
          if (u.startsWith("/api/collection")) return new Response(JSON.stringify(collection));
          if (u.startsWith("/api/watchlist")) return new Response(JSON.stringify({ items: [] }));
          if (u.startsWith("/api/insights")) return new Response(JSON.stringify(insights));
          return new Response(JSON.stringify({ plugins: [], adapterTimeoutMs: 8000 }));
        }),
      );
      renderDash();
      const p = await panel();
      expect(await within(p).findByText("Nothing to do right now.")).toBeInTheDocument();
    });

    it("potential ones are folded behind a count", async () => {
      set([rec("sell_now", "Sell sure"), rec("buy_now", "Buy maybe", { confidence: "potential" })]);
      stub();
      renderDash();
      const p = await panel();
      await within(p).findByText("Sell sure");
      expect(within(p).getByText("1 possible").closest("details")?.open).toBe(false);
      expect(p.querySelector(".ui-row")?.textContent).toContain("Sell sure");
    });

    it("clean-ups and best sources sit folded under Do next", async () => {
      set([rec("unwatch", "Stop watching X?"), rec("prefer_source", "On GBA, eBay UK", { subject: { kind: "console", platform: "gba" } })]);
      stub();
      renderDash();
      const p = await panel();
      expect(await within(p).findByText("Clean up (1)")).toBeInTheDocument();
      expect(within(p).getByText("Best sources (1)")).toBeInTheDocument();
    });

    it("Do next failing leaves the rest of the dashboard", async () => {
      stub("/api/insights");
      renderDash();
      const p = await panel();
      expect(await within(p).findByText("Could not load the recommendations.")).toBeInTheDocument();
      // the good prices still show
      expect(await within(p).findByRole("button", { name: /Panzer Dragoon Saga/ })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: /^Collection value/ })).toHaveTextContent("$517.69");
    });

    it("Edit target goes to the watchlist", async () => {
      set([rec("raise_target", "Raise your Panzer target from £25")]);
      stub();
      const { onNavigate, onOpenGame } = renderDash();
      const p = await panel();
      await userEvent.click(await within(p).findByRole("button", { name: "Edit target" }));
      expect(onNavigate).toHaveBeenCalledWith("watchlist");
      await userEvent.click(within(p).getByRole("button", { name: /Raise your Panzer target/ }));
      expect(onOpenGame).toHaveBeenCalledWith(game);
    });
  });
});
