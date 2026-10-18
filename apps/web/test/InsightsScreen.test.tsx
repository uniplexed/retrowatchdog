import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InsightsResponse, Recommendation, ReliabilityRow, WatchlistHistoryResponse } from "@retrowatchdog/shared";
import { InsightsScreen } from "../src/screens/InsightsScreen.js";
import { WatchlistHistory } from "../src/components/WatchlistHistory.js";

const game = { id: 7, title: "Shenmue", platform: "dreamcast", year: 2000, coverUrl: null } as const;
const rec = (action: Recommendation["action"], title: string, over: Partial<Recommendation> = {}): Recommendation => ({
  action, subject: { kind: "watch", watchId: 1, game }, title, reason: "why", gainUsd: null, confidence: "high", since: "2026-10-18", ...over,
});
const rel = (over: Partial<ReliabilityRow>): ReliabilityRow => ({
  type: "UNDERPRICED", source: null, logged: 12, evaluated: 12, held: 9, beaten: 3, unknown: 0, heldPct: 75, meanGainUsd: 1.25, ...over,
});
const history: WatchlistHistoryResponse = {
  days: 90, from: "2026-07-21", to: "2026-10-18",
  points: [{ day: "2026-10-17", totalUsd: 300, covered: 20, of: 23 }, { day: "2026-10-18", totalUsd: 310, covered: 21, of: 23 }],
};

function stub(insights: InsightsResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith("/api/insights")) return new Response(JSON.stringify(insights));
      if (u.startsWith("/api/watchlist/history")) return new Response(JSON.stringify(history));
      if (u.startsWith("/api/collection/history")) return new Response(JSON.stringify({ ...history, points: [] }));
      return new Response("{}", { status: 404 });
    }),
  );
}
const base: InsightsResponse = { recommendations: [], reliability: [], measuredSince: null, computedAt: "2026-10-18T00:00:00Z" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InsightsScreen", () => {
  it("groups render in action order with counts", async () => {
    stub({ ...base, recommendations: [rec("sell_now", "Sell A"), rec("buy_now", "Buy B"), rec("buy_now", "Buy C"), rec("unwatch", "Stop D", { confidence: "potential" })] });
    render(<InsightsScreen onOpenGame={() => {}} onNavigate={() => {}} />);
    await screen.findByText("Sell A");
    const heads = [...document.querySelectorAll(".ui-panel h3")].map((h) => h.textContent);
    expect(heads.slice(0, 3)).toEqual(["Sell now (1)", "Buy now (2)", "Stop watching (1)"]);
    // a potential row is folded, never the lead line
    expect(screen.getByText("Stop D").closest("details")?.open).toBe(false);
  });

  it("reliability shows a dash under 10 judged and the honesty line", async () => {
    stub({ ...base, measuredSince: "2026-09-01T00:00:00.000Z", reliability: [rel({}), rel({ type: "NEW_LOW", held: 1, beaten: 2, heldPct: null })] });
    render(<InsightsScreen onOpenGame={() => {}} onNavigate={() => {}} />);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Underpriced");
    expect(rows[1]).toHaveTextContent("75%");
    expect(rows[2]).toHaveTextContent("—");
    expect(screen.getByText(/held means the price was not beaten/)).toHaveTextContent(
      "eBay and Vinted prices are asking prices, not sales: held means the price was not beaten, not that you could have bought at it.",
    );
    expect(screen.getByText(/Measured since/)).toBeInTheDocument();
  });

  it("each signal type has a readable name and a hover description with an example", async () => {
    stub({ ...base, measuredSince: "2026-09-01T00:00:00.000Z", reliability: [rel({})] });
    render(<InsightsScreen onOpenGame={() => {}} onNavigate={() => {}} />);
    await userEvent.hover(await screen.findByRole("button", { name: "About Underpriced" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(/under the market median/);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/e\.g\. /);
  });

  it("before any log row it says signals are being logged", async () => {
    stub(base);
    render(<InsightsScreen onOpenGame={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText("Barks (signals) are being logged; the first are judged 14 days after they appear.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Insights filters and sort", () => {
  const gba = { ...game, id: 8, title: "Advance Wars", platform: "gba" } as const;

  it("sorts every group by gain or title and filters by console", async () => {
    stub({
      ...base,
      recommendations: [
        rec("buy_now", "Buy Shenmue", { gainUsd: 5 }),
        rec("buy_now", "Buy Advance Wars", { gainUsd: 20, subject: { kind: "watch", watchId: 2, game: gba } }),
      ],
    });
    render(<InsightsScreen onOpenGame={() => {}} onNavigate={() => {}} />);
    await screen.findByText("Buy Shenmue");
    const titles = () => [...document.querySelectorAll(".ui-row-title")].map((t) => t.textContent);
    expect(titles()).toEqual(["Buy Shenmue", "Buy Advance Wars"]);
    await userEvent.click(screen.getByRole("button", { name: /Filters & sort/ }));
    await userEvent.click(within(screen.getByRole("group", { name: "Sort" })).getByRole("button", { name: "gain, high first" }));
    expect(titles()).toEqual(["Buy Advance Wars", "Buy Shenmue"]);
    await userEvent.click(within(screen.getByRole("group", { name: "Console" })).getByRole("button", { name: "GBA" }));
    expect(titles()).toEqual(["Buy Advance Wars"]);
  });

  it("the reliability table sorts by a column header", async () => {
    stub({ ...base, measuredSince: "2026-09-01T00:00:00.000Z", reliability: [rel({ type: "FLIP", logged: 3 }), rel({ type: "UNDERPRICED", logged: 40 })] });
    render(<InsightsScreen onOpenGame={() => {}} onNavigate={() => {}} />);
    const table = await screen.findByRole("table");
    const firstType = () => within(table).getAllByRole("row")[1].textContent;
    expect(firstType()).toContain("Flip");
    await userEvent.click(within(table).getByRole("button", { name: "Logged" }));
    expect(firstType()).toContain("Underpriced");
    expect(within(table).getByRole("columnheader", { name: /Logged/ })).toHaveAttribute("aria-sort", "descending");
  });
});

describe("WatchlistHistory", () => {
  it("watchlist history shows coverage of the last day", async () => {
    stub(base);
    render(<WatchlistHistory defaultOpen />);
    expect(await screen.findByText("Latest day: 21 of 23 watches priced")).toBeInTheDocument();
  });
});
