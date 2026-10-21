import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionHistoryResponse } from "@retrowatchdog/shared";
import { resolvePeriod } from "../src/lib/period.js";
import { CollectionValueHistory } from "../src/components/CollectionValueHistory.js";
import { resetMoneyForTests } from "../src/lib/money.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
});

const markets = { country: "GB" as const, includeForeign: false };

describe("CollectionValueHistory", () => {
  it("fetches only when opened, for the screen's basis and markets, and charts estimated and paid", async () => {
    const history: CollectionHistoryResponse = {
      valuationBasis: "trade_in", valuationMarkets: markets, days: 180, from: "2026-04-01", to: "2026-09-27",
      points: [
        { day: "2026-09-26", estimatedUsd: 500, paidUsd: 300 },
        { day: "2026-09-27", estimatedUsd: 520, paidUsd: 300 },
      ],
    };
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(history)));
    vi.stubGlobal("fetch", fetchMock);
    render(<CollectionValueHistory basis="trade_in" markets={markets} />);
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^Value history/ }));
    expect(await screen.findByRole("img")).toHaveAccessibleName(/your collection/);
    // the shared period (90 days by default), as explicit dates
    const { from, to } = resolvePeriod({ preset: "90d" });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/collection/history?valuation=trade_in&country=GB&includeForeign=false&from=${from}&to=${to}`);
    // the legend gives each line its latest value
    expect(screen.getByText("Estimated").closest("li")).toHaveTextContent("$520.00");
    expect(screen.getByText("Paid").closest("li")).toHaveTextContent("$300.00");
  });

  it("says why the chart is empty before the first day is recorded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      valuationBasis: "market", valuationMarkets: markets, days: 180, from: "2026-04-01", to: "2026-09-27", points: [],
    }))));
    render(<CollectionValueHistory basis="market" markets={markets} />);
    await userEvent.click(screen.getByRole("button", { name: /^Value history/ }));
    expect(await screen.findByText(/No days recorded yet/)).toBeInTheDocument();
  });
});
