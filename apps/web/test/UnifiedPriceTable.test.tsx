import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PricePointDto, PricesResponse, SourceInfoDto } from "@retrowatchdog/shared";
import { UnifiedPriceTable } from "../src/components/UnifiedPriceTable.js";
import { resetMoneyForTests, setDisplayCurrency } from "../src/lib/money.js";
import { resetSourcesForTests, setSourcesForTests } from "../src/lib/sources.js";
import { resetViewPrefsForTests, setEbayOwnBlock } from "../src/lib/viewPrefs.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";

type Block = PricesResponse["sources"][number];

function point(overrides: Partial<PricePointDto>): PricePointDto {
  return {
    source: "cex",
    kind: "sell",
    region: "PAL",
    condition: "cib",
    priceUsd: 50,
    priceOriginal: 40,
    currencyOriginal: "GBP",
    available: true,
    ...overrides,
  };
}
const cexBlock = (points: PricePointDto[]): Block => ({ source: "cex", status: "ok", fetchedAt: "2026-09-02T10:00:00Z", points });

beforeEach(() => setSourcesForTests(SOURCES_FIXTURE));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  resetViewPrefsForTests();
  window.localStorage.clear();
});

const panel = (title: string): HTMLElement =>
  screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;
/** the What cell of a row, found by its price */
const whatOf = (price: string): HTMLElement =>
  (screen.getByText(price).closest("tr") as HTMLElement).querySelector("td.what") as HTMLElement;

// The measured FFTA case in miniature: two buyable boxes and two out-of-stock
// ones, each with its cash/voucher siblings carrying the same flag.
const mixedStock = [
  cexBlock([
    point({ listingTitle: "FFTA, Boxed", priceUsd: 52, url: "https://cex/1", available: true }),
    point({ listingTitle: "FFTA, Unboxed", condition: "loose", priceUsd: 25, available: true }),
    point({ listingTitle: "FFTA, w/ Manual, Boxed", priceUsd: 300, available: false }),
    point({ listingTitle: "FFTA, Mint, Boxed", grade: "mint", priceUsd: 325, available: false }),
    point({ kind: "cash", listingTitle: "FFTA, Boxed", priceUsd: 20, available: true }),
    point({ kind: "voucher", listingTitle: "FFTA, Boxed", priceUsd: 28, available: true }),
    point({ kind: "cash", listingTitle: "FFTA, w/ Manual, Boxed", priceUsd: 21, available: false }),
    point({ kind: "voucher", listingTitle: "FFTA, w/ Manual, Boxed", priceUsd: 29, available: false }),
  ]),
];

describe("UnifiedPriceTable", () => {
  it("offers and payouts never share a table", () => {
    render(<UnifiedPriceTable blocks={mixedStock} />);
    const buy = panel("To buy");
    const pay = panel("Shops pay you");
    expect(within(buy).getByText("$52.00")).toBeInTheDocument();
    expect(within(buy).queryByText("$20.00")).not.toBeInTheDocument();
    expect(within(pay).getByText("$20.00")).toBeInTheDocument();
    expect(within(pay).getByText("$28.00")).toBeInTheDocument();
    expect(within(pay).queryByText("$52.00")).not.toBeInTheDocument();
    // every row names its source and its kind
    expect(whatOf("$28.00").textContent).toBe("pays voucher · FFTA, Boxed");
    expect((screen.getByText("$28.00").closest("tr") as HTMLElement)).toHaveTextContent("CeX UK");
    expect(screen.getByRole("link", { name: "$52.00" })).toHaveAttribute("href", "https://cex/1");
  });

  it("out-of-stock rows fold under To buy; payouts of that box are tagged, not folded", () => {
    render(<UnifiedPriceTable blocks={mixedStock} />);
    const buy = panel("To buy");
    const fold = within(buy).getByText("Out of stock (2)").closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText("$300.00")).toBeInTheDocument();
    expect(within(fold).getByText("$325.00")).toBeInTheDocument();
    expect(within(fold).queryByText("$52.00")).not.toBeInTheDocument();
    // CeX pays regardless of its own stock: one table, the two bids tagged
    const pay = panel("Shops pay you");
    expect(within(pay).queryByRole("group")).toBeNull();
    expect(within(pay).getAllByText(/· out of stock at CeX UK/)).toHaveLength(2);
    expect(whatOf("$28.00")).not.toHaveTextContent("out of stock");
  });

  it("says so when nothing is in stock, keeping the rows folded below", () => {
    render(
      <UnifiedPriceTable
        blocks={[cexBlock([point({ listingTitle: "FFTA, Boxed", priceUsd: 300, available: false }), point({ priceUsd: 240, available: false, condition: "loose" })])]}
      />,
    );
    expect(screen.getByText("Nothing in stock — 2 out-of-stock listings below")).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("treats available: null as in stock", () => {
    render(<UnifiedPriceTable blocks={[cexBlock([point({ priceUsd: 52, available: null }), point({ kind: "cash", priceUsd: 20, available: null })])]} />);
    expect(screen.queryByText(/Out of stock/)).not.toBeInTheDocument();
    expect(screen.queryByText(/out of stock at/)).not.toBeInTheDocument();
  });

  it("keeps context kinds (baseline, guide) with the offers", () => {
    render(
      <UnifiedPriceTable
        blocks={[
          { source: "ebay_uk", status: "ok", fetchedAt: "2026-09-02T10:00:00Z", points: [point({ source: "ebay_uk", kind: "active_median", sampleSize: 7, available: null, priceUsd: 33 })] },
        ]}
      />,
    );
    expect(within(panel("To buy")).getByText("$33.00")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Shops pay you" })).toBeNull();
    // the label-only form with its sample size, never the listing form
    expect(whatOf("$33.00").textContent).toBe("eBay UK median (active) (7 listings)");
  });

  it("writes a listing row as the short kind word and its title, never a sample size", () => {
    render(
      <UnifiedPriceTable
        blocks={[
          cexBlock([point({ listingTitle: "Pilotwings 64, Boxed", sampleSize: 9, priceUsd: 61 })]),
          { source: "ebay_uk", status: "ok", points: [point({ source: "ebay_uk", kind: "active_listing", listingTitle: "Zelda OoT N64 PAL boxed", priceUsd: 44 })] },
        ]}
      />,
    );
    expect(whatOf("$61.00").textContent).toBe("sells for · Pilotwings 64, Boxed");
    expect(whatOf("$44.00").textContent).toBe("listing · Zelda OoT N64 PAL boxed");
  });

  it("prints a source's declared short word on a listing row", () => {
    const shopGb: SourceInfoDto = {
      id: "shop_gb", label: "Shop GB", family: "shop_gb", familyLabel: "Shop GB", kind: "live", country: "GB", reach: "local",
      defaultRegion: null, expectedCurrencies: ["GBP"], kindRoles: { sell: "buy_store" }, kindLabels: { sell: "Shop GB sells for" },
      kindLabelsShort: { sell: "asks" }, configured: true, origin: "plugin", pluginId: 9,
    };
    setSourcesForTests([...SOURCES_FIXTURE, shopGb]);
    render(<UnifiedPriceTable blocks={[{ source: "shop_gb", status: "ok", points: [point({ source: "shop_gb", listingTitle: "Something Boxed", priceUsd: 15 })] }]} />);
    expect(whatOf("$15.00").textContent).toBe("asks · Something Boxed");
  });

  it("grade header sorts best first, again to restore", async () => {
    render(
      <UnifiedPriceTable
        blocks={[cexBlock([point({ priceUsd: 10, grade: null }), point({ priceUsd: 11, grade: "good" }), point({ priceUsd: 12, grade: "mint" })])]}
      />,
    );
    const prices = () => within(panel("To buy")).getAllByRole("row").slice(1).map((r) => r.querySelector("td.price")?.textContent);
    expect(prices()).toEqual(["$10.00", "$11.00", "$12.00"]);
    // a graded row says which grade it is
    expect(within(panel("To buy")).getByRole("cell", { name: "mint" })).toBeInTheDocument();
    await userEvent.click(within(panel("To buy")).getByRole("button", { name: "Grade" }));
    expect(prices()).toEqual(["$12.00", "$11.00", "$10.00"]);
    await userEvent.click(within(panel("To buy")).getByRole("button", { name: "Grade" }));
    expect(prices()).toEqual(["$10.00", "$11.00", "$12.00"]);
  });

  it("shows the shop's own quote when the display currency is the quote's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ base: "USD", to: "GBP", rate: 0.7583, fetchedAt: null, mode: "auto" }))));
    await setDisplayCurrency("GBP");
    render(<UnifiedPriceTable blocks={[cexBlock([point({ priceUsd: 232.62, priceOriginal: 177, currencyOriginal: "GBP" })])]} />);
    expect(screen.getByText("£177.00")).toBeInTheDocument();
  });

  it("states each source's caveat and status once, under the table", () => {
    render(
      <UnifiedPriceTable
        blocks={[
          cexBlock([point({ priceUsd: 52 })]),
          { source: "ebay_uk", status: "error", fetchedAt: "2026-09-01T09:00:00Z", points: [point({ source: "ebay_uk", kind: "active_listing", priceUsd: 30 })] },
        ]}
      />,
    );
    const note = screen.getByText(/^eBay UK:/).closest(".price-note") as HTMLElement;
    expect(note).toHaveTextContent(/active FIXED-PRICE listings/i);
    expect(note).toHaveTextContent(/Source error — showing stale data/);
  });

  it("a price whose kind has no declared role is neither an offer nor a payout", () => {
    render(<UnifiedPriceTable blocks={[cexBlock([point({ priceUsd: 52 }), point({ kind: "mystery" as PricePointDto["kind"], priceUsd: 77 })])]} />);
    expect(within(panel("To buy")).queryByText("$77.00")).toBeNull();
    expect(within(panel("Other prices")).getByText("$77.00")).toBeInTheDocument();
  });

  it("each table sorts by grade on its own", async () => {
    render(
      <UnifiedPriceTable
        blocks={[
          cexBlock([
            point({ priceUsd: 10, grade: null }),
            point({ priceUsd: 12, grade: "mint" }),
            point({ kind: "cash", priceUsd: 5, grade: null }),
            point({ kind: "cash", priceUsd: 6, grade: "mint" }),
          ]),
        ]}
      />,
    );
    const prices = (title: string) =>
      within(panel(title)).getAllByRole("row").slice(1).map((r) => r.querySelector("td.price")?.textContent);
    await userEvent.click(within(panel("Shops pay you")).getByRole("button", { name: "Grade" }));
    expect(prices("Shops pay you")).toEqual(["$6.00", "$5.00"]);
    expect(prices("To buy")).toEqual(["$10.00", "$12.00"]);
  });

  it("on the phone the date rides with the tier under the source", () => {
    render(<UnifiedPriceTable blocks={[cexBlock([point({ priceUsd: 52 })])]} />);
    const tier = (screen.getByText("$52.00").closest("tr") as HTMLElement).querySelector(".row-tier") as HTMLElement;
    expect(tier).toHaveTextContent(`PAL · cib · ${new Date("2026-09-02T10:00:00Z").toLocaleDateString()}`);
  });

  it("renders nothing without the registry", () => {
    resetSourcesForTests();
    const { container } = render(<UnifiedPriceTable blocks={mixedStock} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("UnifiedPriceTable filters and sort", () => {
  const ebayBlock = (points: PricePointDto[]): Block => ({ source: "ebay_uk", status: "ok", fetchedAt: "2026-09-03T10:00:00Z", points });
  const two = [
    cexBlock([point({ listingTitle: "CeX box", priceUsd: 52 })]),
    ebayBlock([
      point({ source: "ebay_uk", kind: "active_listing", listingTitle: "eBay cheap", priceUsd: 18 }),
      point({ source: "ebay_uk", kind: "active_listing", listingTitle: "eBay dear", priceUsd: 70 }),
    ]),
  ];
  const titles = () => [...panel("To buy").querySelectorAll("td.what")].map((td) => td.textContent?.replace(/^.*· /, ""));

  it("a source filter narrows the tables", async () => {
    render(<UnifiedPriceTable blocks={two} />);
    await userEvent.click(within(screen.getByRole("group", { name: "Source" })).getByRole("button", { name: "eBay UK" }));
    expect(titles()).toEqual(["eBay cheap", "eBay dear"]);
    await userEvent.click(within(screen.getByRole("group", { name: "Source" })).getByRole("button", { name: "all" }));
    expect(titles()).toHaveLength(3);
  });

  it("no source filter with a single source", () => {
    render(<UnifiedPriceTable blocks={mixedStock} />);
    expect(screen.queryByRole("group", { name: "Source" })).toBeNull();
  });

  it("every column header sorts; a second click flips it", async () => {
    render(<UnifiedPriceTable blocks={two} />);
    const head = (name: string) => within(panel("To buy")).getByRole("button", { name });
    await userEvent.click(head("Price"));
    expect(titles()).toEqual(["eBay cheap", "CeX box", "eBay dear"]);
    await userEvent.click(head("Price"));
    expect(titles()).toEqual(["eBay dear", "CeX box", "eBay cheap"]);
    await userEvent.click(head("Source"));
    expect(titles()[0]).toBe("CeX box");
    for (const name of ["What", "Region", "Condition", "Grade", "Updated"]) expect(head(name)).toBeInTheDocument();
  });
});


describe("eBay in its own block (Settings → Appearance, off by default)", () => {
  const mixed = [
    cexBlock([point({ listingTitle: "FFTA, Boxed", priceUsd: 52 })]),
    { source: "ebay_uk", status: "ok", fetchedAt: "2026-09-02T10:00:00Z", points: [point({ source: "ebay_uk", kind: "active_listing", listingTitle: "FFTA PAL boxed", priceUsd: 30 })] } as Block,
  ];

  it("is off by default: one table, every source together", () => {
    render(<UnifiedPriceTable blocks={mixed} />);
    const buy = panel("To buy");
    expect(within(buy).queryByRole("heading", { name: "eBay" })).toBeNull();
    expect(within(buy).getAllByRole("table")).toHaveLength(1);
  });

  it("when on, eBay rows sit in their own block, apart from the other sources", () => {
    setEbayOwnBlock(true);
    render(<UnifiedPriceTable blocks={mixed} />);
    const buy = panel("To buy");
    const ebay = within(buy).getByRole("heading", { name: "eBay" }).closest(".ebay-block") as HTMLElement;
    expect(within(ebay).getByText("$30.00")).toBeInTheDocument();
    expect(within(ebay).queryByText("$52.00")).toBeNull();
    const others = within(buy).getByRole("heading", { name: "Other sources" }).parentElement as HTMLElement;
    expect(within(others).getByText("$52.00")).toBeInTheDocument();
    expect(within(buy).getByText(/shown apart from other sources/i)).toBeInTheDocument();
  });

  it("when on but a panel has only one side, it renders as one table", () => {
    setEbayOwnBlock(true);
    render(<UnifiedPriceTable blocks={[mixed[0]]} />);
    expect(within(panel("To buy")).queryByRole("heading", { name: "eBay" })).toBeNull();
  });
});
