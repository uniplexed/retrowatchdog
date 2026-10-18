import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchlistItemDto, WatchlistResponse } from "@retrowatchdog/shared";
import { WatchlistScreen } from "../src/screens/WatchlistScreen.js";
import { DEFAULT_WATCHLIST_CONTROLS } from "../src/lib/listControls.js";

function item(overrides: Partial<WatchlistItemDto> & Pick<WatchlistItemDto, "id" | "game">): WatchlistItemDto {
  return {
    region: null,
    condition: null,
    targetPriceOriginal: null,
    targetCurrency: null,
    targetPriceUsd: null,
    storeOffer: null,
    storeBids: [],
    storeSource: null,
    priceDisplayAt: null, signalsAboveTarget: 0,
    signals: [],
    ...overrides,
  };
}

// mixed platforms/prefs/signals, deliberately in reverse-actionability base
// order so the default sort is observable under filters too
const response: WatchlistResponse = {
  items: [
    item({
      id: 1,
      game: { id: 21, title: "Quiet One", platform: "snes", year: 1991, coverUrl: null },
      region: "PAL", condition: "cib",
    }),
    item({
      id: 2,
      game: { id: 22, title: "Warned Game", platform: "saturn", year: 1992, coverUrl: null },
      region: "PAL",
      signals: [{ type: "OVERPRICED_STORE", reasoning: "r", source: "cex" }],
    }),
    item({
      id: 3,
      game: { id: 23, title: "Bargain Game", platform: "snes", year: 1993, coverUrl: null },
      region: "PAL",
      signals: [{ type: "UNDERPRICED", reasoning: "r", source: "ebay_uk" }],
    }),
    item({
      id: 4,
      game: { id: 24, title: "Flip Game", platform: "snes", year: 1994, coverUrl: null },
      region: "PAL",
      signals: [{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex" }],
    }),
    item({
      id: 5,
      game: { id: 25, title: "Quiet Two", platform: "snes", year: 1995, coverUrl: null },
      // INSUFFICIENT_DATA is not a bark: 'only barking' must hide this one too
      signals: [{ type: "INSUFFICIENT_DATA", reasoning: "r" }],
    }),
  ],
};

const TITLES = /Quiet One|Warned Game|Bargain Game|Flip Game|Quiet Two/;
const renderedOrder = (): Array<string | undefined> =>
  screen.getAllByText(TITLES).map((el) => el.textContent?.match(TITLES)?.[0]);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear(); // controls and the view toggle persist
});

/** every watch on screen: the Signals chip (on by default) off, unless a test stored its own */
async function renderWatchlist(): Promise<void> {
  if (window.localStorage.getItem("watchlistControls") === null) {
    window.localStorage.setItem("watchlistControls", JSON.stringify({ ...DEFAULT_WATCHLIST_CONTROLS, barkingOnly: false }));
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response))));
  render(<WatchlistScreen onSelect={() => {}} />);
  await screen.findByText("Flip Game");
}

async function expandControls(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "⚙ Filters & sort" }));
}

function controlGroup(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

describe("WatchlistScreen list controls", () => {
  it("the Signals chip keeps items with actionable signals only (info-only items are quiet)", async () => {
    await renderWatchlist();
    await userEvent.click(screen.getByRole("button", { name: "Signals" }));
    expect(renderedOrder()).toEqual(["Flip Game", "Bargain Game", "Warned Game"]);
    expect(screen.queryByText("Quiet One")).not.toBeInTheDocument();
    expect(screen.queryByText("Quiet Two")).not.toBeInTheDocument();
    // toggling back restores everything
    await userEvent.click(screen.getByRole("button", { name: "Signals" }));
    expect(renderedOrder()).toHaveLength(5);
  });

  it("keeps the actionability ordering under a region-pref filter", async () => {
    await renderWatchlist();
    await expandControls();
    await userEvent.click(within(controlGroup("Region")).getByRole("button", { name: "PAL" }));
    // Quiet Two (null pref) is filtered out; the rest keep flip > bargain > warning > quiet
    expect(renderedOrder()).toEqual(["Flip Game", "Bargain Game", "Warned Game", "Quiet One"]);
  });

  it("filters by condition pref, with 'any' matching the null pref", async () => {
    await renderWatchlist();
    await expandControls();
    await userEvent.click(within(controlGroup("Condition")).getByRole("button", { name: "cib" }));
    expect(renderedOrder()).toEqual(["Quiet One"]);
    await userEvent.click(within(controlGroup("Condition")).getByRole("button", { name: "any" }));
    expect(renderedOrder()).toEqual(["Flip Game", "Bargain Game", "Warned Game", "Quiet Two"]);
  });

  it("sorts by title A-Z as the alternative to actionability", async () => {
    await renderWatchlist();
    await expandControls();
    await userEvent.click(within(controlGroup("Sort")).getByRole("button", { name: "title A-Z" }));
    expect(renderedOrder()).toEqual([
      "Bargain Game", "Flip Game", "Quiet One", "Quiet Two", "Warned Game",
    ]);
  });

  it("groups by platform with section headers and counts, keeping actionability inside groups", async () => {
    await renderWatchlist();
    await expandControls();
    await userEvent.click(within(controlGroup("Group")).getByRole("button", { name: "platform" }));
    const headers = screen.getAllByRole("heading", { level: 4 });
    expect(headers.map((h) => h.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Saturn (1)",
      "SNES (4)",
    ]);
    // inside SNES the actionability order still applies
    expect(renderedOrder()).toEqual([
      "Warned Game", "Flip Game", "Bargain Game", "Quiet One", "Quiet Two",
    ]);
  });

  it("shows an honest filtered-empty note and persists controls under watchlistControls", async () => {
    await renderWatchlist();
    await expandControls();
    await userEvent.click(within(controlGroup("Region")).getByRole("button", { name: "NTSC_J" }));
    expect(screen.getByText("No watched games match these filters.")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("watchlistControls") ?? "{}")).toEqual({
      ...DEFAULT_WATCHLIST_CONTROLS,
      barkingOnly: false,
      region: "NTSC_J",
    });
    // Clear resets the filters (the Signals chip keeps its own state) and the full list returns
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(renderedOrder()).toHaveLength(5);
    expect(JSON.parse(window.localStorage.getItem("watchlistControls") ?? "{}")).toEqual({
      ...DEFAULT_WATCHLIST_CONTROLS,
      barkingOnly: false,
    });
  });

  it("applies stored controls on mount and shows them as collapsed active chips", async () => {
    window.localStorage.setItem(
      "watchlistControls",
      JSON.stringify({ ...DEFAULT_WATCHLIST_CONTROLS, barkingOnly: true, region: "PAL" }),
    );
    await renderWatchlist();
    expect(screen.queryByText("Quiet One")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Signals" })).toHaveAttribute("aria-pressed", "true");
    // the collapsed row carries the active filter as a chip
    expect(screen.getByRole("button", { name: "region: PAL" })).toHaveClass("active");
  });
});
