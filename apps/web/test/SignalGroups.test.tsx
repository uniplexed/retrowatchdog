import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Signal } from "@retrowatchdog/shared";
import { FindingsDisclosure, SignalGroups } from "../src/components/SignalGroups.js";
import { resetMoneyForTests, setDisplayCurrency } from "../src/lib/money.js";

/** /api/fx stub, same shape money.test.ts uses: known USD->currency rates. */
function stubFxFetch(rates: Record<string, number>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const to = new URL(String(url), "http://test").searchParams.get("to");
      const rate = to === null ? undefined : rates[to];
      if (rate === undefined) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ base: "USD", to, rate, fetchedAt: null, mode: "auto" }));
    }),
  );
}

const under = (source: string, usd: number, original: number, reasoning: string): Signal => ({
  type: "UNDERPRICED",
  reasoning,
  source,
  price: { usd, original, currency: "GBP" },
  confidence: "high",
  caveats: [],
});

afterEach(() => {
  cleanup();
  resetMoneyForTests();
  vi.unstubAllGlobals();
});

describe("FindingsDisclosure", () => {
  it("a group of one renders FLAT: the badge, no button, nothing to expand", () => {
    render(<FindingsDisclosure summary={<span>eBay UK</span>} signals={[under("ebay_uk", 19, 15, "only-one")]} />);
    expect(screen.getByText(/only-one/)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a group of two is a button that controls a region, collapsed to start", async () => {
    render(
      <FindingsDisclosure
        summary={<span>eBay UK</span>}
        signals={[under("ebay_uk", 19, 15, "first-one"), under("ebay_uk", 21, 17, "second-one")]}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
    // the region it names exists and holds the rows, hidden
    const regionId = button.getAttribute("aria-controls") as string;
    const region = document.getElementById(regionId) as HTMLElement;
    expect(region).not.toBeNull();
    expect(within(region).getByText(/first-one/)).not.toBeVisible();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(within(region).getByText(/first-one/)).toBeVisible();
    expect(within(region).getByText(/second-one/)).toBeVisible();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(within(region).getByText(/first-one/)).not.toBeVisible();
  });

  it("takes its accessible name from `label` when given, without changing the visible summary", () => {
    render(
      <FindingsDisclosure
        label="Buy to sell"
        summary={<span className="meta">(2)</span>}
        signals={[under("ebay_uk", 19, 15, "first-one"), under("ebay_uk", 21, 17, "second-one")]}
      />,
    );
    // the accessible name comes from the label…
    const button = screen.getByRole("button", { name: "Buy to sell" });
    // …but the rendered summary is untouched: still count-only, no amount
    expect(button).toHaveTextContent("(2)");
    expect(button).not.toHaveTextContent("Buy to sell");
  });
});

describe("SignalGroups", () => {
  it("heads each group with its source, its count and its best amount", () => {
    render(
      <SignalGroups
        signals={[under("ebay_uk", 21, 17, "dearer"), under("ebay_uk", 19, 15, "cheaper"), under("cex", 40, 32, "cex-one")]}
        side="min"
      />,
    );
    // display currency is USD here: the converted twin is what renders
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("eBay UK");
    expect(button).toHaveTextContent("(2)");
    expect(button).toHaveTextContent("$19.00");
    // the single CeX finding stays flat beside it
    expect(screen.getByText(/cex-one/)).toBeVisible();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("shows the verbatim original in the header when the display currency IS the original's", async () => {
    // The whole reason price is a triple and not a number. The rate is a
    // deliberate 0.5, not a realistic 0.79: dropping the second argument to
    // formatMoney would print the ROUND TRIP, and at 0.79 that is £15.01
    // against the verbatim £15.00 — a guard one penny wide, which any later
    // edit to the fixture could close by accident. At 0.5 the two renderings
    // are £9.50 and £15.00 and cannot be confused. (Both checked in node:
    // 19 * 0.79 formats as £15.01, 19 * 0.5 as £9.50.)
    stubFxFetch({ GBP: 0.5 });
    await setDisplayCurrency("GBP");
    render(
      <SignalGroups signals={[under("ebay_uk", 21, 17, "dearer"), under("ebay_uk", 19, 15, "cheaper")]} side="min" />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("£15.00");
  });

  it("gives a source-less group of multiple findings an accessible label, not a bare count", () => {
    // Not reachable from today's four emission sites (all set `source`), but
    // the type allows it and groupSignalsBySource explicitly buckets it —
    // without a label this button's only accessible name would be "(2)
    // $19.00", naming nothing about what it expands.
    const orphan = (usd: number, original: number, reasoning: string): Signal => ({
      type: "UNDERPRICED",
      reasoning,
      price: { usd, original, currency: "GBP" },
      confidence: "high",
      caveats: [],
    });
    render(<SignalGroups signals={[orphan(19, 15, "first-one"), orphan(21, 17, "second-one")]} side="min" />);
    const button = screen.getByRole("button", { name: "Ungrouped findings" });
    expect(button).toHaveTextContent("(2)");
  });
});
