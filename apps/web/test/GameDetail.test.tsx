import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GameDetail } from "../src/screens/GameDetail.js";
import { resetMoneyForTests, setDisplayCurrency } from "../src/lib/money.js";
import { setSourcesForTests } from "../src/lib/sources.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";
import type {
  Signal,
  CollectionResponse,
  OwnedCopyDto,
  PricesResponse,
  SourceInfoDto,
  WatchlistResponse,
} from "@retrowatchdog/shared";
import { PROFIT_FEE_CAVEAT } from "@retrowatchdog/shared";

// All stored point values are USD (the app's base); priceOriginal carries the
// source's verbatim GBP evidence and is not rendered in the price table.
const prices: PricesResponse = {
  game: { id: 7, title: "Panzer Dragoon Saga", platform: "saturn", year: 1998, coverUrl: null },
  sources: [
    {
      source: "cex", status: "error", fetchedAt: "2026-08-29T10:00:00Z",
      points: [
        { source: "cex", kind: "sell", region: "PAL", condition: "cib", priceUsd: 450, priceOriginal: 355, currencyOriginal: "GBP", available: true },
        // sell-timing comparables for the two owned-copy fixtures below
        { source: "cex", kind: "voucher", region: "PAL", condition: "loose", priceUsd: 28, priceOriginal: 22, currencyOriginal: "GBP", available: true },
        { source: "cex", kind: "voucher", region: "PAL", condition: "cib", priceUsd: 80, priceOriginal: 63, currencyOriginal: "GBP", available: true },
      ],
    },
    {
      source: "ebay_uk", status: "ok", fetchedAt: "2026-08-30T10:00:00Z",
      points: [{ source: "ebay_uk", kind: "active_median", region: "PAL", condition: "cib", priceUsd: 330, priceOriginal: 260, currencyOriginal: "GBP", sampleSize: 7, available: null }],
      cheapestListings: [{ title: "PDS complete", priceUsd: 280, priceOriginal: 220, currencyOriginal: "GBP", condition: "cib", grade: "mint", url: "https://x" }],
    },
    { source: "pricecharting", status: "not_configured", points: [] },
  ],
  signals: [
    // reasoning quotes the comparison's own currency (GBP vs GBP) verbatim —
    // it must keep its £ whatever the display currency is
    { type: "OVERPRICED_STORE", reasoning: "PAL/cib: CeX UK sells at £450 vs eBay UK active median £330 (7 listings) — don't buy at CeX", source: "cex" },
  ],
  gamePriceMode: null,
};

const emptyCollection: CollectionResponse = {
  items: [], totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};
const emptyWatchlist: WatchlistResponse = { items: [] };

// Two owned copies of game 7, matching the extra cex voucher points above:
// loose/PAL paid $23 (voucher $28 -> +$5), cib/PAL paid $90 (voucher $80 -> −$10).
// Deltas run on the frozen USD legs; the paid text shows the GBP original.
const ownedCopyBase: Omit<OwnedCopyDto, "id" | "region" | "condition" | "acquiredPriceOriginal" | "acquiredPriceUsd"> = {
  game: prices.game, notes: null, acquiredAt: "2026-01-01", status: "owned",
  acquiredCurrency: "GBP",
  itemGrade: null, workingState: "working", authenticity: "genuine",
  acquiredSource: "ebay", acquiredUrl: null, acquisitionId: null,
  soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
  soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
  returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
  refundUsd: null, returnCostsUsd: null,
  estimatedValueUsd: null, valueBasis: null, valueFetchedAt: null,
  signals: [], matchBasis: null, matchScore: null,
};
const collectionWithCopies: CollectionResponse = {
  items: [
    { ...ownedCopyBase, id: 201, region: "PAL", condition: "loose", acquiredPriceOriginal: 23, acquiredPriceUsd: 23 },
    { ...ownedCopyBase, id: 202, region: "PAL", condition: "cib", acquiredPriceOriginal: 90, acquiredPriceUsd: 90 },
  ],
  totalEstimatedUsd: 0, totalPaidUsd: 113, totalRealizedUsd: 0, totalReturnedUsd: 0, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};

// Two copies, neither with a known paid price — the totals line must not
// render a fabricated "$0.00 -> $0.00 (+$0.00)" for these.
const collectionWithCopiesNoPaid: CollectionResponse = {
  items: [
    { ...ownedCopyBase, id: 301, region: "PAL", condition: "loose", acquiredCurrency: null, acquiredPriceOriginal: null, acquiredPriceUsd: null },
    { ...ownedCopyBase, id: 302, region: "PAL", condition: "cib", acquiredCurrency: null, acquiredPriceOriginal: null, acquiredPriceUsd: null },
  ],
  totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};

// Graded voucher SKUs (the real case: CeX "Mint" carts priced far above the
// plain SKU). cib has both a mint and an ungraded voucher; loose has ONLY a
// mint one — a plain loose copy must never inherit that number.
const gradedPrices: PricesResponse = {
  ...prices,
  sources: [
    {
      source: "cex", status: "ok", fetchedAt: "2026-08-31T05:00:00Z",
      points: [
        { source: "cex", kind: "voucher", region: "PAL", condition: "cib", priceUsd: 80, priceOriginal: 63, currencyOriginal: "GBP", available: true },
        { source: "cex", kind: "voucher", region: "PAL", condition: "cib", grade: "mint", priceUsd: 218, priceOriginal: 172, currencyOriginal: "GBP", available: true },
        { source: "cex", kind: "voucher", region: "PAL", condition: "loose", grade: "mint", priceUsd: 150, priceOriginal: 118, currencyOriginal: "GBP", available: true },
      ],
    },
    prices.sources[1],
    prices.sources[2],
  ],
};
const gradedCollection: CollectionResponse = {
  items: [
    // mint cib copy: entitled to the mint SKU
    { ...ownedCopyBase, id: 401, region: "PAL", condition: "cib", itemGrade: "mint", acquiredPriceOriginal: 100, acquiredPriceUsd: 100 },
    // good cib copy: only the ungraded voucher, never the mint premium
    { ...ownedCopyBase, id: 402, region: "PAL", condition: "cib", itemGrade: "good", acquiredPriceOriginal: 10, acquiredPriceUsd: 10 },
    // ungraded loose copy: the only loose voucher is mint-graded -> no comparable
    { ...ownedCopyBase, id: 403, region: "PAL", condition: "loose", acquiredPriceOriginal: null, acquiredPriceUsd: null },
  ],
  totalEstimatedUsd: 0, totalPaidUsd: 110, totalRealizedUsd: 0, totalReturnedUsd: 0, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};

// The boxed_no_manual tier (CeX "…, w/o Manual, Boxed"): a boxed copy missing
// its manual must be matched ONLY against same-tier vouchers — never the
// cib SKU CeX pays far more for. Fixture A carries only cib vouchers;
// fixture B adds the w/o-Manual voucher.
const cibOnlyVoucherPrices: PricesResponse = {
  ...prices,
  sources: [
    {
      source: "cex", status: "ok", fetchedAt: "2026-09-02T05:00:00Z",
      points: [
        { source: "cex", kind: "voucher", region: "PAL", condition: "cib", priceUsd: 80, priceOriginal: 63, currencyOriginal: "GBP", available: null },
      ],
    },
    prices.sources[1],
    prices.sources[2],
  ],
};
const bothTierVoucherPrices: PricesResponse = {
  ...cibOnlyVoucherPrices,
  sources: [
    {
      source: "cex", status: "ok", fetchedAt: "2026-09-02T05:00:00Z",
      points: [
        ...cibOnlyVoucherPrices.sources[0].points,
        { source: "cex", kind: "voucher", region: "PAL", condition: "boxed_no_manual", priceUsd: 52, priceOriginal: 41, currencyOriginal: "GBP", available: null },
      ],
    },
    prices.sources[1],
    prices.sources[2],
  ],
};
// one boxed_no_manual copy, no DTO estimate: the comparable is voucher-or-nothing
const boxedNoManualCollection: CollectionResponse = {
  items: [
    { ...ownedCopyBase, id: 501, region: "PAL", condition: "boxed_no_manual", acquiredPriceOriginal: 40, acquiredPriceUsd: 40 },
  ],
  totalEstimatedUsd: 0, totalPaidUsd: 40, totalRealizedUsd: 0, totalReturnedUsd: 0, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};

// A filtered (region=PAL) prices response whose cex block comes back empty —
// simulates the chip-filtered refetch that should NOT affect ownership comparables.
const pricesFilteredEmptyCex: PricesResponse = {
  ...prices,
  sources: [
    { source: "cex", status: "ok", fetchedAt: "2026-08-31T04:00:00Z", points: [] },
    prices.sources[1],
    prices.sources[2],
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  window.localStorage.clear(); // displayCurrency / lastPaidCurrency persist
});

/** Defaults /api/collection and /api/watchlist to empty fixtures so callers
 * that don't care about ownership (most existing tests) stay unaffected. */
function stubFetch(collection: CollectionResponse = emptyCollection): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    // POST checked first: addCopy/addWatch POST to the same base paths
    // ("/api/collection", "/api/watchlist") that GET reads below, so method
    // must disambiguate before the URL-only branches do.
    if (init?.method === "POST") return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    if (String(url).includes("/api/fx")) {
      const to = new URL(String(url), "http://test").searchParams.get("to");
      return new Response(JSON.stringify({ base: "USD", to, rate: 0.9, fetchedAt: new Date().toISOString(), mode: "auto" }));
    }
    if (String(url).includes("/prices")) return new Response(JSON.stringify(prices));
    if (String(url).includes("/history")) {
      return new Response(JSON.stringify({ region: "PAL", condition: "cib", days: 30, from: "2026-08-30", to: "2026-09-29", series: [] }));
    }
    if (String(url).includes("/collection")) return new Response(JSON.stringify(collection));
    if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GameDetail", () => {
  it("shows signals with reasoning, honest source states and the active-listings label", async () => {
    stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    expect(await screen.findByText(/don't buy at CeX/)).toBeInTheDocument();
    expect(screen.getByText(/source error/i)).toBeInTheDocument();          // cex broken, shown
    // dormant plugins are hidden, not announced: no "not configured" block
    expect(screen.queryByText(/not configured/i)).not.toBeInTheDocument(); // pricecharting
    expect(screen.getByText("eBay UK prices are active FIXED-PRICE listings, not sold prices.")).toBeInTheDocument();
    expect(screen.getByText(/^CeX UK sells for$/)).toBeInTheDocument();
    expect(screen.getByText("$450.00")).toBeInTheDocument();
  });

  it("renders prices in the display currency while signal reasoning keeps the source's £", async () => {
    stubFetch();
    await setDisplayCurrency("EUR"); // rate 0.9 from the stub
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    // 450 USD * 0.9 -> €405.00 in the price table
    expect(await screen.findByText("€405.00")).toBeInTheDocument();
    // evidence rule: the GBP-vs-GBP comparison keeps its verbatim £ amounts
    expect(screen.getByText(/CeX UK sells at £450 vs eBay UK active median £330/)).toBeInTheDocument();
    expect(screen.queryByText("$450.00")).not.toBeInTheDocument();
  });

  it("records an owned copy with amount + currency through the I-own-this form", async () => {
    const fetchMock = stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    await userEvent.click(screen.getByRole("button", { name: /i own this/i }));
    await userEvent.selectOptions(screen.getByLabelText(/region/i, { selector: "select" }), "PAL");
    await userEvent.selectOptions(screen.getByLabelText(/condition/i, { selector: "select" }), "cib");
    // currency select defaults to GBP (UK user) until a different pick is saved
    expect((screen.getByLabelText("Paid currency") as HTMLSelectElement).value).toBe("GBP");
    await userEvent.type(screen.getByLabelText("Paid"), "120");
    await userEvent.click(screen.getByRole("button", { name: /add to collection/i }));
    expect(await screen.findByText(/added to collection/i)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
      gameId: 7, region: "PAL", condition: "cib", acquiredPriceOriginal: 120, acquiredCurrency: "GBP",
    });
  });

  it("I own this opens the add sheet and closes it on success", async () => {
    stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    const panel = screen.getByRole("heading", { name: /^Your copies/ }).closest("section") as HTMLElement;
    await userEvent.click(within(panel).getByRole("button", { name: "+ I own this" }));
    const sheet = screen.getByRole("dialog", { name: "Add a copy" });
    await userEvent.click(within(sheet).getByRole("button", { name: /add to collection/i }));
    expect(await screen.findByText(/added to collection/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Add a copy" })).toBeNull();
  });

  it("the add sheet offers only the enabled currencies", async () => {
    stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    const panel = screen.getByRole("heading", { name: /^Your copies/ }).closest("section") as HTMLElement;
    await userEvent.click(within(panel).getByRole("button", { name: "+ I own this" }));
    const select = within(screen.getByRole("dialog", { name: "Add a copy" })).getByRole("combobox", { name: "Paid currency" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["USD", "GBP", "EUR", "JPY", "CHF", "CAD", "AUD"]);
  });

  it("omits itemGrade from the add-copy POST when the grade slider was never touched", async () => {
    const fetchMock = stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    await userEvent.click(screen.getByRole("button", { name: /i own this/i }));
    // untouched slider: parked at position 3 but labeled — (no chosen grade)
    const slider = screen.getByLabelText("Grade") as HTMLInputElement;
    expect(slider.value).toBe("3");
    expect(slider.closest("label")?.textContent).toContain("—");
    await userEvent.click(screen.getByRole("button", { name: /add to collection/i }));
    await screen.findByText(/added to collection/i);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    const body = JSON.parse(String((post![1] as RequestInit).body)) as Record<string, unknown>;
    expect("itemGrade" in body).toBe(false);
  });

  it("includes the chosen itemGrade in the add-copy POST once the slider is moved", async () => {
    const fetchMock = stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    await userEvent.click(screen.getByRole("button", { name: /i own this/i }));
    const slider = screen.getByLabelText("Grade") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "5" } });
    expect(slider.closest("label")?.textContent).toContain("mint");
    await userEvent.click(screen.getByRole("button", { name: /add to collection/i }));
    await screen.findByText(/added to collection/i);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
      gameId: 7, itemGrade: "mint",
    });
  });

  it("records a copy paid in EUR and remembers the currency for next time", async () => {
    const fetchMock = stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    await userEvent.click(screen.getByRole("button", { name: /i own this/i }));
    await userEvent.selectOptions(screen.getByLabelText("Paid currency"), "EUR");
    await userEvent.type(screen.getByLabelText("Paid"), "25");
    await userEvent.click(screen.getByRole("button", { name: /add to collection/i }));
    expect(await screen.findByText(/added to collection/i)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
      acquiredPriceOriginal: 25, acquiredCurrency: "EUR",
    });
    expect(window.localStorage.getItem("lastPaidCurrency")).toBe("EUR");
  });

  it("surfaces the FX-down 503 from a paid add instead of pretending it saved", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "FX rate for EUR is unavailable" }), { status: 503 });
      }
      if (String(url).includes("/prices")) return new Response(JSON.stringify(prices));
      if (String(url).includes("/collection")) return new Response(JSON.stringify(emptyCollection));
      if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    await userEvent.click(screen.getByRole("button", { name: /i own this/i }));
    await userEvent.selectOptions(screen.getByLabelText("Paid currency"), "EUR");
    await userEvent.type(screen.getByLabelText("Paid"), "25");
    await userEvent.click(screen.getByRole("button", { name: /add to collection/i }));
    expect(
      await screen.findByText("API 503 adding copy: FX rate for EUR is unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/added to collection/i)).not.toBeInTheDocument();
    // nothing saved: the last-pick currency must not update either
    expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
  });

  it("shows an ownership panel with per-copy sell-timing deltas and a totals line", async () => {
    stubFetch(collectionWithCopies);
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);

    expect(await screen.findByRole("heading", { name: "Your copies (2)" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
    // loose/PAL: paid $23, CeX UK pays voucher $28 -> +$5 gain
    expect(screen.getByText(/\+\$5\.00/)).toBeInTheDocument();
    // cib/PAL: paid $90, CeX UK pays voucher $80 -> −$10 loss
    expect(screen.getByText(/−\$10\.00/)).toBeInTheDocument();
    expect(screen.getByText(/^CeX UK pays voucher \$28\.00$/)).toBeInTheDocument();
    expect(screen.getByText(/^CeX UK pays voucher \$80\.00$/)).toBeInTheDocument();
    // the paid legs stay verbatim originals (GBP), not display conversions
    expect(screen.getByText(/paid £23\.00/)).toBeInTheDocument();
    expect(screen.getByText(/paid £90\.00/)).toBeInTheDocument();
    // totals: paid 23+90=113, current 28+80=108, delta -5 (all USD)
    expect(screen.getByText(/total paid \$113\.00 → \$108\.00 \(−\$5\.00\)/)).toBeInTheDocument();
  });

  it("matches graded voucher SKUs honestly: mint copy gets the mint SKU, others never inherit it", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      if (String(url).includes("/prices")) return new Response(JSON.stringify(gradedPrices));
      if (String(url).includes("/collection")) return new Response(JSON.stringify(gradedCollection));
      if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Your copies (3)" });
    await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());

    // mint cib copy: the mint SKU, labeled as such
    expect(screen.getByText(/^CeX UK pays voucher \(mint\) \$218\.00$/)).toBeInTheDocument();
    // good cib copy: only the ungraded voucher (today's label), not $218
    expect(screen.getByText(/^CeX UK pays voucher \$80\.00$/)).toBeInTheDocument();
    // ungraded loose copy: its ONLY voucher is mint-graded -> no voucher
    // comparable and no estimate either, so the honest — (never $150). The
    // mint voucher itself is still listed in the price table, as a payout.
    const copies = screen.getByRole("heading", { name: "Your copies (3)" }).closest("section") as HTMLElement;
    expect(within(copies).queryByText(/\$150\.00/)).not.toBeInTheDocument();
    expect(within(copies).getByText("—")).toBeInTheDocument();
    // totals exclude the comparable-less copy: paid 110 -> current 298
    expect(screen.getByText(/total paid \$110\.00 → \$298\.00 \(\+\$188\.00\)/)).toBeInTheDocument();
  });

  describe("boxed_no_manual copies (condition fail-safe)", () => {
    function stubOwnership(response: PricesResponse): void {
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        if (String(url).includes("/prices")) return new Response(JSON.stringify(response));
        if (String(url).includes("/collection")) return new Response(JSON.stringify(boxedNoManualCollection));
        if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      vi.stubGlobal("fetch", fetchMock);
    }

    it("never borrows a cib voucher: with only cib vouchers the copy shows — (no delta, no totals)", async () => {
      stubOwnership(cibOnlyVoucherPrices);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const own = (await screen.findByRole("heading", { name: "Your copies (1)" })).closest("section") as HTMLElement;
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(within(own).getByText(/PAL · boxed_no_manual/)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      // the $80 cib voucher must not surface as this copy's comparable
      expect(screen.queryByText(/^CeX UK pays voucher \$80\.00$/)).not.toBeInTheDocument();
      expect(screen.getByText("—")).toBeInTheDocument();
      expect(screen.queryByText(/▲|▼/)).not.toBeInTheDocument();
      expect(screen.queryByText(/total paid/)).not.toBeInTheDocument();
    });

    it("uses its own tier's voucher when one exists", async () => {
      stubOwnership(bothTierVoucherPrices);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (1)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      // the w/o-Manual voucher ($52), not the cib one ($80); paid $40 -> +$12
      expect(screen.getByText(/^CeX UK pays voucher \$52\.00$/)).toBeInTheDocument();
      expect(screen.getByText(/\+\$12\.00/)).toBeInTheDocument();
      expect(screen.queryByText(/^CeX UK pays voucher \$80\.00$/)).not.toBeInTheDocument();
    });

    it("offers the tier in the add-copy form and POSTs it verbatim", async () => {
      const fetchMock = stubFetch();
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByText(/don't buy at CeX/);
      await userEvent.click(screen.getByRole("button", { name: /i own this/i }));
      await userEvent.selectOptions(screen.getByLabelText(/condition/i, { selector: "select" }), "boxed_no_manual");
      await userEvent.click(screen.getByRole("button", { name: /add to collection/i }));
      await screen.findByText(/added to collection/i);
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
        gameId: 7, condition: "boxed_no_manual",
      });
    });

    it("has a boxed_no_manual chip in the price-table condition filter", async () => {
      const fetchMock = stubFetch();
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByText(/don't buy at CeX/);
      await userEvent.click(screen.getByRole("button", { name: "boxed_no_manual" }));
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes("condition=boxed_no_manual"))).toBe(true),
      );
    });
  });

  describe("live-bid comparable (role, not the literal kind 'voucher')", () => {
    // a plugin shop that pays in cash rather than store credit, but still
    // trades both directions (sell + bid), so it clears hasBothTradeSides
    // and its points reach the ownership panel's pool
    const shopGb: SourceInfoDto = {
      id: "shop_gb",
      label: "Shop GB",
      family: "shop_gb",
      familyLabel: "Shop GB",
      kind: "live",
      country: "GB",
      reach: "local",
      defaultRegion: "PAL",
      expectedCurrencies: ["GBP"],
      // no declared kindLabels: this shop leans on the app's generic
      // fallback ("Shop GB" + "pays cash"/"pays voucher"), same as any
      // plugin that names its payout kinds but never bothers wording them
      kindRoles: { sell: "buy_store", cash: "bid" },
      configured: true,
      origin: "plugin",
      pluginId: 9,
    };
    const shopGbOwnedCollection: CollectionResponse = {
      items: [{ ...ownedCopyBase, id: 601, region: "PAL", condition: "loose", acquiredPriceOriginal: null, acquiredPriceUsd: null }],
      totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
    };

    function stubShopPrices(response: PricesResponse, collection: CollectionResponse): void {
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        if (String(url).includes("/prices")) return new Response(JSON.stringify(response));
        if (String(url).includes("/collection")) return new Response(JSON.stringify(collection));
        if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      vi.stubGlobal("fetch", fetchMock);
    }

    it("values a copy from a cash payout when that is the only bid the shop quotes", async () => {
      // The rung is a role, not an instrument. A shop that pays cash and not
      // store credit is still quoting a payout, and the panel used to say "—".
      setSourcesForTests([...SOURCES_FIXTURE, shopGb]);
      stubShopPrices(
        {
          ...prices,
          signals: [],
          sources: [
            {
              source: "shop_gb", status: "ok", fetchedAt: "2026-09-08T10:00:00Z",
              points: [
                { source: "shop_gb", kind: "cash", region: "PAL", condition: "loose", priceUsd: 31, priceOriginal: 25, currencyOriginal: "GBP", available: true },
              ],
            },
          ],
        },
        shopGbOwnedCollection,
      );
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (1)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(await screen.findByText(/^Shop GB pays cash \$31\.00$/)).toBeInTheDocument();
    });

    it("takes the highest bid when a shop quotes several kinds, named for what it actually is", async () => {
      // cash is the HIGHER quote here on purpose: proves the winner is
      // chosen by amount, the same rung PROFIT uses, never by a kind the
      // code favours (the old code favoured "voucher" by hardcoding it).
      setSourcesForTests([
        ...SOURCES_FIXTURE,
        { ...shopGb, kindRoles: { sell: "buy_store", cash: "bid", voucher: "bid" } },
      ]);
      stubShopPrices(
        {
          ...prices,
          signals: [],
          sources: [
            {
              source: "shop_gb", status: "ok", fetchedAt: "2026-09-08T10:00:00Z",
              points: [
                { source: "shop_gb", kind: "cash", region: "PAL", condition: "loose", priceUsd: 52, priceOriginal: 41, currencyOriginal: "GBP", available: true },
                { source: "shop_gb", kind: "voucher", region: "PAL", condition: "loose", priceUsd: 40, priceOriginal: 32, currencyOriginal: "GBP", available: true },
              ],
            },
          ],
        },
        shopGbOwnedCollection,
      );
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (1)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(await screen.findByText(/^Shop GB pays cash \$52\.00$/)).toBeInTheDocument();
      expect(screen.queryByText(/^Shop GB pays voucher \$40\.00$/)).not.toBeInTheDocument();
    });
  });

  describe("ownership panel comparable (multi-source, from the DTO's PROFIT signals)", () => {
    // the collection route's per-copy PROFIT signals: a CeX bid reading
    // (high) and a fee-netted eBay listing reading (potential, larger gain)
    const cexBidProfit = {
      type: "PROFIT" as const,
      reasoning: "PAL/loose: CeX pays voucher £22 vs paid £23 — trade in at CeX",
      sellSource: "cex" as const,
      sellKind: "voucher" as const,
      gainUsd: 5,
      // the reading itself, as the engine emitted it: no client-side maths
      price: { usd: 28, original: 22, currency: "GBP" },
      confidence: "high" as const,
      caveats: [],
    };
    const ebayNetProfit = {
      type: "PROFIT" as const,
      reasoning: "PAL/loose: eBay UK active median £32 (11 listings) → ≈£27.84 after fees vs paid £23 — sell on eBay UK",
      sellSource: "ebay_uk" as const,
      sellKind: "active_median" as const,
      gainUsd: 12.5,
      price: { usd: 35.5, original: 27.84, currency: "GBP" },
      confidence: "potential" as const,
      caveats: [PROFIT_FEE_CAVEAT],
    };

    function stubOwnership(collection: CollectionResponse): void {
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        if (String(url).includes("/api/fx")) {
          return new Response(JSON.stringify({ base: "USD", to: "GBP", rate: 0.79, fetchedAt: null, mode: "auto" }));
        }
        if (String(url).includes("/prices")) return new Response(JSON.stringify(prices));
        if (String(url).includes("/collection")) return new Response(JSON.stringify(collection));
        if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      vi.stubGlobal("fetch", fetchMock);
    }

    it("prefers the copy's best PROFIT (highest gain): source label, net value, '(after fees)' for a fee-netted reading", async () => {
      stubOwnership({
        ...collectionWithCopies,
        items: [
          // loose/PAL paid $23: eBay nets 23 + 12.5 = $35.50 and beats the CeX $28 bid
          { ...collectionWithCopies.items[0], signals: [cexBidProfit, ebayNetProfit] },
          // cib/PAL paid $90: no PROFIT -> today's voucher fallback ($80, −$10)
          collectionWithCopies.items[1],
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(await screen.findByText(/^eBay UK \$35\.50 \(after fees\)$/)).toBeInTheDocument();
      expect(screen.getByText(/\+\$12\.50/)).toBeInTheDocument();
      // the engine marked the listing reading potential: the panel says so
      // exactly like the compact pill does, instead of a bare solid number.
      // The fee caveat itself is already expressed by "(after fees)", so it
      // is not repeated as a note.
      const marker = screen.getByText(/❓ potential/);
      expect(marker).toHaveClass("confidence-marker");
      expect(marker).not.toHaveTextContent(/listing price/);
      // the lower CeX reading is not the comparable, under ANY of its three
      // possible label forms: the bare source (no sellKind), the instrument
      // form (profitInstrument), or rung 2's declared kindLabel. The third
      // assertion matters on its own: a leak that fell through to rung 2
      // would render "CeX UK pays voucher $28.00", which neither of the
      // first two regexes catches — "pays voucher" sits between "CeX UK" and
      // the amount in that string, so neither is a substring of it.
      expect(screen.queryByText(/^CeX UK \$28\.00$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^CeX UK voucher \$28\.00$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^CeX UK pays voucher \$28\.00$/)).not.toBeInTheDocument();
      // the copy without a PROFIT keeps the voucher comparable, source-labelled
      // and, being a live point with no confidence dimension, unmarked
      expect(screen.getByText(/^CeX UK pays voucher \$80\.00$/)).toBeInTheDocument();
      expect(screen.getAllByText(/❓ potential/)).toHaveLength(1);
      expect(screen.getByText(/−\$10\.00/)).toBeInTheDocument();
      // totals follow the readings actually shown: 23+90 -> 35.5+80
      expect(screen.getByText(/total paid \$113\.00 → \$115\.50 \(\+\$2\.50\)/)).toBeInTheDocument();
    });

    it("labels a bid-based PROFIT with its source AND instrument — a voucher gain is store credit — no fee suffix, no fee maths client-side", async () => {
      stubOwnership({
        ...collectionWithCopies,
        items: [
          { ...collectionWithCopies.items[0], signals: [cexBidProfit] },
          collectionWithCopies.items[1],
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      // value = paid $23 + gain $5, read from the signal, not recomputed.
      // Assertion changed with the sellKind payload field (review finding:
      // the dedupe usually picks the voucher, so a source-only "CeX $28.00"
      // presented store credit like money): the label now names the
      // instrument, via profitInstrument's bare word — a PROFIT reading's own
      // wording, kept separate from the live-bid rung's declared label below.
      expect(screen.getByText(/^CeX UK voucher \$28\.00$/)).toBeInTheDocument();
      expect(screen.queryByText(/^CeX UK \$28\.00$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/after fees/)).not.toBeInTheDocument();
      // a high-confidence bid reading carries no marker
      expect(screen.queryByText(/❓ potential/)).not.toBeInTheDocument();
      expect(screen.getByText(/\+\$5\.00/)).toBeInTheDocument();
    });

    it("reads the delta from the signal's own gainUsd, never recomputed from value minus paid", async () => {
      // gainUsd is DELIBERATELY not price.usd - acquiredPriceUsd (28 - 23 =
      // 5, not 5.42): if the panel ever goes back to recomputing the delta
      // by subtraction, this shows +$5.00 instead of the engine's own
      // +$5.42, and the compact PROFIT pill elsewhere (SignalBadge.tsx,
      // which reads gainUsd directly) would then disagree with this panel
      // at a rounding boundary — the bug this test guards against.
      stubOwnership({
        ...collectionWithCopies,
        items: [
          { ...collectionWithCopies.items[0], signals: [{ ...cexBidProfit, gainUsd: 5.42 }] },
          collectionWithCopies.items[1],
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(screen.getByText(/\+\$5\.42/)).toBeInTheDocument();
      expect(screen.queryByText(/\+\$5\.00/)).not.toBeInTheDocument();
    });

    it("falls back to the source alone for a PROFIT payload that carries no sellKind", async () => {
      stubOwnership({
        ...collectionWithCopies,
        items: [
          { ...collectionWithCopies.items[0], signals: [{ ...cexBidProfit, sellKind: undefined }] },
          collectionWithCopies.items[1],
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      // an older payload without the instrument still renders honestly: the
      // source and the value, never a guessed instrument
      expect(screen.getByText(/^CeX UK \$28\.00$/)).toBeInTheDocument();
      expect(screen.queryByText(/^CeX UK voucher \$28\.00$/)).not.toBeInTheDocument();
    });

    it("marks a candidate-linked copy's PROFIT potential and shows why, agreeing with the collection row's dashed pill", async () => {
      // the collection route forces every signal of a candidate-linked copy
      // to potential with this caveat; the panel must not present the same
      // number as certain
      const unconfirmed = {
        ...cexBidProfit,
        confidence: "potential" as const,
        caveats: ["match not confirmed — review the link"],
      };
      stubOwnership({
        ...collectionWithCopies,
        items: [
          { ...collectionWithCopies.items[0], matchBasis: "candidate", matchScore: 0.62, signals: [unconfirmed] },
          collectionWithCopies.items[1],
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(screen.getByText(/^CeX UK voucher \$28\.00$/)).toBeInTheDocument();
      const marker = screen.getByText(/❓ potential/);
      expect(marker).toHaveClass("confidence-marker");
      // the non-fee caveat is spelled out beside the marker, not hidden in a tooltip
      expect(marker).toHaveTextContent("❓ potential: match not confirmed — review the link");
      // the delta still renders from the reading (the number is not invented, only uncertain)
      expect(screen.getByText(/\+\$5\.00/)).toBeInTheDocument();
    });

    it("ignores a PROFIT with no price, or on a copy with no paid price, rather than inventing a value", async () => {
      stubOwnership({
        ...collectionWithCopies,
        items: [
          // an older payload with no price: there is nothing to read, and the
          // panel must not reconstruct one from the gain. ebayNetProfit, not
          // cexBidProfit, on purpose — see the note below.
          { ...collectionWithCopies.items[0], signals: [{ ...ebayNetProfit, price: undefined }] },
          // no paid price at all: the engine never fires PROFIT here, but a
          // stray one must not turn into a number either
          { ...collectionWithCopies.items[1], acquiredPriceOriginal: null, acquiredPriceUsd: null, signals: [ebayNetProfit] },
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      // both fall through to the voucher comparables
      expect(await screen.findByText(/^CeX UK pays voucher \$28\.00$/)).toBeInTheDocument();
      expect(screen.getByText(/^CeX UK pays voucher \$80\.00$/)).toBeInTheDocument();
      // the two things only the deleted arithmetic can print: 23 + 12.5
      expect(screen.queryByText(/after fees/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^eBay UK \$35\.50 \(after fees\)$/)).not.toBeInTheDocument();
    });

    it("shows the reading's own currency verbatim when it IS the display currency", async () => {
      // £27.84 is what the engine netted and what the reasoning quotes. Round
      // -tripping $35.50 back through a rate would print a price nobody named.
      // ORDER MATTERS: stub, THEN switch currency, THEN render.
      stubOwnership({
        ...collectionWithCopies,
        items: [
          { ...collectionWithCopies.items[0], signals: [ebayNetProfit] },
          collectionWithCopies.items[1],
        ],
      });
      await setDisplayCurrency("GBP");
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(await screen.findByText(/^eBay UK £27\.84 \(after fees\)$/)).toBeInTheDocument();
    });
  });

  describe("ownership panel copy editor (copy-editor spec, 2026-09-02)", () => {
    type FetchCall = [RequestInfo | URL, RequestInit | undefined];
    const patchesOf = (fetchMock: ReturnType<typeof vi.fn>) =>
      (fetchMock.mock.calls as unknown as FetchCall[])
        .filter((c) => c[1]?.method === "PATCH")
        .map((c) => ({ url: String(c[0]), body: JSON.parse(String(c[1]?.body)) as unknown }));

    // after the edit: copy 201 paid £12.50, frozen server-side at $15.50 —
    // the client never derives that twin, it reads it back from the reload
    const collectionAfterEdit: CollectionResponse = {
      ...collectionWithCopies,
      items: [
        { ...collectionWithCopies.items[0], acquiredPriceOriginal: 12.5, acquiredPriceUsd: 15.5 },
        collectionWithCopies.items[1],
      ],
      totalPaidUsd: 105.5,
    };

    /** PATCH answers as given; the collection GET serves `before` once, then `after` */
    function stubEdit(
      patch: { status: number; body?: unknown },
      before: CollectionResponse,
      after: CollectionResponse,
    ): ReturnType<typeof vi.fn> {
      let collectionGets = 0;
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return new Response(patch.body === undefined ? null : JSON.stringify(patch.body), { status: patch.status });
        }
        if (String(url).includes("/prices")) return new Response(JSON.stringify(prices));
        if (String(url).includes("/collection")) {
          collectionGets += 1;
          return new Response(JSON.stringify(collectionGets === 1 ? before : after));
        }
        if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("shows an ✎ edit button per own-row and opens one editor at a time, in a sheet", async () => {
      stubFetch(collectionWithCopies);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      const editLoose = screen.getByRole("button", { name: "Edit copy PAL loose" });
      const editCib = screen.getByRole("button", { name: "Edit copy PAL cib" });
      expect(editLoose).toHaveTextContent("✎ edit");
      expect(screen.queryByRole("form")).not.toBeInTheDocument();

      await userEvent.click(editLoose);
      const looseEditor = screen.getByRole("form", { name: "Edit copy PAL loose" });
      // the editor shows the copy's own verbatim paid original, not a conversion
      expect((within(looseEditor).getByLabelText("Paid") as HTMLInputElement).value).toBe("23");
      expect((within(looseEditor).getByLabelText("Paid currency") as HTMLSelectElement).value).toBe("GBP");
      // rendered in a sheet named for the copy it edits
      expect(looseEditor.closest("[role=dialog]")).toHaveAccessibleName("Edit copy PAL loose");

      // opening the other copy's editor closes the first
      await userEvent.click(editCib);
      expect(screen.getAllByRole("form")).toHaveLength(1);
      const cibEditor = screen.getByRole("form", { name: "Edit copy PAL cib" });
      expect((within(cibEditor).getByLabelText("Paid") as HTMLInputElement).value).toBe("90");

      // the button toggles its own editor closed
      await userEvent.click(editCib);
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
    });

    it("edit opens the copy editor in a sheet", async () => {
      stubFetch(collectionWithCopies);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Edit copy PAL loose" }));
      const sheet = screen.getByRole("dialog", { name: "Edit copy PAL loose" });
      expect(within(sheet).getByRole("form", { name: "Edit copy PAL loose" })).toBeInTheDocument();
    });

    it("numbers the edit buttons of same-tier siblings (#1, #2) and names the editor the same way; a unique tier keeps the spec's exact string", async () => {
      // two PAL loose copies of one game (duplicates kept for trading): the
      // spec's "Edit copy PAL loose" alone would name both rows identically
      const collectionWithTwinLoose: CollectionResponse = {
        ...collectionWithCopies,
        items: [
          collectionWithCopies.items[0],
          { ...ownedCopyBase, id: 203, region: "PAL", condition: "loose", acquiredPriceOriginal: 15, acquiredPriceUsd: 15 },
          collectionWithCopies.items[1],
        ],
        totalPaidUsd: 128,
      };
      stubFetch(collectionWithTwinLoose);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (3)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(screen.getByRole("button", { name: "Edit copy PAL loose #1" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit copy PAL loose #2" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit copy PAL loose" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit copy PAL cib" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Edit copy PAL loose #2" }));
      const editor = screen.getByRole("form", { name: "Edit copy PAL loose #2" });
      expect((within(editor).getByLabelText("Paid") as HTMLInputElement).value).toBe("15");
    });

    it("Save PATCHes only the changed paid leg, reloads the copies and the row shows the new verbatim original with a fresh delta", async () => {
      const fetchMock = stubEdit({ status: 204 }, collectionWithCopies, collectionAfterEdit);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      expect(screen.getByText(/paid £23\.00/)).toBeInTheDocument();
      expect(screen.getByText(/\+\$5\.00/)).toBeInTheDocument(); // voucher $28 − paid $23

      await userEvent.click(screen.getByRole("button", { name: "Edit copy PAL loose" }));
      const editor = screen.getByRole("form", { name: "Edit copy PAL loose" });
      await userEvent.clear(within(editor).getByLabelText("Paid"));
      await userEvent.type(within(editor).getByLabelText("Paid"), "12.5");
      await userEvent.click(within(editor).getByRole("button", { name: "Save" }));

      // exactly the paid leg, to this copy's route; no USD twin from the client
      await waitFor(() =>
        expect(patchesOf(fetchMock)).toEqual([
          { url: "/api/collection/201", body: { acquiredPriceOriginal: 12.5, acquiredCurrency: "GBP" } },
        ]),
      );
      // the panel reloaded: the editor closed, the row shows the new verbatim
      // original, and the comparable reading follows the fresh frozen twin
      // (voucher $28 − paid $15.50 = +$12.50)
      expect(await screen.findByText(/paid £12\.50/)).toBeInTheDocument();
      expect(screen.queryByText(/paid £23\.00/)).not.toBeInTheDocument();
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      expect(screen.getByText(/\+\$12\.50/)).toBeInTheDocument();
      expect(screen.getByText(/total paid \$105\.50 → \$108\.00 \(\+\$2\.50\)/)).toBeInTheDocument();
      // a recorded paid leg makes its currency the next default, as the add form does
      expect(window.localStorage.getItem("lastPaidCurrency")).toBe("GBP");
    });

    it("surfaces the server's {error} inline, keeps the editor open and the row on its stored paid text", async () => {
      stubEdit(
        { status: 503, body: { error: "FX rate for GBP is unavailable" } },
        collectionWithCopies,
        collectionWithCopies,
      );
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByRole("heading", { name: "Your copies (2)" });
      await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Edit copy PAL loose" }));
      const editor = screen.getByRole("form", { name: "Edit copy PAL loose" });
      await userEvent.clear(within(editor).getByLabelText("Paid"));
      await userEvent.type(within(editor).getByLabelText("Paid"), "12.5");
      await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
      expect(
        await screen.findByText("API 503 updating copy: FX rate for GBP is unavailable"),
      ).toBeInTheDocument();
      expect(screen.getByRole("form", { name: "Edit copy PAL loose" })).toBeInTheDocument();
      expect((within(editor).getByLabelText("Paid") as HTMLInputElement).value).toBe("12.5");
      // nothing stored: the row and the last-pick currency are untouched
      expect(screen.getByText(/paid £23\.00/)).toBeInTheDocument();
      expect(window.localStorage.getItem("lastPaidCurrency")).toBeNull();
    });
  });

  it("loads the collection under the persisted basis AND markets, so the panel's estimate fallback agrees with the collection list", async () => {
    window.localStorage.setItem("valuationBasis", "trade_in");
    window.localStorage.setItem("valuationCountry", "ES");
    window.localStorage.setItem("valuationIncludeForeign", "true");
    const fetchMock = stubFetch(collectionWithCopies);
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByRole("heading", { name: "Your copies (2)" });
    await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
    // The URL gained &country=&includeForeign= when the valuation markets
    // landed: sending the basis alone valued these copies under the API's
    // GB-only default, so the same copy could read one value here and another
    // in the collection list.
    expect(
      fetchMock.mock.calls.some(
        ([u]) => String(u) === "/api/collection?valuation=trade_in&country=ES&includeForeign=true",
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/collection")).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/collection?valuation=trade_in")).toBe(false);
  });

  it("offers + I own this and says there is no copy when the collection has none of this game", async () => {
    stubFetch(); // default empty collection
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    expect(screen.getByRole("button", { name: "+ I own this" })).toBeInTheDocument();
    expect(screen.getByText("You have no copy of this game.")).toBeInTheDocument();
    expect(screen.queryByText(/total paid/)).not.toBeInTheDocument();
  });

  it("shows no totals line when copies exist but none has a paid price (no fabricated totals)", async () => {
    stubFetch(collectionWithCopiesNoPaid);
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    expect(await screen.findByRole("heading", { name: "Your copies (2)" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
    expect(screen.queryByText(/total paid/)).not.toBeInTheDocument();
  });

  it("keeps ownership comparables from the initial unfiltered load even after a chip-filtered refetch empties the cex block", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      if (String(url).includes("/prices")) {
        call += 1;
        // first load (mount, region=all/condition=all): full prices with voucher points
        // later loads (chip-filtered): cex block comes back empty
        return new Response(JSON.stringify(call === 1 ? prices : pricesFilteredEmptyCex));
      }
      if (String(url).includes("/collection")) return new Response(JSON.stringify(collectionWithCopies));
      if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    expect(screen.getByText(/\+\$5\.00/)).toBeInTheDocument(); // initial unfiltered load

    await userEvent.click(screen.getByRole("button", { name: "PAL" }));
    // wait for the filtered refetch (its cex block is empty) to land
    await waitFor(() => expect(screen.getByText("No listings match this game and filter.")).toBeInTheDocument());

    // ownership row must still show its delta from the stashed unfiltered snapshot
    expect(screen.getByText(/\+\$5\.00/)).toBeInTheDocument();
  });

  it("clears a previous error when a later fetch succeeds", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/prices")) {
        call += 1;
        if (call === 1) throw new Error("network fail");
        return new Response(JSON.stringify(prices));
      }
      if (init?.method === "POST") return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GameDetail game={prices.game} onBack={() => {}} />);
    expect(await screen.findByText(/could not load prices/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "PAL" }));

    expect(await screen.findByText(/don't buy at CeX/)).toBeInTheDocument();
    expect(screen.queryByText(/could not load prices/i)).toBeNull();
  });

  it("region and condition are segmented groups", async () => {
    stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    const region = screen.getByRole("group", { name: "Region filter" });
    expect(within(region).getByRole("button", { name: "all" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(region).getByRole("button", { name: "PAL" }));
    expect(within(region).getByRole("button", { name: "PAL" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("group", { name: "Condition filter" })).getByRole("button", { name: "cib" })).toBeInTheDocument();
  });

  it("refresh and price mode live in the game menu", async () => {
    stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    const menu = screen.getByLabelText("Game options").closest("details") as HTMLElement;
    expect(within(menu).getByRole("button", { name: /refresh now/i })).toBeInTheDocument();
    expect(within(menu).getByLabelText(/Price mode/)).toBeInTheDocument();
  });

  it("Recent keeps the unfiltered verdict, and forgets a game the server no longer has", async () => {
    stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    const stored = () => JSON.parse(window.localStorage.getItem("recentGames") ?? "[]") as Array<{ game: { id: number }; verdictTitle: string | null }>;
    // Recent is written in an effect after the verdict renders
    await waitFor(() => expect(stored()[0]?.verdictTitle ?? null).not.toBeNull());
    const unfiltered = stored()[0].verdictTitle;
    // a filtered view's verdict is about a slice: Recent keeps the whole game's
    await userEvent.click(within(screen.getByRole("group", { name: "Region filter" })).getByRole("button", { name: "NTSC_J" }));
    await screen.findByText(/don't buy at CeX/);
    expect(stored()[0].verdictTitle).toBe(unfiltered);
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).includes("/prices") ? new Response(JSON.stringify({ error: "game not found" }), { status: 404 }) : new Response(JSON.stringify({ items: [] })),
      ),
    );
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/could not load prices/i);
    expect(stored().some((r) => r.game.id === prices.game.id)).toBe(false);
  });

  it("refresh button forces a one-shot live fetch", async () => {
    const fetchMock = stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    await screen.findByText(/don't buy at CeX/);
    await userEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("refresh=true"))).toBe(true);
  });

  it("shows an honest empty-block note when a source is ok but matched nothing", async () => {
    const emptyOk: PricesResponse = {
      ...prices,
      sources: [
        { source: "cex", status: "ok", fetchedAt: "2026-08-31T03:00:00Z", points: [] },
        prices.sources[1],
        prices.sources[2],
      ],
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/prices")) return new Response(JSON.stringify(emptyOk));
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GameDetail game={prices.game} onBack={() => {}} />);
    expect(await screen.findByText("No listings match this game and filter.")).toBeInTheDocument();
  });

  it("renders a 'View listing' link for a signal that carries a url, and none otherwise", async () => {
    const pricesWithBargain: PricesResponse = {
      ...prices,
      signals: [
        { type: "TARGET_HIT", reasoning: "lead-reasoning", source: "cex", confidence: "high" },
        ...prices.signals,
        {
          type: "UNDERPRICED",
          reasoning: 'PAL/cib: "PDS complete" at £19 vs eBay UK active median £30 (9 listings) — bargain candidate',
          url: "https://www.ebay.co.uk/itm/bargain1",
          source: "ebay_uk",
        },
      ],
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/prices")) return new Response(JSON.stringify(pricesWithBargain));
      if (String(url).includes("/collection")) return new Response(JSON.stringify(emptyCollection));
      if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GameDetail game={prices.game} onBack={() => {}} />);

    // OVERPRICED_STORE carries no url: its badge has reasoning but no link
    const overpricedText = await screen.findByText(/don't buy at CeX/);
    const overpricedBadge = overpricedText.closest("span.signal-line");
    expect(overpricedBadge).not.toBeNull();
    expect(overpricedBadge && overpricedBadge.querySelector("a")).toBeNull();

    // UNDERPRICED carries a url: its badge renders a clickable link to it
    const bargainText = await screen.findByText(/bargain candidate/);
    const bargainBadge = bargainText.closest("span.signal-line");
    expect(bargainBadge).not.toBeNull();
    const link = bargainBadge?.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "https://www.ebay.co.uk/itm/bargain1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveTextContent("View listing");
  });

  it("shows the cover art in the header when the game has one, and none otherwise", async () => {
    stubFetch();
    const withCover = { ...prices.game, coverUrl: "https://images.igdb.test/pds.jpg" };
    render(<GameDetail game={withCover} onBack={() => {}} />);
    const img = await screen.findByRole("img", { name: "Panzer Dragoon Saga" });
    expect(img).toHaveAttribute("src", "https://images.igdb.test/pds.jpg");
    cleanup();

    stubFetch();
    render(<GameDetail game={prices.game} onBack={() => {}} />); // coverUrl: null
    expect(screen.queryByRole("img", { name: "Panzer Dragoon Saga" })).not.toBeInTheDocument();
  });

  describe("Watchdog barks section", () => {
    // The best high signal leads as the verdict and leaves its group; this
    // TARGET_HIT always wins, so the groups these tests inspect stay whole.
    const lead: Signal = { type: "TARGET_HIT", reasoning: "lead-reasoning", source: "cex", confidence: "high" };

    // one signal of every type, so each group has exactly one member
    const pricesAllSignals: PricesResponse = {
      ...prices,
      signals: [
        lead,
        { type: "UNDERPRICED", reasoning: "under-reasoning", url: "https://ebay/u1", source: "ebay_uk" },
        { type: "FLIP", reasoning: "flip-reasoning", buySource: "ebay_uk", sellSource: "cex" },
        { type: "OVERPRICED_STORE", reasoning: "over-reasoning", source: "cex" },
        { type: "INSUFFICIENT_DATA", reasoning: "insufficient-reasoning" },
      ],
    };

    function stubPrices(response: PricesResponse): void {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/prices")) return new Response(JSON.stringify(response));
        if (String(url).includes("/collection")) return new Response(JSON.stringify(emptyCollection));
        if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      vi.stubGlobal("fetch", fetchMock);
    }

    /** the group container: the h4 heading's parent div holding its badges */
    async function findGroup(name: string): Promise<HTMLElement> {
      const heading = await screen.findByRole("heading", { level: 4, name });
      return heading.parentElement as HTMLElement;
    }

    it("shows the h3 header with the dogfound icon when signals exist", async () => {
      stubPrices(pricesAllSignals);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      // alt="" keeps the icon decorative: the accessible name is the text alone
      const heading = await screen.findByRole("heading", { level: 3, name: "Watchdog barks" });
      expect(heading).toBeInTheDocument();
      // the committed asset renders as the round .barks-icon beside the text
      const icon = heading.querySelector("img.barks-icon") as HTMLImageElement;
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("src", "/dogfound.png");
      expect(icon).toHaveAttribute("alt", "");
    });

    it("shows no header when there are no signals", async () => {
      stubPrices({ ...prices, signals: [] });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByText(/CeX UK sells for/); // prices are loaded
      expect(screen.queryByText(/Watchdog barks/)).not.toBeInTheDocument();
    });

    it("groups UNDERPRICED under 🛒 Buy now with its extended badge (pill, reasoning, link)", async () => {
      stubPrices(pricesAllSignals);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const group = await findGroup("🛒 Buy now");
      expect(within(group).getByText(/under-reasoning/)).toBeInTheDocument();
      // extended format survives the grouping: pill on top, link below
      expect(within(group).getByText("🛒 buy @ eBay UK")).toHaveClass("badge-compact");
      expect(within(group).getByRole("link", { name: /view listing/i })).toHaveAttribute(
        "href",
        "https://ebay/u1",
      );
      expect(within(group).queryByText(/flip-reasoning|over-reasoning/)).toBeNull();
    });

    it("groups FLIP under ⇄ Buy to sell", async () => {
      stubPrices(pricesAllSignals);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const group = await findGroup("⇄ Buy to sell");
      expect(within(group).getByText(/flip-reasoning/)).toBeInTheDocument();
      expect(within(group).getByText("⇄ buy eBay UK → sell CeX UK")).toBeInTheDocument();
      expect(within(group).queryByText(/under-reasoning|over-reasoning/)).toBeNull();
    });

    it("groups OVERPRICED_STORE under 💰 Sell now with the warning tone", async () => {
      stubPrices(pricesAllSignals);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const group = await findGroup("💰 Sell now");
      const reasoning = within(group).getByText(/over-reasoning/);
      expect(reasoning.closest("span.signal-line")).toHaveClass("warning");
      expect(within(group).getByText("⚠ overpriced @ CeX UK")).toHaveClass("warning");
      expect(within(group).queryByText(/under-reasoning|flip-reasoning/)).toBeNull();
    });

    it("renders only the groups that have signals", async () => {
      // the base fixture carries just the OVERPRICED_STORE signal (plus the lead)
      stubPrices({ ...prices, signals: [lead, ...prices.signals] });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      expect(await screen.findByRole("heading", { level: 4, name: "💰 Sell now" })).toBeInTheDocument();
      expect(screen.queryByText("🛒 Buy now")).not.toBeInTheDocument();
      expect(screen.queryByText("⇄ Buy to sell")).not.toBeInTheDocument();
    });

    it("leads with the high finding and folds the potential one with its caveat", async () => {
      // base order is potential first: the high one still leads
      stubPrices({
        ...prices,
        signals: [
          {
            type: "UNDERPRICED", reasoning: "potential-bargain", source: "ebay_uk",
            confidence: "potential", caveats: ["listing condition not declared"],
            price: { usd: 19, original: 15, currency: "GBP" },
          },
          {
            type: "UNDERPRICED", reasoning: "high-bargain", source: "ebay_uk",
            confidence: "high", caveats: [],
            price: { usd: 21, original: 17, currency: "GBP" },
          },
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      expect(await screen.findByText("high-bargain")).toBeInTheDocument();
      const fold = screen.getByText("1 possible bark (signal) with incomplete data").closest("details") as HTMLDetailsElement;
      expect(fold.open).toBe(false);
      await userEvent.click(within(fold).getByText("1 possible bark (signal) with incomplete data"));
      const badge = within(fold).getByText(/potential-bargain/).closest("span.signal-line");
      expect(badge).toHaveClass("potential");
      expect(badge).toHaveTextContent("why potential: listing condition not declared");
    });

    it("collapses several findings from one source behind a header naming it, its count and its best price", async () => {
      stubPrices({
        ...prices,
        signals: [
          lead,
          { type: "UNDERPRICED", reasoning: "dearer-one", source: "ebay_uk", price: { usd: 21, original: 17, currency: "GBP" } },
          { type: "UNDERPRICED", reasoning: "cheaper-one", source: "ebay_uk", price: { usd: 19, original: 15, currency: "GBP" } },
          { type: "UNDERPRICED", reasoning: "cex-one", source: "cex", price: { usd: 40, original: 32, currency: "GBP" } },
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const group = await findGroup("🛒 Buy now");
      const toggle = within(group).getByRole("button");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveTextContent("eBay UK");
      expect(toggle).toHaveTextContent("(2)");
      // the buy side's best is the CHEAPEST, not the first row
      expect(toggle).toHaveTextContent("$19.00");
      // the sell-side "asks" verb must never leak onto a buy-side header
      expect(toggle).not.toHaveTextContent("asks");
      expect(within(group).getByText(/dearer-one/)).not.toBeVisible();
      // the lone CeX finding is flat: one control in this category, not two
      expect(within(group).getAllByRole("button")).toHaveLength(1);
      expect(within(group).getByText(/cex-one/)).toBeVisible();
    });

    it("heads a sell-side group with its HIGHEST price, verb-prefixed to read as what the store charges", async () => {
      // Ruled: the sell-side header reads "asks $X" — a bare amount under a
      // "💰 Sell now" heading would misread as a payout, when it is what the
      // STORE charges (the same misreading the plan refuses for FLIP).
      stubPrices({
        ...prices,
        signals: [
          lead,
          { type: "OVERPRICED_STORE", reasoning: "over-lower", source: "cex", price: { usd: 45, original: 36, currency: "GBP" } },
          { type: "OVERPRICED_STORE", reasoning: "over-higher", source: "cex", price: { usd: 52, original: 41, currency: "GBP" } },
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const group = await findGroup("💰 Sell now");
      expect(within(group).getByRole("button")).toHaveTextContent("asks $52.00");
    });

    it("renders FLIP as ONE collapsible section, flat, with no source grouping", async () => {
      // a FLIP carries buySource/sellSource and no source at all, so there is
      // no key to group by and none is invented (spec decision 3)
      stubPrices({
        ...prices,
        signals: [
          lead,
          { type: "FLIP", reasoning: "flip-one", buySource: "ebay_uk", sellSource: "cex", price: { usd: 19, original: 15, currency: "GBP" } },
          { type: "FLIP", reasoning: "flip-two", buySource: "cex", sellSource: "ebay_uk", price: { usd: 24, original: 19, currency: "GBP" } },
        ],
      });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const group = await findGroup("⇄ Buy to sell");
      const toggles = within(group).getAllByRole("button");
      expect(toggles).toHaveLength(1);
      expect(toggles[0]).toHaveTextContent("(2)");
      expect(within(group).getByText(/flip-one/)).not.toBeVisible();
      await userEvent.click(toggles[0]);
      expect(within(group).getByText(/flip-one/)).toBeVisible();
      expect(within(group).getByText(/flip-two/)).toBeVisible();
    });

    it("drops a PROFIT signal: never rendered under any heading, and no header when it is the only signal", async () => {
      // Part P placement rule: the barks stay UNDERPRICED / FLIP /
      // OVERPRICED_STORE; a PROFIT reaching this screen is dropped
      const profit = {
        type: "PROFIT" as const,
        reasoning: "profit-reasoning",
        sellSource: "cex" as const,
        gainUsd: 5,
        confidence: "high" as const,
        caveats: [],
      };
      stubPrices({ ...prices, signals: [lead, ...prices.signals, profit] });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const group = await findGroup("💰 Sell now");
      expect(within(group).getByText(/don't buy at CeX/)).toBeInTheDocument();
      expect(screen.queryByText(/profit-reasoning/)).not.toBeInTheDocument();
      expect(screen.queryByText(/sell @/)).not.toBeInTheDocument();
      expect(screen.queryByText("PROFIT")).not.toBeInTheDocument();
      cleanup();

      stubPrices({ ...prices, signals: [profit] });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByText(/CeX UK sells for/); // prices are loaded
      expect(screen.queryByText(/Watchdog barks/)).not.toBeInTheDocument();
      expect(screen.queryByText(/profit-reasoning/)).not.toBeInTheDocument();
    });

    it("shows INSUFFICIENT_DATA plain and alone, and not beside real signals", async () => {
      stubPrices(pricesAllSignals);
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      await screen.findByText(/lead-reasoning/);
      expect(screen.queryByText(/insufficient-reasoning/)).toBeNull();
      cleanup();

      stubPrices({ ...prices, signals: [{ type: "INSUFFICIENT_DATA", reasoning: "insufficient-reasoning" }] });
      render(<GameDetail game={prices.game} onBack={() => {}} />);
      const badge = (await screen.findByText(/insufficient-reasoning/)).closest("span.signal-line");
      expect(badge).toHaveClass("info");
    });
  });
});
