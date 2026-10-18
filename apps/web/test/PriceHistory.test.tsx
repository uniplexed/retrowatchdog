import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PriceHistory, atQuotedRate } from "../src/components/PriceHistory.js";
import { resetMoneyForTests } from "../src/lib/money.js";
import type { HistoryResponse, HistorySeriesDto } from "@retrowatchdog/shared";

// The sources registry itself is seeded by test/setup.ts's global beforeEach
// (SOURCES_FIXTURE, which carries CeX UK's real kindLabels) — this suite only
// stubs the one endpoint PriceHistory calls.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
});

/** Stubs GET /api/games/:id/history to answer with `response`; anything else throws. */
function stubHistory(response: HistoryResponse): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/history")) return new Response(JSON.stringify(response));
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubHistoryError(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/history")) throw new Error("network fail");
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const oneSeries: HistoryResponse = {
  region: "PAL",
  condition: "cib",
  days: 30,
  from: "2026-09-15",
  to: "2026-09-16",
  series: [
    {
      source: "cex",
      kind: "sell",
      role: "buy_store",
      points: [
        { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
        { day: "2026-09-16", usd: 44, original: { amount: 44, currency: "USD" } },
      ],
    },
  ],
};

describe("PriceHistory", () => {
  it("asks the user to choose when either picker is on all, and fetches nothing", async () => {
    const fetchMock = stubHistory(oneSeries);
    render(<PriceHistory gameId={1} title="Pilotwings 64" region="all" condition="cib" />);
    expect(screen.getByText(/pick a region/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the chart straight away under a titled panel, with one fetch", async () => {
    const fetchMock = stubHistory(oneSeries);
    render(<PriceHistory gameId={1} title="Pilotwings 64" region="PAL" condition="cib" />);
    expect(screen.getByRole("heading", { name: /^Price history · PAL · cib/ })).toBeInTheDocument();
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists each series with its latest value and its change over the window", async () => {
    stubHistory(oneSeries);
    render(<PriceHistory gameId={1} title="Pilotwings 64" region="PAL" condition="cib" />);
    const row = await screen.findByText(/CeX UK sells/);
    expect(row).toBeInTheDocument();
    expect(screen.getByText(/\+10%/)).toBeInTheDocument();
  });

  it("says which days the change actually spans when they are not the window's edges", async () => {
    stubHistory({
      region: "PAL",
      condition: "cib",
      days: 30,
      from: "2026-08-18",
      to: "2026-09-17",
      series: [
        {
          source: "cex",
          kind: "sell",
          role: "buy_store",
          points: [
            { day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } },
            { day: "2026-09-17", usd: 44, original: { amount: 44, currency: "USD" } },
          ],
        },
      ],
    });
    render(<PriceHistory gameId={1} title="Pilotwings 64" region="PAL" condition="cib" />);
    expect(await screen.findByText(/2026-09-15 to 2026-09-17/)).toBeInTheDocument();
  });

  it("says so plainly when the window holds nothing", async () => {
    stubHistory({ region: "PAL", condition: "cib", days: 30, from: "2026-08-18", to: "2026-09-17", series: [] });
    render(<PriceHistory gameId={1} title="Pilotwings 64" region="PAL" condition="cib" />);
    expect(await screen.findByText("No prices stored for this window.")).toBeInTheDocument();
  });

  it("says so when the request fails, and keeps the section usable", async () => {
    stubHistoryError();
    render(<PriceHistory gameId={1} title="Pilotwings 64" region="PAL" condition="cib" />);
    expect(await screen.findByText("Could not load the history.")).toBeInTheDocument();
  });

  it("states a single-day span as 'on <day>', not '<day> to <day>'", async () => {
    stubHistory({
      region: "PAL",
      condition: "cib",
      days: 30,
      from: "2026-08-18",
      to: "2026-09-17",
      series: [
        {
          source: "cex",
          kind: "sell",
          role: "buy_store",
          points: [{ day: "2026-09-15", usd: 40, original: { amount: 40, currency: "USD" } }],
        },
      ],
    });
    render(<PriceHistory gameId={1} title="Pilotwings 64" region="PAL" condition="cib" />);
    expect(await screen.findByText(/on 2026-09-15/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-15 to 2026-09-15/)).not.toBeInTheDocument();
  });

  it("refetches for the new state when the filters move, and not while they are on all", async () => {
    const fetchMock = stubHistory(oneSeries);
    const { rerender } = render(
      <PriceHistory gameId={1} title="Pilotwings 64" region="PAL" condition="cib" />,
    );
    await screen.findByRole("img");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<PriceHistory gameId={1} title="Pilotwings 64" region="all" condition="cib" />);
    expect(await screen.findByText(/pick a region/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<PriceHistory gameId={1} title="Pilotwings 64" region="NTSC_U" condition="cib" />);
    await screen.findByRole("img");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0]), "http://test").searchParams.get("region")).toBe("NTSC_U");
  });
});

describe("atQuotedRate", () => {
  const series = (points: HistorySeriesDto["points"]): HistorySeriesDto => ({
    source: "cex",
    kind: "sell",
    role: "buy_store",
    points,
  });

  it("draws a price nobody changed as flat, however the pound moved", () => {
    // THE CASE THIS EXISTS FOR, measured: game 220's CeX shelf price was
    // GBP 295.00 on every row of its window, and its frozen USD twin climbed
    // with the exchange rate -- a chart of a price rise that never happened.
    const plotted = atQuotedRate(
      series([
        { day: "2026-09-15", usd: 390.0, original: { amount: 295, currency: "GBP" } },
        { day: "2026-09-16", usd: 393.5, original: { amount: 295, currency: "GBP" } },
        { day: "2026-09-17", usd: 397.25, original: { amount: 295, currency: "GBP" } },
      ]),
    );
    const values = plotted.points.map((p) => p.usd);
    expect(new Set(values).size).toBe(1);
    // and the newest point is still exactly its true USD value, so the axis
    // and every other amount on the screen agree with it
    expect(values[2]).toBeCloseTo(397.25, 10);
  });

  it("still moves where the source's own price did", () => {
    const plotted = atQuotedRate(
      series([
        { day: "2026-09-15", usd: 50, original: { amount: 40, currency: "GBP" } },
        { day: "2026-09-16", usd: 65, original: { amount: 50, currency: "GBP" } },
      ]),
    );
    // a 25% rise in the quote is a 25% rise on the chart, at one rate
    expect(plotted.points[1].usd / plotted.points[0].usd).toBeCloseTo(50 / 40, 10);
  });

  it("leaves a series in more than one currency as frozen USD", () => {
    // no single quote to follow, and frozen USD is the honest fallback
    const mixed = series([
      { day: "2026-09-15", usd: 50, original: { amount: 40, currency: "GBP" } },
      { day: "2026-09-16", usd: 55, original: { amount: 50, currency: "EUR" } },
    ]);
    expect(atQuotedRate(mixed)).toBe(mixed);
  });

  it("leaves a series whose newest quote is zero untouched", () => {
    const zero = series([{ day: "2026-09-15", usd: 0, original: { amount: 0, currency: "GBP" } }]);
    expect(atQuotedRate(zero)).toBe(zero);
  });
});
