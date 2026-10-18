import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionScreen } from "../src/screens/CollectionScreen.js";
import type { CollectionResponse, OwnedCopyDto } from "@retrowatchdog/shared";
import { DEFAULT_COLLECTION_CONTROLS } from "../src/lib/listControls.js";

function copy(overrides: Partial<OwnedCopyDto> & Pick<OwnedCopyDto, "id" | "game">): OwnedCopyDto {
  return {
    region: "PAL",
    condition: "loose",
    notes: null,
    acquiredAt: null,
    acquiredPriceOriginal: null,
    acquiredCurrency: null,
    acquiredPriceUsd: null,
    status: "owned",
    itemGrade: null,
    workingState: null,
    authenticity: null,
    acquiredSource: null,
    acquiredUrl: null,
    acquisitionId: null,
    soldAt: null,
    soldPriceOriginal: null,
    soldFeesOriginal: null,
    soldCurrency: null,
    soldPriceUsd: null,
    soldFeesUsd: null,
    soldVenue: null,
    returnedAt: null,
    refundOriginal: null,
    returnCostsOriginal: null,
    refundUsd: null,
    returnCostsUsd: null,
    estimatedValueUsd: null,
    valueBasis: null,
    valueFetchedAt: null,
    signals: [],
    matchBasis: null,
    matchScore: null,
    ...overrides,
  };
}

// three items across distinct platforms/grades/statuses/values so every
// control has something to bite on
const collection: CollectionResponse = {
  items: [
    copy({
      id: 1,
      game: { id: 7, title: "Jurassic Park", platform: "snes", year: 1993, coverUrl: null },
      region: "PAL", condition: "cib",
      acquiredPriceOriginal: 12, acquiredCurrency: "GBP", acquiredPriceUsd: 12,
      estimatedValueUsd: 38, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false }, valueFetchedAt: "2026-08-30T10:00:00Z",
    }),
    copy({
      id: 2,
      game: { id: 9, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998, coverUrl: null },
      region: "NTSC_J",
    }),
    copy({
      id: 3,
      game: { id: 11, title: "Sonic the Hedgehog", platform: "megadrive", year: 1991, coverUrl: null },
      status: "listed", itemGrade: "near_mint",
      acquiredPriceOriginal: 5, acquiredCurrency: "GBP", acquiredPriceUsd: 5,
      estimatedValueUsd: 20, valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: false, viaUnknownRegion: false }, valueFetchedAt: "2026-08-30T09:00:00Z",
    }),
  ],
  totalEstimatedUsd: 58,
  totalPaidUsd: 17,
  totalRealizedUsd: 0, totalReturnedUsd: 0,
  valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};

const TITLES = /Jurassic Park|Panzer Dragoon Saga|Sonic the Hedgehog/;
const renderedOrder = (): Array<string | undefined> =>
  screen.getAllByText(TITLES).map((el) => el.textContent?.match(TITLES)?.[0]);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear(); // controls and the view toggle persist
});

async function renderCollection(): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
  render(<CollectionScreen onSelect={() => {}} />);
  await screen.findByText("Jurassic Park");
}

async function expandControls(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "⚙ Filters & sort" }));
}

function controlGroup(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

describe("CollectionScreen list controls", () => {
  it("filters by platform and hides the other platforms' items", async () => {
    await renderCollection();
    await expandControls();
    await userEvent.click(within(controlGroup("Platform")).getByRole("button", { name: "Saturn" }));
    expect(screen.getByText("Panzer Dragoon Saga")).toBeInTheDocument();
    expect(screen.queryByText("Jurassic Park")).not.toBeInTheDocument();
    expect(screen.queryByText("Sonic the Hedgehog")).not.toBeInTheDocument();
  });

  it("filters by grade: a specific grade and the ungraded bucket", async () => {
    await renderCollection();
    await expandControls();
    await userEvent.click(within(controlGroup("Grade")).getByRole("button", { name: "near mint" }));
    expect(screen.getByText("Sonic the Hedgehog")).toBeInTheDocument();
    expect(screen.queryByText("Jurassic Park")).not.toBeInTheDocument();
    await userEvent.click(within(controlGroup("Grade")).getByRole("button", { name: "ungraded" }));
    expect(screen.getByText("Jurassic Park")).toBeInTheDocument();
    expect(screen.getByText("Panzer Dragoon Saga")).toBeInTheDocument();
    expect(screen.queryByText("Sonic the Hedgehog")).not.toBeInTheDocument();
  });

  it("sorts by value desc with the null-valued item last (default is title A-Z)", async () => {
    await renderCollection();
    expect(renderedOrder()).toEqual(["Jurassic Park", "Panzer Dragoon Saga", "Sonic the Hedgehog"]);
    await expandControls();
    await userEvent.click(within(controlGroup("Sort")).getByRole("button", { name: "value, high first" }));
    expect(renderedOrder()).toEqual(["Jurassic Park", "Sonic the Hedgehog", "Panzer Dragoon Saga"]);
  });

  it("groups by status with section headers, counts and canonical order", async () => {
    await renderCollection();
    await expandControls();
    await userEvent.click(within(controlGroup("Group")).getByRole("button", { name: "status" }));
    const headers = screen.getAllByRole("heading", { level: 4 });
    expect(headers.map((h) => h.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "owned (2)",
      "listed (1)",
    ]);
    // the listed group holds exactly its own item
    const listedHeader = screen.getByRole("heading", { level: 4, name: /listed/ });
    expect(listedHeader.nextElementSibling?.textContent).toContain("Sonic the Hedgehog");
  });

  it("swaps to honest client-side 'Filtered totals' when a filter is active, and back", async () => {
    await renderCollection();
    // no filter: the server totals under the plain label. The Estimated
    // label names the response's valuation basis (valuation-basis spec, Web
    // section) AND, since multi-market, the markets it valued under — the
    // filtered variant keeps both, plus its honesty prefix.
    const kpi = (label: RegExp): HTMLElement => screen.getByText(label).closest(".ui-kpi") as HTMLElement;
    expect(kpi(/^Value \(market, United Kingdom\)$/)).toHaveTextContent("$58.00");
    await expandControls();
    await userEvent.click(within(controlGroup("Platform")).getByRole("button", { name: "Mega Drive" }));
    expect(kpi(/^Filtered value \(market, United Kingdom\)$/)).toHaveTextContent("$20.00");
    expect(screen.queryByText(/^Value \(/)).not.toBeInTheDocument();
    expect(kpi(/^Filtered paid$/)).toHaveTextContent("$5.00");
    expect(screen.getByText("1 item")).toBeInTheDocument();
    // back to all: the server totals return
    await userEvent.click(within(controlGroup("Platform")).getByRole("button", { name: "all" }));
    expect(kpi(/^Value \(market, United Kingdom\)$/)).toHaveTextContent("$58.00");
  });

  it("shows an honest filtered-empty message distinct from the empty-collection hint", async () => {
    await renderCollection();
    await expandControls();
    await userEvent.click(within(controlGroup("Status")).getByRole("button", { name: "sold" }));
    expect(screen.getByText("No items match these filters.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();
  });

  it("persists controls: a stored spec applies on mount and changes round-trip to localStorage", async () => {
    window.localStorage.setItem(
      "collectionControls",
      JSON.stringify({ ...DEFAULT_COLLECTION_CONTROLS, platform: "saturn" }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    // the stored platform filter applied before any interaction
    expect(await screen.findByText("Panzer Dragoon Saga")).toBeInTheDocument();
    expect(screen.queryByText("Jurassic Park")).not.toBeInTheDocument();
    // collapsed state stays visible as an active chip
    expect(screen.getByRole("button", { name: "platform: Saturn" })).toBeInTheDocument();
    await expandControls();
    await userEvent.click(within(controlGroup("Region")).getByRole("button", { name: "NTSC_J" }));
    expect(JSON.parse(window.localStorage.getItem("collectionControls") ?? "{}")).toEqual({
      ...DEFAULT_COLLECTION_CONTROLS,
      platform: "saturn",
      region: "NTSC_J",
    });
  });

  it("ignores unreadable stored controls and falls back to defaults", async () => {
    window.localStorage.setItem("collectionControls", "{corrupted");
    await renderCollection();
    expect(renderedOrder()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("Clear resets every control to defaults and persists the reset", async () => {
    await renderCollection();
    await expandControls();
    await userEvent.click(within(controlGroup("Platform")).getByRole("button", { name: "Saturn" }));
    await userEvent.click(within(controlGroup("Sort")).getByRole("button", { name: "newest" }));
    expect(screen.queryByText("Jurassic Park")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(renderedOrder()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("collectionControls") ?? "{}")).toEqual(
      DEFAULT_COLLECTION_CONTROLS,
    );
  });

  it("keeps the Review chip counting ALL flagged items regardless of filters", async () => {
    const withReview: CollectionResponse = {
      ...collection,
      items: [
        collection.items[0],
        { ...collection.items[1], matchBasis: "candidate", matchScore: 0.8 },
        collection.items[2],
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withReview))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await expandControls();
    // filter Panzer (the flagged copy) OUT of the visible list
    await userEvent.click(within(controlGroup("Platform")).getByRole("button", { name: "SNES" }));
    expect(screen.queryByText("Panzer Dragoon Saga")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review (1)" })).toBeInTheDocument();
  });
});
