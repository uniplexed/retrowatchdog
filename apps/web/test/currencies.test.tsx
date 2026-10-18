import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CurrencySelector } from "../src/components/CurrencySelector.js";
import { CurrenciesBlock } from "../src/components/CurrenciesBlock.js";
import { offered, resetCurrenciesForTests } from "../src/lib/currencies.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function stub(enabled: string[]) {
  let current = enabled;
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/settings/currencies" && init?.method === "PUT") {
      const next = (JSON.parse(String(init.body)) as { enabled: string[] }).enabled;
      current = ["USD", ...next.filter((c) => c !== "USD")];
      return json({ enabled: current });
    }
    if (u === "/api/settings/currencies") return json({ enabled: current });
    if (u.startsWith("/api/fx")) return json({ base: "USD", to: "GBP", rate: 0.8, fetchedAt: null, mode: "auto" });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCurrenciesForTests();
});

describe("enabled currencies", () => {
  it("offered keeps a value that is no longer enabled", () => {
    expect(offered(["USD", "GBP"], "MXN")).toEqual(["USD", "GBP", "MXN"]);
    expect(offered(["USD", "GBP"], "GBP")).toEqual(["USD", "GBP"]);
  });

  it("the currency menu lists only the enabled ones", async () => {
    stub(["USD", "GBP", "MXN"]);
    render(<CurrencySelector />);
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["USD", "GBP", "MXN"]));
  });

  it("Add currency enables one from the rest", async () => {
    const fetchMock = stub(["USD", "GBP"]);
    render(<CurrenciesBlock />);
    await screen.findByText("GBP");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add currency" }), "MXN");
    await screen.findByText("MXN");
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ enabled: ["USD", "GBP", "MXN"] });
  });

  it("a currency can be removed, but not USD", async () => {
    stub(["USD", "GBP", "EUR"]);
    render(<CurrenciesBlock />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove EUR" }));
    await waitFor(() => expect(within(screen.getByRole("list")).queryByText("EUR")).toBeNull());
    expect(screen.queryByRole("button", { name: "Remove USD" })).toBeNull();
  });
});
