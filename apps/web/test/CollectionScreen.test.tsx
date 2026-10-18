import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionScreen } from "../src/screens/CollectionScreen.js";
import type { CollectionResponse } from "@retrowatchdog/shared";

// Totals deliberately differ from every single row (38+20 / 12+5): equal
// values would make getByText ambiguous between totals and item rows.
const collection: CollectionResponse = {
  items: [
    {
      id: 1,
      game: { id: 7, title: "Jurassic Park", platform: "snes", year: 1993, coverUrl: "https://covers.example/jp.jpg" },
      region: "PAL", condition: "cib", notes: "boxed, minor wear",
      acquiredAt: null, acquiredPriceOriginal: 12, acquiredCurrency: "GBP", acquiredPriceUsd: 12,
      status: "owned",
      itemGrade: null, workingState: null, authenticity: null,
      acquiredSource: null, acquiredUrl: null, acquisitionId: null,
      soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
      soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
      returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
      refundUsd: null, returnCostsUsd: null,
      estimatedValueUsd: 38, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false },
      valueFetchedAt: "2026-08-30T10:00:00Z",
      signals: [], matchBasis: null, matchScore: null,
    },
    {
      id: 2,
      game: { id: 9, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998, coverUrl: null },
      region: "NTSC_J", condition: "loose", notes: null,
      acquiredAt: null, acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: null,
      status: "owned",
      itemGrade: null, workingState: null, authenticity: null,
      acquiredSource: null, acquiredUrl: null, acquisitionId: null,
      soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
      soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
      returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
      refundUsd: null, returnCostsUsd: null,
      estimatedValueUsd: null, valueBasis: null,
      valueFetchedAt: null,
      signals: [], matchBasis: null, matchScore: null,
    },
    {
      id: 3,
      game: { id: 11, title: "Sonic the Hedgehog", platform: "megadrive", year: 1991, coverUrl: null },
      region: "PAL", condition: "loose", notes: null,
      acquiredAt: null, acquiredPriceOriginal: 5, acquiredCurrency: "GBP", acquiredPriceUsd: 5,
      status: "owned",
      itemGrade: "near_mint", workingState: null, authenticity: null,
      acquiredSource: null, acquiredUrl: null, acquisitionId: null,
      soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
      soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
      returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
      refundUsd: null, returnCostsUsd: null,
      estimatedValueUsd: 20, valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: false, viaUnknownRegion: false },
      valueFetchedAt: "2026-08-30T09:00:00Z",
      signals: [], matchBasis: null, matchScore: null,
    },
  ],
  totalEstimatedUsd: 58,
  totalPaidUsd: 17,
  totalRealizedUsd: 0, totalReturnedUsd: 0,
  valuationBasis: "market",
  valuationMarkets: { country: "GB", includeForeign: false },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear(); // the view toggle persists; keep tests isolated
});

/** a KPI tile, found by its label */
const kpi = (label: RegExp): HTMLElement => screen.getByText(label).closest(".ui-kpi") as HTMLElement;

/** a removal or deletion asks in a dialog; `ok` false cancels it */
async function answerDialog(ok: boolean): Promise<void> {
  const dialog = screen.getByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: ok ? /^(Remove|Delete)$/ : "Cancel" }));
}

/** opens a row's CopyEditor sheet (copy-editor spec, 2026-09-02): "Edit copy <title> <region> <condition>" */
async function openEditor(name: string): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("form", { name: /^Edit copy/ });
}

type FetchCall = [RequestInfo | URL, RequestInit | undefined];
const patchesOf = (fetchMock: ReturnType<typeof vi.fn>) =>
  (fetchMock.mock.calls as unknown as FetchCall[]).filter((c) => c[1]?.method === "PATCH");
const collectionGetsOf = (fetchMock: ReturnType<typeof vi.fn>) =>
  (fetchMock.mock.calls as unknown as FetchCall[]).filter(
    (c) => c[1]?.method === undefined && String(c[0]).includes("/api/collection"),
  );

describe("CollectionScreen", () => {
  it("lists copies with values, basis and honest no-data state, plus totals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    expect(await screen.findByText("Jurassic Park")).toBeInTheDocument();
    expect(screen.getByText("$38.00")).toBeInTheDocument();
    // the basis renders through the shared tag map ("sell" = the CeX sell
    // price, i.e. the replacement reading), no longer the raw "cex sell"
    // identifier (valuation-basis spec, Web section)
    expect(screen.getByText("sell · CeX UK")).toBeInTheDocument();
    expect(screen.getByText(/no price data yet/i)).toBeInTheDocument();
    // the paid leg is the verbatim GBP original, not a display conversion
    expect(screen.getByText(/· paid £12.00/i)).toBeInTheDocument();
    // the value label names the basis AND the markets the response was
    // computed under
    expect(kpi(/^Value \(market, United Kingdom\)$/)).toHaveTextContent("$58.00");
    expect(kpi(/^Paid$/)).toHaveTextContent("$17.00");
    // realized and returns only when non-zero
    expect(screen.queryByText("Realized")).not.toBeInTheDocument();
    expect(screen.queryByText("Returns")).not.toBeInTheDocument();
  });

  it("navigates to the game when its title is clicked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    const onSelect = vi.fn();
    render(<CollectionScreen onSelect={onSelect} />);
    await screen.findByText("Jurassic Park");
    await userEvent.click(screen.getByText("Jurassic Park"));
    expect(onSelect).toHaveBeenCalledWith(collection.items[0].game);
  });

  it("deletes a copy after confirmation", async () => {
    const collectionAfterDelete: CollectionResponse = {
      items: [
        collection.items[1],
        collection.items[2],
      ],
      totalEstimatedUsd: 20,
      totalPaidUsd: 5,
      totalRealizedUsd: 0, totalReturnedUsd: 0,
      valuationBasis: "market",
      valuationMarkets: { country: "GB", includeForeign: false },
    };
    let requestCount = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      requestCount++;
      if (requestCount === 1) return new Response(JSON.stringify(collection));
      return new Response(JSON.stringify(collectionAfterDelete));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await userEvent.click(screen.getByRole("button", { name: "Remove Jurassic Park" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Remove Jurassic Park (PAL · cib) from your collection?");
    await answerDialog(true);
    await waitFor(() =>
      expect((fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>).some((call) => call[1]?.method === "DELETE")).toBe(true),
    );
    const deleteCall = (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>).find((call) => call[1]?.method === "DELETE");
    expect(String(deleteCall![0])).toContain("/api/collection/1");
    await screen.findByText("Panzer Dragoon Saga");
    expect(screen.queryByText("Jurassic Park")).not.toBeInTheDocument();
  });

  it("surfaces a failed remove instead of swallowing it: note shown, item stays", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 500 });
      return new Response(JSON.stringify(collection));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await userEvent.click(screen.getByRole("button", { name: "Remove Jurassic Park" }));
    await answerDialog(true);
    expect(
      await screen.findByText("Could not remove — is the API up? Try again."),
    ).toBeInTheDocument();
    expect(screen.getByText("Jurassic Park")).toBeInTheDocument();
  });

  it("delete-all asks for confirmation with the item count, calls the API and reloads", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ deleted: 3 }));
      return new Response(JSON.stringify(collection));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await userEvent.click(screen.getByRole("button", { name: /delete entire collection/i }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Delete ALL 3 items, including sold/returned history? This cannot be undone.",
    );
    await answerDialog(true);
    expect(await screen.findByText("Deleted 3 items")).toBeInTheDocument();
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    const deleteCall = calls.find((c) => c[1]?.method === "DELETE");
    // the collection-wide endpoint, not a per-copy /api/collection/:id
    expect(String(deleteCall![0])).toMatch(/\/api\/collection$/);
    const collectionGets = calls.filter((c) => c[1]?.method === undefined);
    expect(collectionGets.length).toBeGreaterThanOrEqual(2);
  });

  it("delete-all does nothing when the confirmation is declined", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await userEvent.click(screen.getByRole("button", { name: /delete entire collection/i }));
    await answerDialog(false);
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    expect(calls.find((c) => c[1]?.method === "DELETE")).toBeUndefined();
    expect(screen.getByText("Jurassic Park")).toBeInTheDocument();
  });

  it("delete-all surfaces a failure note", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 500 });
      return new Response(JSON.stringify(collection));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await userEvent.click(screen.getByRole("button", { name: /delete entire collection/i }));
    await answerDialog(true);
    expect(
      await screen.findByText("Could not delete the collection — is the API up? Try again."),
    ).toBeInTheDocument();
    expect(screen.getByText("Jurassic Park")).toBeInTheDocument();
  });

  it("does not delete when the confirmation is declined", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await userEvent.click(screen.getByRole("button", { name: "Remove Jurassic Park" }));
    await answerDialog(false);
    const deleteCall = (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>).find((call) => call[1]?.method === "DELETE");
    expect(deleteCall).toBeUndefined();
  });

  it("renders the game cover on cards when present, nothing when null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    const { container } = render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(container.querySelector('img[src="https://covers.example/jp.jpg"]')).toBeInTheDocument();
    // the two coverUrl:null games render no <img> at all
    expect(container.querySelectorAll("img").length).toBe(1);
  });

  it("shows value freshness", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(screen.getAllByText(/· priced/).length).toBeGreaterThan(0);
  });

  it("shows an honest excluded line instead of the no-price-data hint", async () => {
    const withExcluded: CollectionResponse = {
      items: [
        {
          id: 5,
          game: { id: 15, title: "Bad Cart Copy", platform: "snes", year: 1994, coverUrl: null },
          region: "PAL", condition: "cib", notes: null,
          acquiredAt: null, acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: null,
          status: "owned",
          itemGrade: null, workingState: null, authenticity: "counterfeit",
          acquiredSource: null, acquiredUrl: null, acquisitionId: null,
          soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
      soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
          returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
      refundUsd: null, returnCostsUsd: null,
          estimatedValueUsd: null, valueBasis: { readAs: "excluded", reason: "counterfeit" },
          valueFetchedAt: null,
          signals: [], matchBasis: null, matchScore: null,
        },
      ],
      totalEstimatedUsd: 0,
      totalPaidUsd: 0,
      totalRealizedUsd: 0, totalReturnedUsd: 0,
      valuationBasis: "market",
      valuationMarkets: { country: "GB", includeForeign: false },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withExcluded))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Bad Cart Copy");
    expect(await screen.findByText(/excluded/i)).toBeInTheDocument();
    expect(screen.queryByText(/no price data yet/i)).not.toBeInTheDocument();
  });

  it("a copy priced only outside the valuation markets says so, and where to change it", async () => {
    // The copy HAS fresh stored prices; they all come from countries the
    // Valuation-markets setting excludes. "no price data yet — open the game
    // once to fetch prices" would be a false cause and useless advice: the
    // refetch queries the very markets the setting is rejecting.
    const outside: CollectionResponse = {
      items: [
        {
          ...collection.items[1],
          id: 6,
          game: { id: 17, title: "Castlevania Bloodlines", platform: "megadrive", year: 1994, coverUrl: null },
          estimatedValueUsd: null,
          valueBasis: { readAs: "excluded", reason: "outside_valuation_markets" },
        },
      ],
      totalEstimatedUsd: 0,
      totalPaidUsd: 0,
      totalRealizedUsd: 0, totalReturnedUsd: 0,
      valuationBasis: "market",
      valuationMarkets: { country: "GB", includeForeign: false },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(outside))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Castlevania Bloodlines");
    expect(await screen.findByText(/outside your valuation markets/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings → Valuation markets/)).toBeInTheDocument();
    expect(screen.queryByText(/no price data yet/i)).not.toBeInTheDocument();
  });

  it("shows the empty-collection hint", async () => {
    const emptyCollection: CollectionResponse = {
      items: [],
      totalEstimatedUsd: 0,
      totalPaidUsd: 0,
      totalRealizedUsd: 0, totalReturnedUsd: 0,
      valuationBasis: "market",
      valuationMarkets: { country: "GB", includeForeign: false },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(emptyCollection))));
    render(<CollectionScreen onSelect={() => {}} />);
    expect(await screen.findByText(/Nothing here yet — find a game and tap "I own this"/)).toBeInTheDocument();
  });

  it("filters by status chips and shows realized total", async () => {
    const withSold: CollectionResponse = {
      items: [
        collection.items[0],
        {
          id: 4,
          game: { id: 13, title: "Chrono Trigger", platform: "snes", year: 1995, coverUrl: null },
          region: "NTSC_U", condition: "cib", notes: null,
          acquiredAt: null, acquiredPriceOriginal: 10, acquiredCurrency: "GBP", acquiredPriceUsd: 10,
          status: "sold",
          itemGrade: null, workingState: null, authenticity: null,
          acquiredSource: null, acquiredUrl: null, acquisitionId: null,
          soldAt: "2026-08-30", soldPriceOriginal: 40, soldFeesOriginal: 2, soldCurrency: "GBP",
          soldPriceUsd: 40, soldFeesUsd: 2, soldVenue: null,
          returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
      refundUsd: null, returnCostsUsd: null,
          estimatedValueUsd: null, valueBasis: null,
          valueFetchedAt: null,
          signals: [], matchBasis: null, matchScore: null,
        },
      ],
      totalEstimatedUsd: 38,
      totalPaidUsd: 22,
      totalRealizedUsd: 28, totalReturnedUsd: 0,
      valuationBasis: "market",
      valuationMarkets: { country: "GB", includeForeign: false },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withSold))));
    render(<CollectionScreen onSelect={() => {}} />);
    // realized shows because it is non-zero
    await waitFor(() => expect(kpi(/^Realized$/)).toHaveTextContent("$28.00"));
    // the status chips are always on screen
    await userEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "sold" }));
    // the value counts active copies only, and the count says so
    expect(screen.getByText("0 active of 1 item")).toBeInTheDocument();
  });

  it("one dense row per copy: title, meta, value; the editor opens only from Edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(document.querySelectorAll(".ui-swipe")).toHaveLength(3);
    expect(screen.getByText(/SNES · PAL · cib/)).toBeInTheDocument();
    expect(screen.getByText("$38.00")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument(); // Panzer Dragoon Saga: no estimate
    // no editor until asked for, and the notes stay in the editor
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByText("boxed, minor wear")).not.toBeInTheDocument();
  });

  it("list view shows a status chip only for non-owned items", async () => {
    const withListed: CollectionResponse = {
      ...collection,
      items: [collection.items[0], { ...collection.items[1], status: "listed" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withListed))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Panzer Dragoon Saga");
    expect(screen.getByText(/\[listed\]/)).toBeInTheDocument();
    expect(screen.queryByText(/\[owned\]/)).not.toBeInTheDocument();
  });

  it("a stored cards view opens the list; there is one layout", async () => {
    window.localStorage.setItem("collectionView", "cards");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(document.querySelectorAll(".ui-swipe")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Cards" })).not.toBeInTheDocument();
    // every row carries its Edit action
    expect(screen.getAllByRole("button", { name: /^Edit copy/ })).toHaveLength(3);
  });

  it("still renders when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("Edit opens the CopyEditor in a sheet with the copy's values, one at a time; Remove stays", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    // the editor carries the name of the button that opened it (review
    // follow-up: one accessible name per copy on both surfaces)
    expect(editor).toHaveAccessibleName("Edit copy Jurassic Park PAL cib");
    // the verbatim paid original and its currency, the stored notes
    expect((within(editor).getByLabelText("Paid") as HTMLInputElement).value).toBe("12");
    expect((within(editor).getByLabelText("Paid currency") as HTMLSelectElement).value).toBe("GBP");
    expect((within(editor).getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("boxed, minor wear");
    expect((within(editor).getByLabelText("Status") as HTMLSelectElement).value).toBe("owned");
    // and it is a sheet named for the copy
    expect(screen.getByRole("dialog", { name: "Edit copy Jurassic Park PAL cib" })).toBeInTheDocument();
    // Remove is still on every row
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
    // opening another copy's editor replaces this one
    await userEvent.click(screen.getByRole("button", { name: "Edit copy Sonic the Hedgehog PAL loose" }));
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(screen.getByRole("form", { name: "Edit copy Sonic the Hedgehog PAL loose" })).toBeInTheDocument();
    // Cancel closes it
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("same-tier copies of one game get numbered edit buttons and a matching editor name; other games keep the plain name", async () => {
    // a second Sonic PAL loose (a duplicate kept for trading)
    const withTwin: CollectionResponse = {
      ...collection,
      items: [...collection.items, { ...collection.items[2], id: 4, acquiredPriceOriginal: 3, acquiredPriceUsd: 3 }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withTwin))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(screen.getByRole("button", { name: "Edit copy Sonic the Hedgehog PAL loose #1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit copy Sonic the Hedgehog PAL loose #2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit copy Jurassic Park PAL cib" })).toBeInTheDocument();
    const editor = await openEditor("Edit copy Sonic the Hedgehog PAL loose #2");
    expect(editor).toHaveAccessibleName("Edit copy Sonic the Hedgehog PAL loose #2");
    expect((within(editor).getByLabelText("Paid") as HTMLInputElement).value).toBe("3");
  });

  it("cancels the sold flow without calling updateCopy and resets the select", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("prompt", vi.fn(() => null));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // copy-editor spec (2026-09-02): the status control lives in the editor
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const select = within(editor).getByLabelText(/status/i) as HTMLSelectElement;
    expect(select.value).toBe("owned");
    await userEvent.selectOptions(select, "sold");
    await waitFor(() => expect(select.value).toBe("owned"));
    expect(patchesOf(fetchMock)).toHaveLength(0);
    // nothing changed: Save writes nothing and just closes the editor
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
    expect(patchesOf(fetchMock)).toHaveLength(0);
  });

  it("rejects a non-numeric sold price without calling updateCopy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("prompt", vi.fn(() => "abc"));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const select = within(editor).getByLabelText(/status/i) as HTMLSelectElement;
    await userEvent.selectOptions(select, "sold");
    await waitFor(() => expect(select.value).toBe("owned"));
    expect(alertMock).toHaveBeenCalledWith("Invalid price");
    expect(patchesOf(fetchMock)).toHaveLength(0);
  });

  it("marks a copy sold with amount + currency (two prompts) and Save PATCHes the new leg fields, then reloads", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(null, { status: 200 });
      return new Response(JSON.stringify(collection));
    });
    vi.stubGlobal("fetch", fetchMock);
    // first prompt: the amount; second: the currency (case-insensitive)
    const promptMock = vi.fn().mockReturnValueOnce("40").mockReturnValueOnce("gbp");
    vi.stubGlobal("prompt", promptMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // copy-editor spec (2026-09-02): the prompts run on the status change
    // inside the editor; the ONE PATCH goes out on Save
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const select = within(editor).getByLabelText(/status/i) as HTMLSelectElement;
    await userEvent.selectOptions(select, "sold");
    expect(select.value).toBe("sold");
    expect(patchesOf(fetchMock)).toHaveLength(0);
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const patches = patchesOf(fetchMock);
      expect(patches).toHaveLength(1);
      expect(String(patches[0][0])).toContain("/api/collection/1");
      expect(JSON.parse(String(patches[0][1]?.body))).toMatchObject({
        status: "sold", soldPriceOriginal: 40, soldCurrency: "GBP",
      });
    });
    // the picked sale currency becomes the next default
    expect(window.localStorage.getItem("lastPaidCurrency")).toBe("GBP");
    // reload after the write: the collection GET runs again, the editor is gone
    await waitFor(() => expect(collectionGetsOf(fetchMock).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("rejects an unsupported sold currency without calling updateCopy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("prompt", vi.fn().mockReturnValueOnce("40").mockReturnValueOnce("DOGE"));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const select = within(editor).getByLabelText(/status/i) as HTMLSelectElement;
    await userEvent.selectOptions(select, "sold");
    await waitFor(() => expect(select.value).toBe("owned"));
    expect(alertMock).toHaveBeenCalledWith("Invalid currency");
    expect(patchesOf(fetchMock)).toHaveLength(0);
  });

  it("leads an owned copy with its verdict, never a cheap listing (the buy side is watchlist-only)", async () => {
    // Jurassic Park carries all three directions: the flip and the
    // overpriced-store warning render — you already own the copy, so a
    // cheap listing (UNDERPRICED) is no alert and its 🛒 pill is excluded.
    const withSignals: CollectionResponse = {
      ...collection,
      items: [
        {
          ...collection.items[0],
          signals: [
            {
              type: "FLIP",
              reasoning: "PAL/cib: CeX UK voucher £50 vs eBay UK median £32",
              buySource: "ebay_uk",
              sellSource: "cex",
            },
            { type: "UNDERPRICED", reasoning: "cheap listing", source: "ebay_uk" },
            { type: "OVERPRICED_STORE", reasoning: "CeX sells £60 vs median £32", source: "cex" },
          ],
        },
        collection.items[1],
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withSignals))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // one verdict line beside the value, worded from the source fields
    const row = screen.getByText("Jurassic Park").closest(".ui-swipe") as HTMLElement;
    expect(within(row).getByText("Flip: buy on eBay UK, sell to CeX UK")).toBeInTheDocument();
    expect(screen.queryByText(/^Buy on/)).not.toBeInTheDocument();
    // signal-less item: no verdict line at all
    const quiet = screen.getByText("Panzer Dragoon Saga").closest(".ui-swipe") as HTMLElement;
    expect(quiet.querySelector(".verdict-line")).toBeNull();
  });

  it("leads with the high-confidence profit and counts the potential one", async () => {
    // Part P placement rule: the collection ADDS PROFIT to flips and
    // overpriced-store warnings; a cheap listing stays a watchlist-only pill
    const withProfit: CollectionResponse = {
      ...collection,
      items: [
        {
          ...collection.items[0],
          signals: [
            {
              type: "PROFIT",
              reasoning: "PAL/cib: CeX pays voucher £44 vs paid £12 — trade in at CeX",
              sellSource: "cex",
              gainUsd: 42.5,
              confidence: "high",
              caveats: [],
            },
            {
              type: "PROFIT",
              reasoning: "PAL/cib: eBay UK active median £60 (11 listings) → ≈£52.20 after fees vs paid £12 — sell on eBay UK",
              sellSource: "ebay_uk",
              gainUsd: 53.1,
              confidence: "potential",
              caveats: ["listing price, not a sale; fees estimated"],
            },
            { type: "UNDERPRICED", reasoning: "cheap listing", source: "ebay_uk" },
          ],
        },
        collection.items[1],
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(withProfit))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    const row = screen.getByText("Jurassic Park").closest(".ui-swipe") as HTMLElement;
    // the high profit leads; the fee-netted listing reading is potential:
    // counted, not shown (the visibility rule)
    expect(within(row).getByText("Sell to CeX UK")).toBeInTheDocument();
    expect(within(row).queryByText(/eBay UK/)).toBeNull();
    expect(within(row).getByText("+1 possible")).toBeInTheDocument();
    expect(screen.queryByText(/^Buy on/)).not.toBeInTheDocument();
    // one line: the reasoning never leaks into the row
    expect(within(row).queryByText(/trade in at CeX/)).toBeNull();
  });

  it("two payouts of one shop still lead with one verdict line (R4)", async () => {
    // ruling R4 ("ideally separate them", 2026-09-02): the route emits one
    // PROFIT per (source, kind); the pills name the instrument, so a store-
    // credit gain and a cash gain never collapse into one anonymous pill
    const twoInstruments: CollectionResponse = {
      ...collection,
      items: [
        {
          ...collection.items[0],
          signals: [
            {
              type: "PROFIT",
              reasoning: "PAL/cib: CeX pays voucher £48 vs paid £12 — trade in at CeX",
              sellSource: "cex",
              sellKind: "voucher",
              gainUsd: 36,
              confidence: "high",
              caveats: [],
            },
            {
              type: "PROFIT",
              reasoning: "PAL/cib: CeX pays cash £34 vs paid £12 — trade in at CeX",
              sellSource: "cex",
              sellKind: "cash",
              gainUsd: 22,
              confidence: "high",
              caveats: [],
            },
          ],
        },
        collection.items[1],
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(twoInstruments))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    const row = screen.getByText("Jurassic Park").closest(".ui-swipe") as HTMLElement;
    // the verdict is one line; the instruments are on the game page
    expect(within(row).getAllByText("Sell to CeX UK")).toHaveLength(1);
  });

  it("re-tiers a copy through the editor's Condition select (PATCH {condition}) and reloads", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(collection));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // the list carries no editor controls
    // Assertion changed with the copy-editor spec (2026-09-02): the loose
    // per-card Condition select became the editor's; the write goes out on
    // Save, still as exactly {condition} for this copy's route
    expect(screen.queryAllByLabelText(/condition/i, { selector: "select" })).toHaveLength(0);
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const select = within(editor).getByLabelText(/condition/i, { selector: "select" }) as HTMLSelectElement;
    // Jurassic Park is stored as cib; the tier below it is offered
    expect(select.value).toBe("cib");
    expect([...select.options].map((o) => o.value)).toContain("boxed_no_manual");
    await userEvent.selectOptions(select, "boxed_no_manual");
    expect(patchesOf(fetchMock)).toHaveLength(0);
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const patches = patchesOf(fetchMock);
      expect(patches).toHaveLength(1);
      expect(String(patches[0][0])).toContain("/api/collection/1");
      expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ condition: "boxed_no_manual" });
    });
    // reload after the write: the collection GET runs again
    await waitFor(() => expect(collectionGetsOf(fetchMock).length).toBeGreaterThanOrEqual(2));
  });

  it("the editor's grade slider shows the stored grade, parks an unset one at position 3 with — and NEVER writes untouched", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // Assertion changed with the copy-editor spec (2026-09-02): one slider
    // per OPEN editor instead of one per card; the no-write-until-touched
    // rule now reads "Save with an untouched slider sends nothing"
    expect(screen.queryAllByLabelText("Grade")).toHaveLength(0);
    let editor = await openEditor("Edit copy Jurassic Park PAL cib");
    let slider = within(editor).getByLabelText("Grade") as HTMLInputElement;
    // Jurassic Park: unset grade -> thumb parked at "good" but label stays —
    expect(slider.value).toBe("3");
    expect(slider.closest("label")?.textContent).toContain("—");
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
    // Sonic: stored near_mint -> position 4, human label
    editor = await openEditor("Edit copy Sonic the Hedgehog PAL loose");
    slider = within(editor).getByLabelText("Grade") as HTMLInputElement;
    expect(slider.value).toBe("4");
    expect(slider.closest("label")?.textContent).toContain("near mint");
    // rendering, opening and saving untouched must never PATCH a grade the
    // user did not choose (the editor has no timer: nothing to wait for)
    expect(patchesOf(fetchMock)).toHaveLength(0);
  });

  it("moving the grade slider writes once, on Save, with the final grade", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(collection));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // Assertion changed with the copy-editor spec (2026-09-02): the debounced
    // per-move PATCH became the editor's explicit Save — a drag across two
    // steps still lands as ONE write carrying only the settled value
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const slider = within(editor).getByLabelText("Grade") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "4" } });
    fireEvent.change(slider, { target: { value: "5" } });
    // the label follows the thumb before anything is written
    expect(slider.closest("label")?.textContent).toContain("mint");
    expect(patchesOf(fetchMock)).toHaveLength(0);
    await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const patches = patchesOf(fetchMock);
      expect(patches).toHaveLength(1);
      expect(String(patches[0][0])).toContain("/api/collection/1");
      expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ itemGrade: "mint" });
    });
  });

  it("closing the editor sheet discards its unsaved edits: no PATCH, and it reopens as stored", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(collection));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // Assertion changed with the copy-editor spec (2026-09-02): the old
    // GradeControl flushed its pending debounced PATCH on unmount because a
    // slider move WAS the write. The editor writes only on Save, so leaving
    // it is Cancel: the moved slider is discarded, never written behind the
    // user's back
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const slider = within(editor).getByLabelText("Grade") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "4" } });
    fireEvent.change(slider, { target: { value: "5" } });
    await userEvent.keyboard("{Escape}");
    expect(patchesOf(fetchMock)).toHaveLength(0);
    // nothing is being edited, and the copy still reads as stored
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    const reopened = await openEditor("Edit copy Jurassic Park PAL cib");
    expect((within(reopened).getByLabelText("Grade") as HTMLInputElement).value).toBe("3");
    expect(within(reopened).getByLabelText("Grade").closest("label")?.textContent).toContain("—");
  });

  it("rejects 'Infinity' as a sold price without calling updateCopy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("prompt", vi.fn(() => "Infinity"));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    const editor = await openEditor("Edit copy Jurassic Park PAL cib");
    const select = within(editor).getByLabelText(/status/i) as HTMLSelectElement;
    await userEvent.selectOptions(select, "sold");
    await waitFor(() => expect(select.value).toBe("owned"));
    expect(alertMock).toHaveBeenCalledWith("Invalid price");
    expect(patchesOf(fetchMock)).toHaveLength(0);
  });
});

describe("CollectionScreen valuation basis", () => {
  /** the GET /api/collection URLs the screen requested, in order */
  function collectionGets(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>)
      .filter((c) => c[1]?.method === undefined && String(c[0]).startsWith("/api/collection?"))
      .map((c) => String(c[0]));
  }

  it("a copy without a value shows no sparkline", async () => {
    const unvalued = { ...collection, items: [{ ...collection.items[0], estimatedValueUsd: null }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith("/api/collection/sparklines")
          ? new Response(JSON.stringify({ days: 90, series: { 1: [{ day: "2026-10-01", usd: 10 }, { day: "2026-10-18", usd: 9 }] } }))
          : new Response(JSON.stringify(unvalued)),
      ),
    );
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector(".spark-change")).toBeNull();
  });

  it("collection rows use the screen's valuation basis for their sparkline", async () => {
    window.localStorage.setItem("valuationBasis", "trade_in");
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith("/api/collection/sparklines")
        ? new Response(JSON.stringify({ days: 90, series: { 1: [{ day: "2026-10-01", usd: 10 }, { day: "2026-10-18", usd: 9 }] } }))
        : new Response(JSON.stringify({ ...collection, valuationBasis: "trade_in" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    await waitFor(() => expect(document.querySelector(".spark-change")?.textContent).toBe("−10%"));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain("/api/collection/sparklines?valuation=trade_in");
  });

  // The two URLs below gained &country=&includeForeign= when the valuation
  // markets became a setting of their own: which markets may value a copy is
  // now the owner's call, so the screen states it on EVERY load instead of
  // letting the API's GB default stand in silently. The basis half of each
  // assertion is unchanged.
  it("requests the collection under the persisted basis", async () => {
    window.localStorage.setItem("valuationBasis", "trade_in");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ...collection, valuationBasis: "trade_in" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(collectionGets(fetchMock)).toEqual([
      "/api/collection?valuation=trade_in&country=GB&includeForeign=false",
    ]);
  });

  it("requests the market basis on first load and after an unknown stored value", async () => {
    window.localStorage.setItem("valuationBasis", "cex_sell");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(collectionGets(fetchMock)).toEqual([
      "/api/collection?valuation=market&country=GB&includeForeign=false",
    ]);
  });

  it("carries the persisted valuation markets, so a foreign price may value a copy", async () => {
    window.localStorage.setItem("valuationCountry", "ES");
    window.localStorage.setItem("valuationIncludeForeign", "true");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(collectionGets(fetchMock)).toEqual([
      "/api/collection?valuation=market&country=ES&includeForeign=true",
    ]);
  });

  it("falls back to the home-country reading when the stored country is unknown", async () => {
    window.localStorage.setItem("valuationCountry", "RU");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(collection)));
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    // a country this build has no market in must never reach the API, where
    // it would be a 400 and an empty collection screen
    expect(collectionGets(fetchMock)).toEqual([
      "/api/collection?valuation=market&country=GB&includeForeign=false",
    ]);
  });

  it("labels the totals with the basis AND the markets the response was computed under", async () => {
    // The label gained the markets half: a GB-only total and an all-countries
    // total are different money about the same copies, and the response now
    // echoes which one it is (valuationMarkets) rather than leaving the
    // reader to guess from a Settings screen two taps away.
    const tradeIn: CollectionResponse = { ...collection, valuationBasis: "trade_in" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(tradeIn))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(kpi(/^Value \(trade-in, United Kingdom\)$/)).toHaveTextContent("$58.00");
    expect(screen.queryByText(/^Value \(market,/)).not.toBeInTheDocument();
    cleanup();

    const replacement: CollectionResponse = { ...collection, valuationBasis: "replacement" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(replacement))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(kpi(/^Value \(replacement, United Kingdom\)$/)).toHaveTextContent("$58.00");
    cleanup();

    // includeForeign mixes countries on purpose, so the label names the
    // setting rather than asserting one country over a mixed sum
    const foreign: CollectionResponse = {
      ...collection,
      valuationMarkets: { country: "ES", includeForeign: true },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(foreign))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(kpi(/^Value \(market, all countries\)$/)).toHaveTextContent("$58.00");
    expect(screen.queryByText(/Spain/)).not.toBeInTheDocument();
  });

  it("tags each list row's value with the concrete reading behind it; no value stays —", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(collection))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    const rowOf = (title: string): HTMLElement =>
      screen.getByText(title).closest(".ui-swipe") as HTMLElement;
    // Jurassic Park: cex_sell -> the replacement reading, tagged "sell"
    expect(within(rowOf("Jurassic Park")).getByText("$38.00")).toBeInTheDocument();
    expect(within(rowOf("Jurassic Park")).getByText("sell · CeX UK")).toBeInTheDocument();
    // Sonic: ebay_median -> "market"
    expect(within(rowOf("Sonic the Hedgehog")).getByText("$20.00")).toBeInTheDocument();
    expect(within(rowOf("Sonic the Hedgehog")).getByText("market · eBay UK")).toBeInTheDocument();
    // Panzer Dragoon Saga: no value, no basis -> the honest dash and no tag
    expect(within(rowOf("Panzer Dragoon Saga")).getByText("—")).toBeInTheDocument();
    expect(within(rowOf("Panzer Dragoon Saga")).queryByText(/market|sell|voucher|cash/)).not.toBeInTheDocument();
  });

  it("tags a fallback-rung reading with the rung it borrowed", async () => {
    const viaRung: CollectionResponse = {
      ...collection,
      items: [{ ...collection.items[2], valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: true, viaUnknownRegion: false } }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(viaRung))));
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Sonic the Hedgehog");
    expect(screen.getByText("market · eBay UK (undeclared condition)")).toBeInTheDocument();
  });
});
