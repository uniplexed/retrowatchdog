import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import { GameDetail } from "../src/screens/GameDetail.js";
import {
  getSourcesSnapshot,
  loadSources,
  resetSourcesForTests,
  setSourcesForTests,
} from "../src/lib/sources.js";
import { resetMoneyForTests } from "../src/lib/money.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";
import type {
  CollectionResponse,
  PricesResponse,
  SearchResponse,
  WatchlistResponse,
} from "@retrowatchdog/shared";

/**
 * What the user sees when the app does not know its own sources.
 *
 * The registry is not a table of labels. It is where `kindRoles` lives, and
 * `kindRoles` is what says that CeX both CHARGES you (`buy_store`) and PAYS
 * you (`bid`) — which is what earns its block the buy/sell switch and the
 * in-stock split. Without the registry every shop reads as one-sided, so
 * "CeX sells for £45" and "CeX pays voucher £30" land in one table with no
 * switch above them: two numbers that mean opposite things, presented as one
 * list. In an app whose whole job is telling those apart, that is worse than
 * showing nothing.
 *
 * So the game view shows nothing there until it knows, and says why. These
 * tests pin both halves — what is hidden, and that it comes back.
 */

const game = { id: 7, title: "Ocarina of Time", platform: "n64" as const, year: 1998, coverUrl: null };

/** one CeX block carrying BOTH directions — the split the registry decides */
const twoSidedPrices: PricesResponse = {
  game,
  sources: [
    {
      source: "cex",
      status: "ok",
      fetchedAt: "2026-09-03T10:00:00Z",
      points: [
        { source: "cex", kind: "sell", region: "PAL", condition: "cib", priceUsd: 60, priceOriginal: 45, currencyOriginal: "GBP", available: true },
        { source: "cex", kind: "voucher", region: "PAL", condition: "cib", priceUsd: 40, priceOriginal: 30, currencyOriginal: "GBP", available: true },
      ],
    },
  ],
  signals: [],
  gamePriceMode: null,
};

const emptyCollection: CollectionResponse = {
  items: [], valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
  totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0,
};
const emptyWatchlist: WatchlistResponse = { items: [] };
const searchResponse: SearchResponse = { games: [] };

/**
 * The game view's own fetches always succeed; only /api/sources is switchable,
 * because the point of these tests is a screen whose PRICES arrived and whose
 * REGISTRY did not.
 */
function stubFetch(sourcesOk: boolean): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === "/api/sources") {
        return sourcesOk
          ? new Response(JSON.stringify({ sources: SOURCES_FIXTURE }))
          : new Response("nope", { status: 500 });
      }
      if (u.includes("/prices")) return new Response(JSON.stringify(twoSidedPrices));
      // the game page's price history panel loads on mount
      if (u.includes("/history")) {
        return new Response(JSON.stringify({ region: "PAL", condition: "cib", days: 30, from: "2026-08-04", to: "2026-09-03", series: [] }));
      }
      if (u.includes("/collection")) return new Response(JSON.stringify(emptyCollection));
      if (u.includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
      if (u.includes("/api/search")) return new Response(JSON.stringify(searchResponse));
      if (u.includes("/api/fx")) {
        return new Response(JSON.stringify({ base: "USD", to: "USD", rate: 1, fetchedAt: null, mode: "auto" }));
      }
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

describe("the game view while the source registry is unknown", () => {
  it("shows no price table and says it is still loading the source details", async () => {
    // The boot state: prices have landed, the registry has not.
    resetSourcesForTests();
    stubFetch(true);
    render(<GameDetail game={game} onBack={() => {}} />);

    expect(await screen.findByText(/Loading source details/)).toBeInTheDocument();
    // no block, no table, and above all neither side of the trade on screen
    expect(screen.queryByRole("heading", { name: "To buy" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/sells for/)).toBeNull();
    expect(screen.queryByText(/pays voucher/)).toBeNull();
    // the rest of the screen is untouched: this is a smaller screen, not a
    // broken one
    expect(screen.getByText("← Back")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh now/ })).toBeInTheDocument();
  });

  it("says the load failed, offers a retry, and brings the buy/sell split back when it succeeds", async () => {
    resetSourcesForTests();
    stubFetch(false);
    await act(async () => {
      await loadSources();
    });
    render(<GameDetail game={game} onBack={() => {}} />);

    // what the user reads: a stated reason, not a screen that looks complete
    expect(await screen.findByText(/could not load this deployment's source details/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/pays voucher/)).toBeNull();

    // and the failure is recoverable: the retry is the app's status band
    // (tested below); here the registry simply arrives
    stubFetch(true);
    await act(async () => {
      await loadSources();
    });

    // the split is back: what CeX charges and what it pays, in two tables
    const buy = (await screen.findByRole("heading", { name: "To buy" })).closest("section") as HTMLElement;
    const pay = screen.getByRole("heading", { name: "Shops pay you" }).closest("section") as HTMLElement;
    expect(within(buy).getByText(/CeX UK sells for/)).toBeInTheDocument();
    expect(within(buy).queryByText(/pays voucher/)).toBeNull();
    expect(within(pay).getByText(/CeX UK pays voucher/)).toBeInTheDocument();
  });

  it("renders the whole block once the registry is known, so the gate is hiding something real", async () => {
    // The contrast case. Without it the two tests above would pass just as
    // well against a screen that never had a CeX block to show.
    setSourcesForTests(SOURCES_FIXTURE);
    stubFetch(true);
    render(<GameDetail game={game} onBack={() => {}} />);

    await screen.findByRole("heading", { name: "To buy" });
    expect(screen.getByRole("heading", { name: "Shops pay you" })).toBeInTheDocument();
    expect(screen.queryByText(/Loading source details/)).toBeNull();
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });
});

describe("the app banner for a failed registry", () => {
  it("tells the user that source details are missing, and retries from there", async () => {
    // The game view states its own loss; the banner is what stops the OTHER
    // tabs — which degrade to raw source ids — from looking complete.
    resetSourcesForTests();
    stubFetch(false);
    render(<App />);

    const banner = await screen.findByText(/Source details unavailable/);
    expect(banner).toBeInTheDocument();

    stubFetch(true);
    await userEvent.click(screen.getByRole("button", { name: /Retry sources/ }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Source details unavailable/)).toBeNull();
  });

  it("re-attempts the boot load on its own, with nobody pressing anything", async () => {
    // The moment this one request is most likely to fail is a redeploy — the
    // browser reaches the web container while the api container is still
    // starting — and it is also the moment it is most likely to succeed a
    // second later. With the banner's button as the only way back, a user who
    // opened the app during a deploy and looked away came back to a screen
    // that had given up on a deployment that had been healthy for minutes.
    //
    // The first rung of the ladder in src/lib/sources.ts is 1s of real time.
    resetSourcesForTests();
    let sourceCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === "/api/sources") {
          sourceCalls += 1;
          // only the FIRST attempt fails: the api container finishes starting
          return sourceCalls === 1
            ? new Response("nope", { status: 503 })
            : new Response(JSON.stringify({ sources: SOURCES_FIXTURE }));
        }
        if (u.includes("/api/search")) return new Response(JSON.stringify(searchResponse));
        if (u.includes("/api/fx")) {
          return new Response(
            JSON.stringify({ base: "USD", to: "USD", rate: 1, fetchedAt: null, mode: "auto" }),
          );
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
    render(<App />);

    expect(await screen.findByText(/Source details unavailable/)).toBeInTheDocument();
    expect(sourceCalls).toBe(1);

    // nothing below touches the retry button, or anything else
    await waitFor(() => expect(sourceCalls).toBe(2), { timeout: 4_000 });
    await waitFor(() =>
      expect(screen.queryByText(/Source details unavailable/)).toBeNull(),
    );
    expect(getSourcesSnapshot().byId.cex?.label).toBe("CeX UK");
  });

  it("stays quiet while the registry is merely loading", async () => {
    // A banner on every cold start is a banner nobody reads. Each screen
    // already shows its own loading state.
    resetSourcesForTests();
    stubFetch(true);
    render(<App />);

    expect(screen.queryByText(/Source details unavailable/)).toBeNull();
    await screen.findByPlaceholderText(/search a game/i);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Source details unavailable/)).toBeNull();
  });
});
