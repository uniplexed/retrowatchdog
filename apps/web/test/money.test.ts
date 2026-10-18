import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatMoney,
  formatOriginal,
  fxNote,
  getMoneySnapshot,
  loadDisplayCurrency,
  loadLastPaidCurrency,
  resetMoneyForTests,
  saveLastPaidCurrency,
  setDisplayCurrency,
} from "../src/lib/money.js";

/** /api/fx stub: known USD->currency rates; anything missing 503s (FX down). */
function stubFxFetch(
  rates: Record<string, number>,
  opts: { fetchedAt?: string | null; mode?: string } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const to = new URL(String(url), "http://test").searchParams.get("to");
    const rate = to === null ? undefined : rates[to];
    if (rate === undefined) {
      return new Response(JSON.stringify({ error: `FX rate for ${to} is unavailable` }), { status: 503 });
    }
    return new Response(
      JSON.stringify({
        base: "USD",
        to,
        rate,
        fetchedAt: opts.fetchedAt !== undefined ? opts.fetchedAt : new Date().toISOString(),
        mode: opts.mode ?? "auto",
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetMoneyForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("formatMoney", () => {
  it("defaults to USD without any network fetch", async () => {
    const fetchMock = stubFxFetch({});
    await loadDisplayCurrency();
    expect(formatMoney(100)).toBe("$100.00");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("converts USD amounts into every supported display currency", async () => {
    stubFxFetch({ GBP: 0.79, EUR: 0.9, JPY: 147, CHF: 0.8, CAD: 1.35, AUD: 1.5 });
    await setDisplayCurrency("GBP");
    expect(formatMoney(100)).toBe("£79.00");
    await setDisplayCurrency("EUR");
    expect(formatMoney(100)).toBe("€90.00");
    await setDisplayCurrency("JPY");
    expect(formatMoney(10)).toBe("¥1,470"); // JPY: no minor units
    await setDisplayCurrency("CHF");
    expect(formatMoney(100)).toBe("CHF 80.00");
    await setDisplayCurrency("CAD");
    expect(formatMoney(100)).toBe("CA$135.00");
    await setDisplayCurrency("AUD");
    expect(formatMoney(100)).toBe("A$150.00");
    await setDisplayCurrency("USD");
    expect(formatMoney(100)).toBe("$100.00");
  });

  it("persists the selection and restores it on boot", async () => {
    stubFxFetch({ EUR: 0.9 });
    await setDisplayCurrency("EUR");
    expect(window.localStorage.getItem("displayCurrency")).toBe("EUR");

    resetMoneyForTests(); // simulate a fresh boot
    expect(formatMoney(100)).toBe("$100.00");
    await loadDisplayCurrency();
    expect(formatMoney(100)).toBe("€90.00");
  });

  it("falls back to USD display with a visible note when /api/fx is down", async () => {
    stubFxFetch({}); // every currency 503s
    await setDisplayCurrency("EUR");
    expect(getMoneySnapshot().currency).toBe("EUR"); // the pick is kept
    expect(formatMoney(100)).toBe("$100.00");
    // "converted": an amount quoted in the display currency keeps its verbatim
    // original, which needs no rate, so only converted ones fall back to USD
    expect(fxNote()).toBe("FX unavailable — converted prices shown in USD");
  });

  it("ignores garbage in localStorage and survives a throwing storage", async () => {
    window.localStorage.setItem("displayCurrency", "DOGE");
    await loadDisplayCurrency();
    expect(getMoneySnapshot().currency).toBe("USD");

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    await loadDisplayCurrency();
    expect(getMoneySnapshot().currency).toBe("USD");
  });
});

describe("fxNote", () => {
  it("stays silent for USD and for a fresh auto rate", async () => {
    stubFxFetch({ EUR: 0.9 });
    expect(fxNote()).toBeNull(); // USD boot state
    await setDisplayCurrency("EUR");
    expect(fxNote()).toBeNull();
  });

  it("flags a rate older than 48h with its date", async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    stubFxFetch({ EUR: 0.9 }, { fetchedAt: old });
    await setDisplayCurrency("EUR");
    expect(fxNote()).toBe(`rate from ${new Date(old).toLocaleDateString()}`);
  });

  it("labels a manual override instead of staleness (fetchedAt is null then)", async () => {
    stubFxFetch({ EUR: 0.85 }, { fetchedAt: null, mode: "manual" });
    await setDisplayCurrency("EUR");
    expect(fxNote()).toBe("manual rate");
    expect(formatMoney(100)).toBe("€85.00");
  });
});

describe("formatOriginal", () => {
  it("renders the verbatim amount in its own currency, never converted", async () => {
    stubFxFetch({ EUR: 0.9 });
    await setDisplayCurrency("EUR"); // display currency must NOT touch originals
    expect(formatOriginal(25, "EUR")).toBe("€25.00");
    expect(formatOriginal(9.5, "USD")).toBe("$9.50");
    expect(formatOriginal(30, "GBP")).toBe("£30.00");
  });

  it("degrades to a plain number + code for an unknown currency code", () => {
    expect(formatOriginal(10, "XONK")).toBe("10.00 XONK");
  });
});

describe("last paid currency", () => {
  it("defaults to GBP (UK user) and remembers the last pick", () => {
    expect(loadLastPaidCurrency()).toBe("GBP");
    saveLastPaidCurrency("EUR");
    expect(loadLastPaidCurrency()).toBe("EUR");
  });
});

/**
 * An amount the app STORED as USD but that a source (or the user) actually
 * quoted in another currency carries its verbatim original beside the USD
 * twin. When the display currency IS that original's currency, converting the
 * USD twin back is a round trip through two roundings: CeX's £177 became
 * $233.47 at write time and comes back as £176.37 — a price that never
 * existed. The original is both exact and what the source really said, so it
 * wins; anything else still converts.
 */
describe("formatMoney with a verbatim original", () => {
  it("shows the original when the display currency is the original's currency", async () => {
    stubFxFetch({ GBP: 0.7583 });
    await setDisplayCurrency("GBP");
    // the USD twin would render as £176.37; the source said £177
    expect(formatMoney(232.62, { amount: 177, currency: "GBP" })).toBe("£177.00");
  });

  it("converts the USD twin when the currencies differ", async () => {
    stubFxFetch({ EUR: 0.9 });
    await setDisplayCurrency("EUR");
    // a GBP original cannot speak for a EUR display: convert the stored USD
    expect(formatMoney(100, { amount: 177, currency: "GBP" })).toBe("€90.00");
  });

  it("shows a USD original verbatim while displaying USD, and ignores a null original", () => {
    expect(formatMoney(12.5, { amount: 12.5, currency: "USD" })).toBe("$12.50");
    expect(formatMoney(12.5, null)).toBe("$12.50");
    expect(formatMoney(12.5)).toBe("$12.50");
  });

  it("still shows a matching original when FX is down — it needs no rate", async () => {
    stubFxFetch({}); // every rate 503s
    await setDisplayCurrency("GBP");
    expect(getMoneySnapshot().fxFailed).toBe(true);
    // exact and rate-free: the £ the source quoted
    expect(formatMoney(232.62, { amount: 177, currency: "GBP" })).toBe("£177.00");
    // but an amount with no matching original still falls back to USD
    expect(formatMoney(50)).toBe("$50.00");
    // and the note says exactly that, so a £ next to a $ is explained
    expect(fxNote()).toBe("FX unavailable — converted prices shown in USD");
  });
});
