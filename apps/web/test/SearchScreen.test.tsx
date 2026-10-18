import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchScreen } from "../src/screens/SearchScreen.js";
import { act } from "@testing-library/react";
import { stubMatchMedia } from "./helpers/matchMedia.js";
import type { SearchResponse } from "@retrowatchdog/shared";

const response: SearchResponse = {
  games: [
    { id: 7, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998, coverUrl: null },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("SearchScreen", () => {
  it("searches after typing and reports selection", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);
    const onSelect = vi.fn();
    render(<SearchScreen onSelect={onSelect} />);

    await userEvent.type(screen.getByPlaceholderText(/search/i), "panzer");
    const result = await screen.findByText("Panzer Dragoon Saga");
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining("/api/search?q=panzer"));

    await userEvent.click(result);
    expect(onSelect).toHaveBeenCalledWith(response.games[0]);
  });

  it("opens on the search input, without the old hero and tagline", () => {
    render(<SearchScreen onSelect={() => {}} />);
    expect(screen.getByPlaceholderText(/search a game/i)).toBeInTheDocument();
    expect(screen.queryByText(/barking at every price move/)).toBeNull();
    expect(screen.queryByText(/Powered by/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "RetroWatchdog" })).toBeNull();
  });

  it("does not search for queries under 2 characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchScreen onSelect={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), "p");
    await new Promise((r) => setTimeout(r, 500));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/search"))).toBe(false);
  });

  it("shows recent games with their verdict line, and opens one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    window.localStorage.setItem(
      "recentGames",
      JSON.stringify([{ game: response.games[0], verdictTitle: "Buy on eBay UK for £31.90", at: "2026-10-17T10:00:00Z" }]),
    );
    const onSelect = vi.fn();
    render(<SearchScreen onSelect={onSelect} />);
    const panel = screen.getByRole("heading", { name: "Recent" }).closest("section") as HTMLElement;
    const row = within(panel).getByRole("button", { name: /Panzer Dragoon Saga/ });
    expect(row).toHaveTextContent("Buy on eBay UK for £31.90");
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(response.games[0]);
  });

  it("the phone shows the today line, which opens the watchlist", async () => {
    const watch = (id: number, confidence: "high" | "potential") => ({
      id, game: response.games[0], region: null, condition: null, targetPriceOriginal: null, targetCurrency: null,
      targetPriceUsd: null, storeOffer: null, storeBids: [], storeSource: null, priceDisplayAt: null, signalsAboveTarget: 0,
      signals: [{ type: "UNDERPRICED", confidence, reasoning: "cheap" }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [watch(1, "high"), watch(2, "potential")] }))));
    const onOpenWatchlist = vi.fn();
    render(<SearchScreen onSelect={() => {}} onOpenWatchlist={onOpenWatchlist} />);
    await userEvent.click(await screen.findByRole("button", { name: "Today: 1 of 2 watches have a bark (signal)" }));
    expect(onOpenWatchlist).toHaveBeenCalledOnce();
  });

  it("the today line reads the watchlist once, however often the screen re-renders", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ items: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<SearchScreen onSelect={() => {}} onOpenWatchlist={() => {}} />);
    await screen.findByRole("button", { name: /^Today:/ });
    rerender(<SearchScreen onSelect={() => {}} onOpenWatchlist={() => {}} />);
    rerender(<SearchScreen onSelect={() => {}} onOpenWatchlist={() => {}} />);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/watchlist"))).toHaveLength(1);
  });

  it("the today line leaves when the window grows past the phone width", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    const { desktop } = stubMatchMedia({ desktop: false });
    render(<SearchScreen onSelect={() => {}} onOpenWatchlist={() => {}} />);
    expect(await screen.findByRole("button", { name: /^Today:/ })).toBeInTheDocument();
    act(() => desktop.emit(true));
    expect(screen.queryByRole("button", { name: /^Today:/ })).toBeNull();
  });

  describe("Do next on the phone", () => {
    const game = response.games[0];
    const rec = (title: string, confidence: "high" | "potential" = "high") => ({
      action: "buy_now", subject: { kind: "watch", watchId: 1, game }, title, reason: "why", gainUsd: 5, confidence, since: "2026-10-18",
    });
    const routed = (recommendations: unknown[]) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: RequestInfo | URL) =>
          String(url).startsWith("/api/insights")
            ? new Response(JSON.stringify({ recommendations, reliability: [], measuredSince: null, computedAt: "x" }))
            : new Response(JSON.stringify({ items: [] })),
        ),
      );

    it("phone shows Do next with the count of high money actions", async () => {
      routed([rec("Buy A"), rec("Buy B"), rec("Buy C", "potential")]);
      render(<SearchScreen onSelect={() => {}} onOpenWatchlist={() => {}} />);
      expect(await screen.findByRole("button", { name: "Recommended actions: 2" })).toBeInTheDocument();
    });

    it("the sheet lists them and a tap opens the game", async () => {
      routed([rec("Buy A")]);
      const onSelect = vi.fn();
      render(<SearchScreen onSelect={onSelect} onOpenWatchlist={() => {}} />);
      await userEvent.click(await screen.findByRole("button", { name: "Recommended actions: 1" }));
      const sheet = await screen.findByRole("dialog", { name: "Recommended actions" });
      await userEvent.click(within(sheet).getByRole("button", { name: /Buy A/ }));
      expect(onSelect).toHaveBeenCalledWith(game);
      expect(screen.queryByRole("dialog", { name: "Recommended actions" })).toBeNull();
    });

    it("desktop shows no Do next line", async () => {
      routed([rec("Buy A")]);
      stubMatchMedia({ desktop: true });
      render(<SearchScreen onSelect={() => {}} onOpenWatchlist={() => {}} />);
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole("button", { name: /^Recommended actions/ })).toBeNull();
    });

    it("no line when there is nothing to do", async () => {
      routed([rec("Buy maybe", "potential")]);
      render(<SearchScreen onSelect={() => {}} onOpenWatchlist={() => {}} />);
      await screen.findByRole("button", { name: /^Today:/ });
      expect(screen.queryByRole("button", { name: /^Recommended actions/ })).toBeNull();
    });
  });
});
