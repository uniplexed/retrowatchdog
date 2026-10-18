import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import { formatMoney, resetMoneyForTests } from "../src/lib/money.js";
import type { FxSettingsResponse } from "@retrowatchdog/shared";

// The App boots on the Search screen, which fetches nothing until a query is
// typed — so these stubs only need /api/fx (and /api/settings/fx for the tab).
const emptySettings: FxSettingsResponse = { currencies: [] };

function stubFetch(rates: Record<string, number>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u === "/api/settings/fx") return new Response(JSON.stringify(emptySettings));
    if (u.includes("/api/fx")) {
      const to = new URL(u, "http://test").searchParams.get("to");
      const rate = to === null ? undefined : rates[to];
      if (rate === undefined) {
        return new Response(JSON.stringify({ error: "FX unavailable" }), { status: 503 });
      }
      return new Response(
        JSON.stringify({ base: "USD", to, rate, fetchedAt: new Date().toISOString(), mode: "auto" }),
      );
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  window.localStorage.clear();
});

describe("App display-currency selector", () => {
  it("boots in USD with no FX fetch and shows the header selector on every screen", async () => {
    const fetchMock = stubFetch({});
    render(<App />);
    const select = screen.getByLabelText(/currency/i) as HTMLSelectElement;
    expect(select.value).toBe("USD");
    // still there after switching tabs
    await userEvent.click(screen.getByRole("button", { name: "Watch" }));
    expect(screen.getByLabelText(/currency/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/fx")).length).toBe(0);
  });

  it("switches the display currency, converts via the fetched rate and persists the pick", async () => {
    stubFetch({ EUR: 0.9 });
    render(<App />);
    await userEvent.selectOptions(screen.getByLabelText(/currency/i), "EUR");
    await waitFor(() => expect(formatMoney(100)).toBe("€90.00"));
    expect(window.localStorage.getItem("displayCurrency")).toBe("EUR");
  });

  it("restores the persisted currency on boot", async () => {
    window.localStorage.setItem("displayCurrency", "EUR");
    const fetchMock = stubFetch({ EUR: 0.9 });
    render(<App />);
    await waitFor(() =>
      expect((screen.getByLabelText(/currency/i) as HTMLSelectElement).value).toBe("EUR"),
    );
    await waitFor(() => expect(formatMoney(100)).toBe("€90.00"));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/fx?to=EUR"))).toBe(true);
  });

  it("shows the USD-fallback note when FX is down and keeps amounts in USD", async () => {
    stubFetch({}); // every /api/fx call 503s
    render(<App />);
    await userEvent.selectOptions(screen.getByLabelText(/currency/i), "EUR");
    // wording change: originals quoted in the display currency need no rate,
    // so only the converted amounts fall back to USD
    expect(await screen.findByText("FX unavailable — converted prices shown in USD")).toBeInTheDocument();
    expect(formatMoney(100)).toBe("$100.00");
  });

  it("opens the Settings tab from the tabbar", async () => {
    stubFetch({});
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Currencies", { selector: "summary" })).toBeInTheDocument();
  });
});
