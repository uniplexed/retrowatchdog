import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RECOMMENDATION_DEFAULTS, SIGNAL_TYPES, type SignalConfigDto } from "@retrowatchdog/shared";
import { SignalSettings } from "../src/components/SignalSettings.js";

const stored: SignalConfigDto = {
  underpricedFactor: 0.7, overpricedFactor: 1.3, flipFactor: 1.15, profitFactor: 1.15, crossStoreFactor: 0.85, minSample: 5,
  priceDropPct: 15, priceDropDays: 7, newLowDays: 90, risingPct: 20, risingDays: 30,
  enabledTypes: SIGNAL_TYPES.filter((t) => t !== "INSUFFICIENT_DATA"),
  excludedSources: [], minGain: null, alertLowConfidence: false,
  ...RECOMMENDATION_DEFAULTS,
};

interface Call { url: string; method: string; body: unknown }

const enoughHistory = {
  basis: "From 23 watched slices over 60 days of prices",
  values: { quietDays: 60 },
  notes: { quietDays: "9 in 10 price changes come sooner than this" },
};

function stubApi(opts: { putStatus?: number; suggested?: unknown } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === "/api/settings/signals" && method === "GET") return new Response(JSON.stringify(stored));
      if (url === "/api/settings/signals" && method === "PUT") {
        if (opts.putStatus === 400) return new Response(JSON.stringify({ error: "invalid signal configuration: flipFactor too small" }), { status: 400 });
        return new Response(JSON.stringify(body));
      }
      if (url === "/api/settings/signals/suggested") {
        return new Response(JSON.stringify(opts.suggested ?? { basis: null, values: {}, notes: { history: "not enough history yet" } }));
      }
      if (url === "/api/settings/signals/reset") return new Response(JSON.stringify(stored));
      if (url === "/api/settings/signals/preview") {
        return new Response(JSON.stringify({ watches: 23, withSignal: body.underpricedFactor > 0.6 ? 4 : 1, example: { title: "Final Fantasy Tactics Advance", verdictTitle: "Buy on eBay UK for £31.90" }, recommendations: { sellNow: 3, buyNow: 5, targets: 2, cleanUps: 7 } }));
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SignalSettings", () => {
  it("loads the stored values and previews them", async () => {
    stubApi();
    render(<SignalSettings />);
    expect(await screen.findByLabelText("Underpriced below × median")).toHaveValue(0.7);
    expect(screen.getByRole("switch", { name: "Flip" })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText(/With these values, 4 of 23 watches have a bark \(signal\)/)).toHaveTextContent(
      "Final Fantasy Tactics Advance: Buy on eBay UK for £31.90",
    );
  });

  it("saves a switched-off type as the whole configuration", async () => {
    const calls = stubApi();
    render(<SignalSettings />);
    await userEvent.click(await screen.findByRole("switch", { name: "Flip" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!.body as SignalConfigDto;
    expect(put.enabledTypes).not.toContain("FLIP");
    expect(put.underpricedFactor).toBe(0.7);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("previews an edited threshold before saving it", async () => {
    const calls = stubApi();
    render(<SignalSettings />);
    const field = await screen.findByLabelText("Underpriced below × median");
    await userEvent.clear(field);
    await userEvent.type(field, "0.5");
    await waitFor(
      () => expect(calls.some((c) => c.url.endsWith("/preview") && (c.body as SignalConfigDto).underpricedFactor === 0.5)).toBe(true),
      { timeout: 2000 },
    );
    expect(await screen.findByText(/1 of 23 watches/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("restores the defaults", async () => {
    const calls = stubApi();
    render(<SignalSettings />);
    const field = await screen.findByLabelText("Price drop %");
    await userEvent.clear(field);
    await userEvent.type(field, "40");
    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/reset"))).toBe(true));
    await waitFor(() => expect(screen.getByLabelText("Price drop %")).toHaveValue(15));
  });

  it("says a refused save in plain words, never the API's field names", async () => {
    stubApi({ putStatus: 400 });
    render(<SignalSettings />);
    await screen.findByLabelText("Underpriced below × median");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A value is out of range. Check the thresholds and save again.")).toBeInTheDocument();
    expect(screen.queryByText(/flipFactor/)).toBeNull();
  });

  it("asks for a number in an emptied threshold instead of saving", async () => {
    const calls = stubApi();
    render(<SignalSettings />);
    await userEvent.clear(await screen.findByLabelText("Rising %"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Every threshold needs a number.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("sets a minimum gain with its currency and the low-confidence alert switch", async () => {
    const calls = stubApi();
    render(<SignalSettings />);
    const scope = (await screen.findByRole("heading", { name: "Scope" })).closest("section") as HTMLElement;
    await userEvent.type(within(scope).getByLabelText("Minimum gain"), "5");
    await userEvent.selectOptions(within(scope).getByLabelText("Gain currency"), "GBP");
    await userEvent.click(within(scope).getByRole("switch", { name: "Send low-confidence alerts" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!.body as SignalConfigDto;
    expect(put.minGain).toEqual({ amount: 5, currency: "GBP" });
    expect(put.alertLowConfidence).toBe(true);
  });

  describe("Recommendations block", () => {
    const panel = async () => (await screen.findByRole("heading", { name: "Recommendations" })).closest(".ui-panel") as HTMLElement;

    it("each recommendation field shows its recommended value", async () => {
      stubApi();
      render(<SignalSettings />);
      const p = await panel();
      expect(within(p).getByLabelText("Stop watching / check copy after (days)")).toHaveValue(120);
      expect(within(p).getAllByText(/^Recommended: /)).toHaveLength(Object.keys(RECOMMENDATION_DEFAULTS).length);
      expect(within(p).queryByRole("button", { name: /^Use / })).toBeNull();
    });

    it("Use puts the recommended value back and unmarks the field", async () => {
      stubApi();
      render(<SignalSettings />);
      const p = await panel();
      const field = within(p).getByLabelText("Buy: % under the average");
      await userEvent.clear(field);
      await userEvent.type(field, "30");
      expect(field.closest(".ui-field")).toHaveClass("off-default");
      await userEvent.click(within(p).getByRole("button", { name: "Use 15 for Buy: % under the average" }));
      expect(field).toHaveValue(15);
      expect(field.closest(".ui-field")).not.toHaveClass("off-default");
    });

    it("a data-derived value has its own Use", async () => {
      stubApi({ suggested: enoughHistory });
      render(<SignalSettings />);
      const p = await panel();
      expect(await within(p).findByText("From your data: 60 — 9 in 10 price changes come sooner than this")).toBeInTheDocument();
      await userEvent.click(within(p).getByRole("button", { name: "Use 60 from your data for Stop watching / check copy after (days)" }));
      expect(within(p).getByLabelText("Stop watching / check copy after (days)")).toHaveValue(60);
    });

    it("not enough history yet when the basis is null", async () => {
      stubApi();
      render(<SignalSettings />);
      const p = await panel();
      expect(await within(p).findByText("From your data: not enough history yet")).toBeInTheDocument();
    });

    it("an empty recommendation field blocks save", async () => {
      const calls = stubApi();
      render(<SignalSettings />);
      const p = await panel();
      await userEvent.clear(within(p).getByLabelText("Judge a bark (signal) after (days)"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Every threshold needs a number.")).toBeInTheDocument();
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("the preview's second line counts recommendations", async () => {
      stubApi();
      render(<SignalSettings />);
      expect(await screen.findByText("With these values: 3 sell now, 5 buy now, 2 target changes, 7 clean-ups")).toBeInTheDocument();
    });
  });
});
