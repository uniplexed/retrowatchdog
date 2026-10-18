import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreQuoteDto, WatchlistItemDto, WatchlistResponse } from "@retrowatchdog/shared";
import { WatchlistScreen } from "../src/screens/WatchlistScreen.js";
import { resetMoneyForTests, setDisplayCurrency } from "../src/lib/money.js";
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

/** shorthand for the CeX-shaped StoreQuoteDto fixtures most tests need */
function cexQuote(kind: StoreQuoteDto["kind"], label: string, priceUsd: number, priceOriginal: number): StoreQuoteDto {
  return { kind, label, priceUsd, priceOriginal, currencyOriginal: "GBP" };
}

const response: WatchlistResponse = {
  items: [
    // quiet item: an info signal is NOT an opportunity — no compact badge
    item({
      id: 1,
      game: { id: 7, title: "Super Metroid", platform: "snes", year: 1994, coverUrl: "https://covers.example/sm.jpg" },
      // the user's target stays a verbatim original; CeX prices are stored USD
      targetPriceOriginal: 30, targetCurrency: "GBP", targetPriceUsd: 38,
      storeOffer: cexQuote("sell", "CeX UK sells for", 25, 20),
      storeBids: [cexQuote("cash", "CeX UK pays cash", 12, 10)],
      storeSource: "cex",
      priceDisplayAt: "2026-08-31T03:00:00.000Z",
      signals: [{ type: "INSUFFICIENT_DATA", reasoning: "not enough data yet" }],
    }),
    // bargain only: the single 🛒 direction pill
    item({
      id: 2,
      game: { id: 8, title: "EarthBound", platform: "snes", year: 1994, coverUrl: null },
      signals: [
        { type: "UNDERPRICED", reasoning: "listing at £15 vs median £30", url: "https://ebay/1", source: "ebay_uk" },
      ],
    }),
    // every direction at once, with TWO bargain listings from the same
    // source: pills dedupe to one 🛒 + one ⇄ + one ⚠
    item({
      id: 3,
      game: { id: 9, title: "Chrono Trigger", platform: "snes", year: 1995, coverUrl: null },
      signals: [
        { type: "UNDERPRICED", reasoning: "listing at £20 vs median £40", source: "ebay_uk" },
        { type: "UNDERPRICED", reasoning: "listing at £22 vs median £40", source: "ebay_uk" },
        { type: "FLIP", reasoning: "voucher £50 vs median £40", buySource: "ebay_uk", sellSource: "cex" },
        { type: "OVERPRICED_STORE", reasoning: "CeX sells £60 vs median £40", source: "cex" },
      ],
    }),
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear(); // controls persist; keep tests isolated
});

/** most tests read every watch: the Signals chip (on by default) is turned off */
const showAll = (): void =>
  window.localStorage.setItem("watchlistControls", JSON.stringify({ ...DEFAULT_WATCHLIST_CONTROLS, barkingOnly: false }));

/** the row containing this title */
function rowOf(title: string): HTMLElement {
  return screen.getByText(title).closest(".ui-swipe") as HTMLElement;
}
/** the row's right-hand line */
const rightOf = (title: string): HTMLElement => rowOf(title).querySelector(".ui-row-right") as HTMLElement;

const serve = (body: WatchlistResponse) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));

describe("WatchlistScreen", () => {
  beforeEach(showAll);

  it("a row per watch: console, region, condition and target in the meta; the verdict on the right", async () => {
    serve(response);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    expect(document.querySelectorAll(".ui-swipe")).toHaveLength(3);
    expect(rowOf("Super Metroid")).toHaveTextContent("SNES · any · any · target £30.00");
    // no verdict: the shop's own offer, as it labelled it
    expect(rightOf("Super Metroid")).toHaveTextContent("CeX UK sells for $25.00");
    expect(rightOf("EarthBound")).toHaveTextContent("Buy on eBay UK");
    expect(rightOf("Chrono Trigger")).toHaveTextContent("Buy on eBay UK");
    // one line: none of the reasoning text leaks into the row
    expect(screen.queryByText(/median £40/)).toBeNull();
    expect(screen.queryByText(/listing at £15/)).toBeNull();
  });

  it("signals chip on by default and remembered", async () => {
    window.localStorage.clear();
    serve(response);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("EarthBound");
    const chip = screen.getByRole("button", { name: "Signals" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    // the info-only watch is quiet
    expect(screen.queryByText("Super Metroid")).toBeNull();
    await userEvent.click(chip);
    expect(screen.getByText("Super Metroid")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("watchlistControls") ?? "{}").barkingOnly).toBe(false);
  });

  it("edits a watch in a sheet: sends only the changed fields, then says how many buy signals the target hid", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let served = response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : null });
        if (init?.method === "PATCH") {
          served = { items: [{ ...response.items[1], targetPriceOriginal: 12, targetCurrency: "GBP", targetPriceUsd: 15, signals: [], signalsAboveTarget: 1 }] };
          return new Response(JSON.stringify({ id: 2 }));
        }
        return new Response(JSON.stringify(served));
      }),
    );
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("EarthBound");
    await userEvent.click(screen.getByRole("button", { name: "Edit watch EarthBound" }));
    const sheet = screen.getByRole("dialog", { name: "Edit watch EarthBound" });
    const form = within(sheet).getByRole("form", { name: "Edit watch EarthBound" });
    await userEvent.selectOptions(within(form).getByLabelText(/Region/), "PAL");
    await userEvent.type(within(form).getByLabelText(/Buy at or under/), "12");
    await userEvent.selectOptions(within(form).getByLabelText("Target currency"), "GBP");
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));

    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/watchlist/2");
    expect(patch.body).toEqual({ region: "PAL", targetPriceOriginal: 12, targetCurrency: "GBP" });
    expect(await screen.findByText(/1 buy bark \(signal\) above your target/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the shop that quoted the offer, so a Spanish price is not read as the UK's", async () => {
    serve({
      items: [
        item({
          id: 1,
          game: { id: 7, title: "Super Metroid", platform: "snes", year: 1994, coverUrl: null },
          storeOffer: { kind: "sell", label: "CeX ES sells for", priceUsd: 18, priceOriginal: 16, currencyOriginal: "EUR" },
          storeBids: [{ kind: "cash", label: "CeX ES pays cash", priceUsd: 8, priceOriginal: 7, currencyOriginal: "EUR" }],
          storeSource: "cex_es",
        }),
      ],
    });
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    expect(rightOf("Super Metroid")).toHaveTextContent(/CeX ES sells for/);
    expect(screen.queryByText(/CeX UK sells/)).not.toBeInTheDocument();
  });

  it("prints the offer's declared label verbatim, never composed with hardcoded wording", async () => {
    // A label that carries neither " sells " nor "pays cash" passes only if
    // the screen prints `label` as-is, with nothing composed around it.
    serve({
      items: [
        item({
          id: 1,
          game: { id: 40, title: "Metal Warriors", platform: "snes", year: 1995, coverUrl: null },
          storeOffer: { kind: "sell", label: "Shop GB will buy for", priceUsd: 10, priceOriginal: 8, currencyOriginal: "GBP" },
          storeSource: "shop_gb",
        }),
      ],
    });
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Metal Warriors");
    expect(rightOf("Metal Warriors").textContent?.trim()).toBe("Shop GB will buy for $10.00");
    expect(screen.queryByText(/ sells /)).not.toBeInTheDocument();
    // the raw source id must never leak onto the screen either
    expect(rowOf("Metal Warriors").textContent).not.toMatch(/shop_gb/i);
  });

  it("renders the game cover when present", async () => {
    serve(response);
    const { container } = render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    expect(container.querySelector('img[src="https://covers.example/sm.jpg"]')).toBeInTheDocument();
  });

  it("never leads a watch with a profit, even when the payload carries one", async () => {
    // a watch does not imply a physical copy: PROFIT is off the watchlist surface
    serve({
      items: [
        item({
          id: 7,
          game: { id: 14, title: "Terranigma", platform: "snes", year: 1995, coverUrl: null },
          signals: [
            { type: "PROFIT", reasoning: "PAL/cib: CeX pays voucher £44 vs paid £18 — trade in at CeX", sellSource: "cex", sellKind: "voucher", gainUsd: 30, edgePct: 90 },
            { type: "UNDERPRICED", reasoning: "listing at £20 vs median £40", source: "ebay_uk", edgePct: 50 },
          ],
        }),
      ],
    });
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Terranigma");
    expect(rightOf("Terranigma")).not.toHaveTextContent(/Sell to/);
    expect(rightOf("Terranigma")).toHaveTextContent("Buy on eBay UK");
  });

  it("words a flip from the signal's source fields, and names neither when it has none", async () => {
    serve({
      items: [
        item({
          id: 5,
          game: { id: 11, title: "F-Zero", platform: "snes", year: 1990, coverUrl: null },
          signals: [{ type: "FLIP", reasoning: "hypothetical", buySource: "cex", sellSource: "ebay_uk" }],
        }),
        item({
          id: 6,
          game: { id: 12, title: "Pilotwings", platform: "snes", year: 1990, coverUrl: null },
          signals: [{ type: "FLIP", reasoning: "no source metadata" }],
        }),
      ],
    });
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("F-Zero");
    expect(rightOf("F-Zero")).toHaveTextContent("Flip: buy on CeX UK, sell to eBay UK");
    expect(rightOf("Pilotwings")).toHaveTextContent("Flip opportunity");
  });

  it("orders items by actionability: flips, then bargains, then warnings, then the rest", async () => {
    const mixed: WatchlistResponse = {
      items: [
        item({ id: 1, game: { id: 21, title: "Quiet One", platform: "snes", year: 1991, coverUrl: null } }),
        item({ id: 2, game: { id: 22, title: "Warned Game", platform: "snes", year: 1992, coverUrl: null }, signals: [{ type: "OVERPRICED_STORE", reasoning: "r", source: "cex" }] }),
        item({ id: 3, game: { id: 23, title: "Bargain Game", platform: "snes", year: 1993, coverUrl: null }, signals: [{ type: "UNDERPRICED", reasoning: "r", source: "ebay_uk" }] }),
        item({ id: 4, game: { id: 24, title: "Flip Game", platform: "snes", year: 1994, coverUrl: null }, signals: [{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex" }] }),
        item({ id: 5, game: { id: 25, title: "Quiet Two", platform: "snes", year: 1995, coverUrl: null }, signals: [{ type: "INSUFFICIENT_DATA", reasoning: "r" }] }),
      ],
    };
    const TITLES = /^(Quiet One|Warned Game|Bargain Game|Flip Game|Quiet Two)$/;
    serve(mixed);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Flip Game");
    expect(screen.getAllByText(TITLES).map((el) => el.textContent)).toEqual([
      "Flip Game", "Bargain Game", "Warned Game", "Quiet One", "Quiet Two",
    ]);
    // a warning-only watch says so
    expect(rightOf("Warned Game")).toHaveTextContent("Nothing to buy here");
  });

  it("orders high-confidence items before potential ones, and counts the potential signal", async () => {
    serve({
      items: [
        item({
          id: 1,
          game: { id: 31, title: "Maybe Flip", platform: "snes", year: 1991, coverUrl: null },
          signals: [{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex", confidence: "potential", caveats: ["requires a mint copy"] }],
        }),
        item({
          id: 2,
          game: { id: 32, title: "Sure Flip", platform: "snes", year: 1992, coverUrl: null },
          signals: [{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex", confidence: "high", caveats: [] }],
        }),
      ],
    });
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Sure Flip");
    const TITLES = /^(Maybe Flip|Sure Flip)$/;
    expect(screen.getAllByText(TITLES).map((el) => el.textContent)).toEqual(["Sure Flip", "Maybe Flip"]);
    // the potential flip is counted, never shown as the verdict
    expect(rightOf("Maybe Flip")).not.toHaveTextContent("Flip:");
    expect(within(rightOf("Maybe Flip")).getByText("+1 possible")).toBeInTheDocument();
    expect(rightOf("Sure Flip")).toHaveTextContent("Flip: buy on eBay UK, sell to CeX UK");
  });

  it("a stored cards view opens the rows; there is one layout", async () => {
    window.localStorage.setItem("watchlistView", "cards");
    serve(response);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    expect(document.querySelectorAll(".ui-swipe")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Cards" })).toBeNull();
  });

  it("navigates to the game when a row is clicked", async () => {
    serve(response);
    const onSelect = vi.fn();
    render(<WatchlistScreen onSelect={onSelect} />);
    await screen.findByText("Super Metroid");
    await userEvent.click(screen.getByText("Super Metroid"));
    expect(onSelect).toHaveBeenCalledWith(response.items[0].game);
  });

  it("unwatch asks in a dialog, then deletes that watch", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(response));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    await userEvent.click(screen.getByRole("button", { name: "Unwatch Super Metroid" }));
    const dialog = screen.getByRole("alertdialog", { name: "Unwatch" });
    expect(dialog).toHaveTextContent("Remove Super Metroid from your watchlist?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    await waitFor(() => expect(calls.find((c) => c[1]?.method === "DELETE")).toBeDefined());
    expect(String(calls.find((c) => c[1]?.method === "DELETE")![0])).toContain("/api/watchlist/1");
  });

  it("unwatch does nothing when the dialog is cancelled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    await userEvent.click(screen.getByRole("button", { name: "Unwatch Super Metroid" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    expect(calls.find((c) => c[1]?.method === "DELETE")).toBeUndefined();
  });

  it("clear-watchlist asks with the count, calls DELETE /api/watchlist and reloads", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ deleted: 3 }));
      return new Response(JSON.stringify(response));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    await userEvent.click(screen.getByRole("button", { name: /clear watchlist/i }));
    const dialog = screen.getByRole("alertdialog", { name: "Clear the watchlist" });
    expect(dialog).toHaveTextContent("Remove all 3 watched games? This cannot be undone.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed 3")).toBeInTheDocument();
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    // the list-wide endpoint, not a per-watch /api/watchlist/:id
    expect(String(calls.find((c) => c[1]?.method === "DELETE")![0])).toMatch(/\/api\/watchlist$/);
    expect(calls.filter((c) => c[1]?.method === undefined).length).toBeGreaterThanOrEqual(2);
  });

  it("clear-watchlist does nothing when cancelled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    await userEvent.click(screen.getByRole("button", { name: /clear watchlist/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    expect(calls.find((c) => c[1]?.method === "DELETE")).toBeUndefined();
    expect(screen.getByText("Super Metroid")).toBeInTheDocument();
  });

  it("clear-watchlist surfaces a failure note and keeps the items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE" ? new Response(null, { status: 500 }) : new Response(JSON.stringify(response)),
      ),
    );
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    await userEvent.click(screen.getByRole("button", { name: /clear watchlist/i }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Could not clear the watchlist — is the API up? Try again.")).toBeInTheDocument();
    expect(screen.getByText("Super Metroid")).toBeInTheDocument();
  });

  it("hides the clear button when nothing is watched", async () => {
    serve({ items: [] });
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText(/Nothing watched yet/);
    expect(screen.queryByRole("button", { name: /clear watchlist/i })).not.toBeInTheDocument();
  });

  it("shows the shop's own quote when the display currency is the shop's", async () => {
    // CeX UK quoted £45; the USD twin would come back as £44.91
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/api/fx")) {
          return new Response(JSON.stringify({ base: "USD", to: "GBP", rate: 0.7583, fetchedAt: null, mode: "auto" }));
        }
        return new Response(
          JSON.stringify({
            items: [
              item({
                id: 1,
                game: { id: 7, title: "Jurassic Park", platform: "snes", year: 1993, coverUrl: null },
                storeOffer: cexQuote("sell", "CeX UK sells for", 59.22, 45),
                storeSource: "cex",
              }),
            ],
          }),
        );
      }),
    );
    await setDisplayCurrency("GBP");
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Jurassic Park");
    expect(rightOf("Jurassic Park")).toHaveTextContent("£45.00");
    expect(rightOf("Jurassic Park")).not.toHaveTextContent("£44.91");
    resetMoneyForTests();
  });
});

describe("WatchlistScreen sparklines", () => {
  beforeEach(showAll);

  const routed = (sparks: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith("/api/watchlist/sparklines")
          ? sparks instanceof Error
            ? new Response("down", { status: 500 })
            : new Response(JSON.stringify(sparks))
          : new Response(JSON.stringify(response)),
      ),
    );

  it("watchlist rows show their sparkline", async () => {
    routed({ days: 90, series: { 1: [{ day: "2026-10-01", usd: 20 }, { day: "2026-10-18", usd: 25 }] } });
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    await waitFor(() => expect(rightOf("Super Metroid").querySelector(".spark-change")?.textContent).toBe("+25%"));
    expect(rightOf("EarthBound").querySelector(".spark-change")).toBeNull();
  });

  it("a failed sparkline request leaves the rows as they were", async () => {
    routed(new Error("down"));
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText("Super Metroid");
    expect(rightOf("Super Metroid")).toHaveTextContent("CeX UK sells for $25.00");
    expect(document.querySelector(".spark-change")).toBeNull();
  });
});
