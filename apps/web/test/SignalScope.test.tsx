import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PricesResponse } from "@retrowatchdog/shared";
import { GameDetail } from "../src/screens/GameDetail.js";
import { resetMoneyForTests } from "../src/lib/money.js";

const game = { id: 271, title: "Final Fantasy Tactics Advance", platform: "gba" as const, year: 2003, coverUrl: null };
const pt = (region: string, condition: string) => ({ source: "ebay_uk", kind: "active_listing", region, condition, priceUsd: 20, priceOriginal: 16, currencyOriginal: "GBP", available: null });
const prices: PricesResponse = {
  game,
  sources: [{ source: "ebay_uk", status: "ok", fetchedAt: "2026-10-18T10:00:00Z", points: [pt("PAL", "cib"), pt("PAL", "cib"), pt("PAL", "loose"), pt("NTSC_U", "cib")] }],
  signals: [],
  gamePriceMode: null,
} as unknown as PricesResponse;
const watch = (id: number, region: string | null, condition: string | null) => ({
  id, game, region, condition, targetPriceOriginal: null, targetCurrency: null, targetPriceUsd: null,
  storeOffer: null, storeBids: [], storeSource: null, priceDisplayAt: null, signalsAboveTarget: 0, signals: [],
});
const copy = { id: 9, game, region: "NTSC_U", condition: "loose", status: "owned", signals: [], estimatedValueUsd: null, valueBasis: null };

function stub(watches: unknown[], copies: unknown[]) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") return new Response(JSON.stringify({ id: 77 }), { status: 201 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (u.includes("/prices")) return new Response(JSON.stringify(prices));
    if (u.includes("/history")) return new Response(JSON.stringify({ region: "PAL", condition: "cib", days: 90, from: "", to: "", series: [] }));
    if (u.includes("/api/watchlist")) return new Response(JSON.stringify({ items: watches }));
    if (u.includes("/api/collection")) {
      return new Response(JSON.stringify({ items: copies, totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false } }));
    }
    if (u.includes("/api/fx")) return new Response(JSON.stringify({ base: "USD", to: "USD", rate: 1, fetchedAt: new Date().toISOString(), mode: "auto" }));
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const lastPricesUrl = (fetchMock: ReturnType<typeof vi.fn>): URL =>
  new URL(String([...fetchMock.mock.calls].reverse().find(([u]) => String(u).includes("/prices"))![0]), "http://test");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  window.localStorage.clear();
});

describe("Barks (Signals) for", () => {
  it("lists Any state, each watch with a fixed state and each copy", async () => {
    stub([watch(4, "PAL", "cib"), watch(5, null, null)], [copy]);
    render(<GameDetail game={game} onBack={() => {}} />);
    const select = await screen.findByRole("combobox", { name: "Barks (Signals) for" });
    await waitFor(() =>
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Any state",
        "Watch · PAL · cib",
        "Your copy · NTSC_U · loose",
      ]),
    );
  });

  it("starts on the fixed watch and judges the signals for its state", async () => {
    const fetchMock = stub([watch(4, "PAL", "cib")], [copy]);
    render(<GameDetail game={game} onBack={() => {}} />);
    await waitFor(() => expect(lastPricesUrl(fetchMock).searchParams.get("signalCondition")).toBe("cib"));
    expect(lastPricesUrl(fetchMock).searchParams.get("signalRegion")).toBe("PAL");
    // the price table's chips stay as they were
    expect(lastPricesUrl(fetchMock).searchParams.get("region")).toBeNull();
  });

  it("Any state drops the signal scope", async () => {
    const fetchMock = stub([watch(4, "PAL", "cib")], []);
    render(<GameDetail game={game} onBack={() => {}} />);
    const select = await screen.findByRole("combobox", { name: "Barks (Signals) for" });
    await waitFor(() => expect(lastPricesUrl(fetchMock).searchParams.get("signalCondition")).toBe("cib"));
    await userEvent.selectOptions(select, "Any state");
    await waitFor(() => expect(lastPricesUrl(fetchMock).searchParams.get("signalCondition")).toBeNull());
  });

  it("the choice is remembered per title", async () => {
    const fetchMock = stub([watch(4, "PAL", "cib")], [copy]);
    const { unmount } = render(<GameDetail game={game} onBack={() => {}} />);
    const select = await screen.findByRole("combobox", { name: "Barks (Signals) for" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    await userEvent.selectOptions(select, "Your copy · NTSC_U · loose");
    unmount();
    render(<GameDetail game={game} onBack={() => {}} />);
    await waitFor(() => expect(lastPricesUrl(fetchMock).searchParams.get("signalCondition")).toBe("loose"));
    expect((screen.getByRole("combobox", { name: "Barks (Signals) for" }) as HTMLSelectElement).value).toBe("c:9");
  });

  it("no selector when there is nothing but Any state", async () => {
    stub([watch(5, null, null)], []);
    render(<GameDetail game={game} onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Loading prices…")).toBeNull());
    expect(screen.queryByRole("combobox", { name: "Barks (Signals) for" })).toBeNull();
  });
});

describe("the Watch button", () => {
  it("watches the state the page's filters show", async () => {
    const fetchMock = stub([], []);
    render(<GameDetail game={game} onBack={() => {}} />);
    await userEvent.click(within(await screen.findByRole("group", { name: "Condition filter" })).getByRole("button", { name: "cib" }));
    await userEvent.click(await screen.findByRole("button", { name: "☆ Watch · any · cib" }));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ gameId: game.id, condition: "cib" });
    expect(await screen.findByRole("button", { name: "★ Watching · any · cib" })).toBeInTheDocument();
  });

  it("a watch already on these filters reads Watching and is the one removed", async () => {
    const fetchMock = stub([watch(5, null, null), watch(4, "PAL", "cib")], []);
    render(<GameDetail game={game} onBack={() => {}} />);
    await userEvent.click(within(await screen.findByRole("group", { name: "Region filter" })).getByRole("button", { name: "PAL" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Condition filter" })).getByRole("button", { name: "cib" }));
    await userEvent.click(await screen.findByRole("button", { name: "★ Watching · PAL · cib" }));
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(String(del[0])).toContain("/api/watchlist/4");
  });
});

describe("the game's price history", () => {
  const historyUrl = (fetchMock: ReturnType<typeof vi.fn>) =>
    new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes("/history"))![0]), "http://test");

  it("with the filters on all, it charts the most common state", async () => {
    const fetchMock = stub([], []);
    render(<GameDetail game={game} onBack={() => {}} />);
    expect(await screen.findByRole("heading", { name: /^Price history · PAL · cib/ })).toBeInTheDocument();
    await waitFor(() => expect(historyUrl(fetchMock).searchParams.get("region")).toBe("PAL"));
    expect(historyUrl(fetchMock).searchParams.get("condition")).toBe("cib");
  });

  it("the signal scope's state wins over the most common one", async () => {
    stub([watch(4, null, "loose")], []);
    render(<GameDetail game={game} onBack={() => {}} />);
    expect(await screen.findByRole("heading", { name: /^Price history · PAL · loose/ })).toBeInTheDocument();
  });
});
