import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import type {
  CollectionResponse,
  GameSummary,
  OwnedCopyDto,
  PricesResponse,
  SearchResponse,
  WatchlistItemDto,
  WatchlistResponse,
} from "@retrowatchdog/shared";
import { getSourcesSnapshot, loadSources, resetSourcesForTests } from "../src/lib/sources.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";
import { stubMatchMedia } from "./helpers/matchMedia.js";

// One distinct game per origin screen, so a mis-wired `from` shows up as the
// wrong title appearing after Back, not just the wrong screen shape.
const searchGame: GameSummary = { id: 101, title: "Chrono Trigger", platform: "snes", year: 1995, coverUrl: null };
const collectionGame: GameSummary = { id: 102, title: "EarthBound", platform: "snes", year: 1994, coverUrl: null };
const watchlistGame: GameSummary = { id: 103, title: "Super Metroid", platform: "snes", year: 1994, coverUrl: null };

const searchResponse: SearchResponse = { games: [searchGame] };

const ownedCopyBase: Omit<OwnedCopyDto, "id" | "game" | "region" | "condition"> = {
  notes: null, acquiredAt: null, acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: null,
  status: "owned",
  itemGrade: null, workingState: null, authenticity: null,
  acquiredSource: null, acquiredUrl: null, acquisitionId: null,
  soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
  soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
  returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
  refundUsd: null, returnCostsUsd: null,
  estimatedValueUsd: null, valueBasis: null, valueFetchedAt: null,
  signals: [], matchBasis: null, matchScore: null,
};

const collectionResponse: CollectionResponse = {
  items: [{ ...ownedCopyBase, id: 201, game: collectionGame, region: "PAL", condition: "cib" }],
  valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false }, totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0,
};

function watchItem(overrides: Partial<WatchlistItemDto> & Pick<WatchlistItemDto, "id" | "game">): WatchlistItemDto {
  return {
    region: null, condition: null, targetPriceOriginal: null, targetCurrency: null,
    targetPriceUsd: null, storeOffer: null, storeBids: [], storeSource: null,
    priceDisplayAt: null, signalsAboveTarget: 0,
    signals: [],
    ...overrides,
  };
}

const watchlistResponse: WatchlistResponse = {
  items: [watchItem({ id: 301, game: watchlistGame })],
};

// Same fixture serves every game the tests open — GameDetail never renders
// data.game (the header uses the `game` prop instead), so one shape is fine.
const pricesResponse: PricesResponse = {
  game: searchGame,
  sources: [],
  signals: [],
  gamePriceMode: null,
};

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/prices")) return new Response(JSON.stringify(pricesResponse));
    if (u.includes("/api/search")) return new Response(JSON.stringify(searchResponse));
    if (u.includes("/api/watchlist")) return new Response(JSON.stringify(watchlistResponse));
    // the dashboard reads the value history; before /api/collection, which it contains
    if (u.includes("/api/collection/history")) {
      return new Response(JSON.stringify({ valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false }, days: 31, from: "2026-09-17", to: "2026-10-17", points: [] }));
    }
    if (u.includes("/api/plugins")) return new Response(JSON.stringify({ plugins: [], adapterTimeoutMs: 8000 }));
    if (u.includes("/api/collection")) return new Response(JSON.stringify(collectionResponse));
    // App loads the source registry at boot, beside the FX rate; without it
    // here the throw below would be swallowed by loadSources and every screen
    // in this file would silently render against an EMPTY registry
    if (u === "/api/sources") return new Response(JSON.stringify({ sources: SOURCES_FIXTURE }));
    if (u.includes("/api/fx")) {
      const to = new URL(u, "http://test").searchParams.get("to");
      return new Response(
        JSON.stringify({ base: "USD", to, rate: 0.9, fetchedAt: new Date().toISOString(), mode: "auto" }),
      );
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("App boot", () => {
  it("fetches the source registry exactly once at boot, and stores what it got", async () => {
    // The web carries no compiled copy of the manifest: if App did not fetch
    // the registry, every source would render as its raw id everywhere.
    resetSourcesForTests();
    const fetchMock = stubFetch();
    render(<App />);

    await screen.findByPlaceholderText(/search a game/i);
    await act(async () => {
      await Promise.resolve();
    });
    const sourceCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/sources");
    expect(sourceCalls).toHaveLength(1);
    expect(getSourcesSnapshot().byId.cex?.label).toBe("CeX UK");
  });
});

describe("App back navigation", () => {
  it("returns to Search when the game was opened from Search", async () => {
    stubFetch();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), "chrono");
    await userEvent.click(await screen.findByText("Chrono Trigger"));
    expect(await screen.findByText("← Back")).toBeInTheDocument();

    await userEvent.click(screen.getByText("← Back"));
    expect(screen.getByPlaceholderText(/search a game/i)).toBeInTheDocument();
    expect(screen.queryByText("← Back")).not.toBeInTheDocument();
  });

  it("returns to Collection when the game was opened from Collection, keeping the Collection tab active while open", async () => {
    stubFetch();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    await userEvent.click(await screen.findByText("EarthBound"));
    expect(await screen.findByText("← Back")).toBeInTheDocument();

    // origin-aware tabbar: Collection stays highlighted, Search does not
    // wrongly light up just because a game is open.
    expect(screen.getByRole("button", { name: "Collection" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Search" })).not.toHaveClass("active");

    await userEvent.click(screen.getByText("← Back"));
    expect(await screen.findByText("EarthBound")).toBeInTheDocument();
    expect(screen.queryByText("← Back")).not.toBeInTheDocument();
  });

  it("returns to Watchlist when the game was opened from Watchlist, keeping the Watch tab active while open", async () => {
    stubFetch();
    // the fixture watch has no signal: the Signals chip (on by default) off
    window.localStorage.setItem("watchlistControls", JSON.stringify({ barkingOnly: false }));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Watch" }));
    await userEvent.click(await screen.findByText("Super Metroid"));
    expect(await screen.findByText("← Back")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Watch" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Search" })).not.toHaveClass("active");

    await userEvent.click(screen.getByText("← Back"));
    expect(await screen.findByText("Super Metroid")).toBeInTheDocument();
    expect(screen.queryByText("← Back")).not.toBeInTheDocument();
  });

  it("keeps the Collection status filter after returning from a game opened there", async () => {
    // Per-screen control state lives in localStorage keyed by screen, not on
    // the View union — it must survive a round trip through the game screen.
    stubFetch();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    const status = await screen.findByRole("group", { name: "Status" });
    await userEvent.click(within(status).getByRole("button", { name: "owned" }));

    await userEvent.click(screen.getByText("EarthBound"));
    await userEvent.click(await screen.findByText("← Back"));

    const back = await screen.findByRole("group", { name: "Status" });
    expect(within(back).getByRole("button", { name: "owned" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("App history sync", () => {
  it("replaces the initial history entry on mount instead of pushing one", () => {
    stubFetch();
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    const pushSpy = vi.spyOn(window.history, "pushState");
    render(<App />);

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith({ screen: "search" }, "");
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("restores Collection from a popstate carrying its history state, after opening a game from there", async () => {
    stubFetch();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    await userEvent.click(await screen.findByText("EarthBound"));
    expect(await screen.findByText("← Back")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { screen: "collection" } }));
    });

    expect(await screen.findByText("EarthBound")).toBeInTheDocument();
    expect(screen.queryByText("← Back")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collection" })).toHaveClass("active");
  });

  it("keeps history length consistent when the in-app Back button is used (no orphan entries)", async () => {
    stubFetch();
    render(<App />);
    const lengthBeforeOpen = window.history.length;

    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    await userEvent.click(await screen.findByText("EarthBound"));
    expect(await screen.findByText("← Back")).toBeInTheDocument();
    const lengthAfterOpen = window.history.length;
    expect(lengthAfterOpen).toBe(lengthBeforeOpen + 2); // tab switch + game open each pushed one

    await userEvent.click(screen.getByText("← Back"));

    expect(await screen.findByText("EarthBound")).toBeInTheDocument();
    expect(screen.queryByText("← Back")).not.toBeInTheDocument();
    // history.back() only moves the pointer; it must not have pushed a new
    // entry on top (that would orphan the popped-to entry going forward).
    expect(window.history.length).toBe(lengthAfterOpen);
  });

  it("falls back to Search when a popstate carries garbage state", async () => {
    stubFetch();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    await screen.findByRole("group", { name: "Status" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { nonsense: true } }));
    });

    expect(await screen.findByPlaceholderText(/search a game/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toHaveClass("active");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    expect(await screen.findByPlaceholderText(/search a game/i)).toBeInTheDocument();
  });

  it("does not grow history when switching to the same tab twice", async () => {
    stubFetch();
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    await screen.findByRole("group", { name: "Status" });
    const lengthAfterFirstSwitch = window.history.length;

    await userEvent.click(screen.getByRole("button", { name: "Collection" }));
    await userEvent.click(screen.getByRole("button", { name: "Collection" }));

    expect(window.history.length).toBe(lengthAfterFirstSwitch);
  });
});

describe("App shell across the breakpoint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the dashboard first on desktop", async () => {
    stubFetch();
    stubMatchMedia({ desktop: true });
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    expect(within(sidebar).getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  });

  it("the desktop footer adds plugin health to the markets", async () => {
    stubFetch();
    stubMatchMedia({ desktop: true });
    render(<App />);
    const foot = await screen.findByText(/markets · No plugins/);
    expect(foot).toHaveClass("shell-foot");
  });

  it("the footer re-reads plugin health when the sources reload", async () => {
    const fetchMock = stubFetch();
    stubMatchMedia({ desktop: true });
    render(<App />);
    await screen.findByText(/markets · No plugins/);
    const base = fetchMock.getMockImplementation() as (url: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes("/api/plugins")
        ? new Response(JSON.stringify({ plugins: [{ id: 1, status: "pending", proposed: null, lastHealthAt: "2026-10-17T10:00:00Z", configured: true, lastError: null, requiredSecrets: [], baseUrl: "http://x" }], adapterTimeoutMs: 8000 }))
        : base(url),
    );
    // a plugin change reloads the source registry (PluginsPanel.refreshAll)
    await act(async () => {
      await loadSources();
    });
    expect(await screen.findByText(/1 of 1 plugins needs you/)).toBeInTheDocument();
  });

  it("the footer survives a failed plugins call", async () => {
    const fetchMock = stubFetch();
    const base = fetchMock.getMockImplementation() as (url: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes("/api/plugins") ? new Response("{}", { status: 500 }) : base(url),
    );
    stubMatchMedia({ desktop: true });
    render(<App />);
    expect(await screen.findByText(/^\d+ markets$/)).toBeInTheDocument();
  });

  it("a game opened from the global search on Settings goes back to Settings", async () => {
    stubFetch();
    stubMatchMedia({ desktop: true });
    render(<App />);
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    await userEvent.click(within(sidebar).getByRole("button", { name: "Settings" }));
    await userEvent.type(screen.getByLabelText("Search games"), "chrono");
    await userEvent.click(await screen.findByText("Chrono Trigger"));
    expect(screen.getByRole("heading", { level: 1, name: "Chrono Trigger" })).toBeInTheDocument();
    expect(window.history.state).toMatchObject({ screen: "game", from: "settings" });
    // a restore of that entry finds the game, not Search
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Chrono Trigger" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });

  it("a dashboard state on a phone opens Search", () => {
    stubFetch();
    const { desktop } = stubMatchMedia({ desktop: true });
    render(<App />);
    act(() => desktop.emit(false));
    expect(screen.getByPlaceholderText("Search a game…")).toBeInTheDocument();
    const tabbar = document.querySelector(".tabbar") as HTMLElement;
    expect(within(tabbar).getByRole("button", { name: "Search" })).toHaveClass("active");
  });

  it("keeps the view when the viewport crosses the breakpoint", async () => {
    stubFetch();
    const { desktop } = stubMatchMedia({ desktop: true });
    render(<App />);
    const sidebar = screen.getByRole("navigation", { name: "Sections" });
    await userEvent.click(within(sidebar).getByRole("button", { name: "Collection" }));
    expect(await screen.findByText("EarthBound")).toBeInTheDocument();
    expect(document.querySelector(".tabbar")).toBeNull();

    act(() => desktop.emit(false));

    expect(screen.getByText("EarthBound")).toBeInTheDocument();
    const tabbar = document.querySelector(".tabbar") as HTMLElement;
    expect(within(tabbar).getByRole("button", { name: "Collection" })).toHaveClass("active");
  });
});
