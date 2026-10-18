import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Signal, SourceId, SourceInfo } from "@retrowatchdog/shared";
import {
  directionPill,
  PILL_SURFACE_TYPES,
  SignalBadge,
  SignalDirectionPill,
} from "../src/components/SignalBadge.js";
import { resetMoneyForTests, setDisplayCurrency } from "../src/lib/money.js";
import { setSourcesForTests } from "../src/lib/sources.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  window.localStorage.clear(); // displayCurrency persists
});

/** the rendered extended badge element for a signal */
function renderBadge(signal: Signal): HTMLElement {
  const { container } = render(<SignalBadge signal={signal} />);
  return container.querySelector("span.signal-line") as HTMLElement;
}

describe("SignalBadge tones", () => {
  it("maps UNDERPRICED and FLIP to opportunity, OVERPRICED_STORE to warning, INSUFFICIENT_DATA to info", () => {
    expect(renderBadge({ type: "UNDERPRICED", reasoning: "r" })).toHaveClass("opportunity");
    expect(renderBadge({ type: "FLIP", reasoning: "r" })).toHaveClass("opportunity");
    expect(renderBadge({ type: "OVERPRICED_STORE", reasoning: "r" })).toHaveClass("warning");
    expect(renderBadge({ type: "INSUFFICIENT_DATA", reasoning: "r" })).toHaveClass("info");
  });
});

describe("SignalBadge extended layout", () => {
  it("leads with the direction pill, then the type title, full reasoning and the listing link", () => {
    const badge = renderBadge({
      type: "UNDERPRICED",
      reasoning: 'PAL/cib: "PDS complete" at £19 vs eBay UK active median £30 (9 listings) — bargain candidate',
      url: "https://www.ebay.co.uk/itm/bargain1",
      source: "ebay_uk",
    });
    const pill = badge.querySelector(".badge-compact") as HTMLElement;
    expect(pill).toHaveTextContent("🛒 buy @ eBay UK");
    expect(pill).toHaveClass("opportunity");
    // the tag on top: the pill is the badge's first element
    expect(badge.firstElementChild).toBe(pill);
    expect(badge).toHaveTextContent("UNDERPRICED");
    expect(badge).toHaveTextContent("bargain candidate");
    const link = badge.querySelector("a") as HTMLAnchorElement;
    expect(link).toHaveAttribute("href", "https://www.ebay.co.uk/itm/bargain1");
    expect(link).toHaveTextContent("View listing");
  });

  it("renders the ⚠ pill in the warning tone on an OVERPRICED_STORE badge, with no link", () => {
    const badge = renderBadge({
      type: "OVERPRICED_STORE",
      reasoning: "PAL/cib: CeX UK sells at £450 vs eBay UK active median £330 (7 listings) — don't buy at CeX",
      source: "cex",
    });
    const pill = badge.querySelector(".badge-compact") as HTMLElement;
    expect(pill).toHaveTextContent("⚠ overpriced @ CeX UK");
    expect(pill).toHaveClass("warning");
    expect(badge).toHaveTextContent("don't buy at CeX");
    expect(badge.querySelector("a")).toBeNull();
  });

  it("renders the data-driven ⇄ pill on a FLIP badge, and the generic fallback without source fields", () => {
    const withSources = renderBadge({
      type: "FLIP",
      reasoning: "voucher £50 vs median £40",
      buySource: "ebay_uk",
      sellSource: "cex",
    });
    expect(withSources.querySelector(".badge-compact")).toHaveTextContent("⇄ buy eBay UK → sell CeX UK");
    cleanup();
    const fallback = renderBadge({ type: "FLIP", reasoning: "no source metadata" });
    expect(fallback.querySelector(".badge-compact")).toHaveTextContent("⇄ flip opportunity");
  });

  it("renders no pill for metadata-less UNDERPRICED/OVERPRICED_STORE and for INSUFFICIENT_DATA", () => {
    expect(renderBadge({ type: "UNDERPRICED", reasoning: "r" }).querySelector(".badge-compact")).toBeNull();
    cleanup();
    expect(renderBadge({ type: "OVERPRICED_STORE", reasoning: "r" }).querySelector(".badge-compact")).toBeNull();
    cleanup();
    expect(renderBadge({ type: "INSUFFICIENT_DATA", reasoning: "r" }).querySelector(".badge-compact")).toBeNull();
  });
});

describe("SignalBadge confidence dimension", () => {
  it("high confidence: solid badge with the ✔ marker and no caveat line", () => {
    const badge = renderBadge({
      type: "OVERPRICED_STORE",
      reasoning: "PAL/cib: CeX UK sells at £450 vs eBay UK active median £330 (7 listings)",
      source: "cex",
      confidence: "high",
      caveats: [],
    });
    expect(badge).not.toHaveClass("potential");
    expect(badge).toHaveTextContent("✔ high confidence");
    expect(badge).not.toHaveTextContent("why potential");
    // the pill stays solid too
    expect(badge.querySelector(".badge-compact")).not.toHaveClass("potential");
  });

  it("potential: dashed badge variant, ❓ marker, and the caveats on a 'why potential:' line", () => {
    const badge = renderBadge({
      type: "FLIP",
      reasoning: "PAL/cib: CeX pays voucher £218 vs eBay UK active median £100 (8 listings)",
      buySource: "ebay_uk",
      sellSource: "cex",
      confidence: "potential",
      caveats: [
        "requires a mint copy — listing grades unverified",
        "market median from listings with undeclared condition",
      ],
    });
    expect(badge).toHaveClass("potential");
    expect(badge).toHaveTextContent("❓ potential");
    expect(badge).toHaveTextContent(
      "why potential: requires a mint copy — listing grades unverified; market median from listings with undeclared condition",
    );
    // the caveat line uses the muted source-note styling inside the badge
    expect(badge.querySelector(".confidence-caveats")).toHaveClass("source-note");
    // and the direction pill renders in its dashed potential variant
    expect(badge.querySelector(".badge-compact")).toHaveClass("potential");
  });

  it("a signal without the confidence field (INSUFFICIENT_DATA, old payloads) renders no marker", () => {
    const badge = renderBadge({ type: "INSUFFICIENT_DATA", reasoning: "r" });
    expect(badge).not.toHaveClass("potential");
    expect(badge.querySelector(".confidence-marker")).toBeNull();
    cleanup();
    const legacy = renderBadge({ type: "UNDERPRICED", reasoning: "r", source: "ebay_uk" });
    expect(legacy.querySelector(".confidence-marker")).toBeNull();
    expect(legacy.querySelector(".badge-compact")).not.toHaveClass("potential");
  });

  it("SignalDirectionPill mirrors confidence: potential pills dashed, high pills solid", () => {
    render(
      <>
        <SignalDirectionPill
          signal={{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: "cex", confidence: "potential", caveats: ["c"] }}
        />
        <SignalDirectionPill
          signal={{ type: "UNDERPRICED", reasoning: "r", source: "ebay_uk", confidence: "high", caveats: [] }}
        />
      </>,
    );
    expect(screen.getByText("⇄ buy eBay UK → sell CeX UK")).toHaveClass("badge-compact", "potential");
    expect(screen.getByText("🛒 buy @ eBay UK")).not.toHaveClass("potential");
  });
});

describe("PROFIT direction pill", () => {
  const profit: Signal = {
    type: "PROFIT",
    reasoning: "PAL/cib: CeX pays voucher £44 vs paid £18 — trade in at CeX",
    sellSource: "cex",
    gainUsd: 26,
    confidence: "high",
    caveats: [],
  };

  it("renders '💰 sell @ <source>' with the gain, in the opportunity tone, solid when high — source-only when the payload carries no sellKind (old payloads)", () => {
    // `profit` carries no sellKind: the pill must not guess an instrument
    render(<SignalDirectionPill signal={profit} />);
    const pill = screen.getByText("💰 sell @ CeX UK (+$26.00)");
    expect(pill).toHaveClass("badge-compact", "opportunity");
    expect(pill).not.toHaveClass("potential");
  });

  it("names the instrument for a bid-role kind — '💰 sell @ CeX UK voucher' / '💰 sell @ CeX UK cash' — read from the source's kindRoles (R4)", () => {
    // ruling R4 ("ideally separate them", 2026-09-02): the engine emits one
    // PROFIT per (source, kind), so a voucher gain (store credit) and a cash
    // gain must be told apart on the pill itself, never presented as one
    render(
      <>
        <SignalDirectionPill signal={{ ...profit, sellKind: "voucher" }} />
        <SignalDirectionPill signal={{ ...profit, sellKind: "cash", gainUsd: 16 }} />
      </>,
    );
    expect(screen.getByText("💰 sell @ CeX UK voucher (+$26.00)")).toHaveClass("badge-compact", "opportunity");
    expect(screen.getByText("💰 sell @ CeX UK cash (+$16.00)")).toHaveClass("badge-compact", "opportunity");
  });

  it("keeps the source-only label for a reference kind: a fee-netted listing median is not an instrument anybody pays in", () => {
    render(
      <SignalDirectionPill
        signal={{
          type: "PROFIT",
          reasoning: "PAL/cib: eBay UK active median £32 (11 listings) → ≈£27.84 after fees vs paid £18 — sell on eBay UK",
          sellSource: "ebay_uk",
          sellKind: "active_median",
          gainUsd: 12.5,
          confidence: "potential",
          caveats: ["listing price, not a sale; fees estimated"],
        }}
      />,
    );
    expect(screen.getByText("💰 sell @ eBay UK (+$12.50)")).toHaveClass("badge-compact", "potential");
  });

  it("renders the gain in the display currency, never raw USD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ base: "USD", to: "EUR", rate: 0.9, fetchedAt: new Date().toISOString(), mode: "auto" }),
        ),
      ),
    );
    await setDisplayCurrency("EUR");
    render(<SignalDirectionPill signal={{ ...profit, gainUsd: 20 }} />);
    expect(screen.getByText("💰 sell @ CeX UK (+€18.00)")).toBeInTheDocument();
    expect(screen.queryByText(/\$20\.00/)).toBeNull();
  });

  it("omits the gain clause when the signal carries no gainUsd", () => {
    render(<SignalDirectionPill signal={{ type: "PROFIT", reasoning: "r", sellSource: "ebay_uk" }} />);
    expect(screen.getByText("💰 sell @ eBay UK")).toHaveClass("badge-compact", "opportunity");
  });

  it("renders dashed when potential (a fee-netted listing reading)", () => {
    render(
      <SignalDirectionPill
        signal={{
          type: "PROFIT",
          reasoning: "PAL/cib: eBay UK active median £32 (11 listings) → ≈£27.84 after fees vs paid £18 — sell on eBay UK",
          sellSource: "ebay_uk",
          gainUsd: 12.5,
          confidence: "potential",
          caveats: ["listing price, not a sale; fees estimated"],
        }}
      />,
    );
    expect(screen.getByText("💰 sell @ eBay UK (+$12.50)")).toHaveClass("badge-compact", "potential");
  });

  it("shows a negative gain with its own sign instead of a '+−' pair", () => {
    // only reachable with a sub-1 SIGNAL_PROFIT_FACTOR; the pill must not
    // claim a gain the signal does not carry
    render(<SignalDirectionPill signal={{ ...profit, gainUsd: -3 }} />);
    expect(screen.getByText("💰 sell @ CeX UK (−$3.00)")).toBeInTheDocument();
  });

  it("renders no pill without a sellSource", () => {
    const { container } = render(<SignalDirectionPill signal={{ type: "PROFIT", reasoning: "r", gainUsd: 5 }} />);
    expect(container.querySelector(".badge-compact")).toBeNull();
  });

  it("does not crash the extended badge: opportunity tone, pill on top, title and reasoning", () => {
    const badge = renderBadge(profit);
    expect(badge).toHaveClass("opportunity");
    expect(badge.firstElementChild).toHaveTextContent("💰 sell @ CeX UK (+$26.00)");
    expect(badge).toHaveTextContent("PROFIT");
    expect(badge).toHaveTextContent("trade in at CeX");
    expect(badge).toHaveTextContent("✔ high confidence");
    expect(badge.querySelector("a")).toBeNull();
  });
});

describe("SignalDirectionPill adaptivity", () => {
  // A future source declared ONLY via its SourceInfo entry: every pill's
  // wording must come from that label, with zero pill-code changes — the
  // web mirror of the API engine's sources extension point.
  const FUTURE_SOURCES: Record<string, SourceInfo> = {
    // the FLIP case below buys through "ebay_uk", so this spreads the fixture
    // registry every other web test starts from
    ...Object.fromEntries(SOURCES_FIXTURE.map((s) => [s.id, s])),
    // declares a bid instrument (cash) and a reference so the PROFIT pill's
    // instrument word can be exercised through the manifest alone
    amazon_es: {
      label: "Amazon ES",
      family: "ebay",
      familyLabel: "eBay",
      kind: "live",
      country: "ES",
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["EUR"],
      kindRoles: { cash: "bid", active_median: "reference" },
    },
  };
  const futureId = "amazon_es" as SourceId;

  it("names a synthetic source's bid instrument from its own kindRoles and leaves its reference reading source-only", () => {
    render(
      <>
        <SignalDirectionPill
          signal={{ type: "PROFIT", reasoning: "r", sellSource: futureId, sellKind: "cash", gainUsd: 5 }}
          sources={FUTURE_SOURCES}
        />
        <SignalDirectionPill
          signal={{ type: "PROFIT", reasoning: "r", sellSource: futureId, sellKind: "active_median", gainUsd: 7 }}
          sources={FUTURE_SOURCES}
        />
      </>,
    );
    expect(screen.getByText("💰 sell @ Amazon ES cash (+$5.00)")).toHaveClass("badge-compact", "opportunity");
    expect(screen.getByText("💰 sell @ Amazon ES (+$7.00)")).toHaveClass("badge-compact", "opportunity");
  });

  it("derives every pill label from a synthetic future source's declared label", () => {
    render(
      <>
        <SignalDirectionPill signal={{ type: "UNDERPRICED", reasoning: "r", source: futureId }} sources={FUTURE_SOURCES} />
        <SignalDirectionPill signal={{ type: "OVERPRICED_STORE", reasoning: "r", source: futureId }} sources={FUTURE_SOURCES} />
        <SignalDirectionPill
          signal={{ type: "FLIP", reasoning: "r", buySource: "ebay_uk", sellSource: futureId }}
          sources={FUTURE_SOURCES}
        />
      </>,
    );
    expect(screen.getByText("🛒 buy @ Amazon ES")).toHaveClass("badge-compact", "opportunity");
    expect(screen.getByText("⚠ overpriced @ Amazon ES")).toHaveClass("badge-compact", "warning");
    expect(screen.getByText("⇄ buy eBay UK → sell Amazon ES")).toHaveClass("badge-compact", "opportunity");
  });

  it("renders a source id that Object.prototype would answer for, instead of throwing", () => {
    // A source id is data — a plugin author picks it, and a stored price point
    // carries whatever was picked. Against a plain object literal,
    // byId["constructor"] answers with an inherited function, `?.` sails past
    // it, and profitInstrument evaluates `(<function>).kindRoles[kind]`: a
    // TypeError, which React 19 turns into a blank tree rather than a
    // degraded pill. The store's map has a null prototype so the lookup
    // answers undefined and the pill falls back to the raw id.
    setSourcesForTests(SOURCES_FIXTURE);
    const hostile = "constructor" as SourceId;
    render(
      <SignalDirectionPill
        signal={{ type: "PROFIT", reasoning: "r", sellSource: hostile, sellKind: "cash", gainUsd: 5 }}
      />,
    );
    expect(screen.getByText("💰 sell @ constructor (+$5.00)")).toBeInTheDocument();
  });

  it("takes the registry from the store when no sources prop is passed", () => {
    // The prop above is a test seam. What the app actually renders against is
    // the registry loaded at boot — including sources this build was never
    // compiled with, which is the whole point of loading it at runtime. No
    // component here is given a sources prop.
    setSourcesForTests([
      ...SOURCES_FIXTURE,
      {
        id: "kleinanzeigen_de",
        label: "Kleinanzeigen DE",
        family: "kleinanzeigen",
        familyLabel: "Kleinanzeigen",
        kind: "live",
        country: "DE",
        reach: "global",
        defaultRegion: null,
        expectedCurrencies: ["EUR"],
        kindRoles: { cash: "bid" },
        configured: true,
        origin: "plugin",
        pluginId: 7,
      },
    ]);
    const plugin = "kleinanzeigen_de" as SourceId;
    render(
      <>
        <SignalDirectionPill signal={{ type: "UNDERPRICED", reasoning: "r", source: plugin }} />
        <SignalDirectionPill signal={{ type: "PROFIT", reasoning: "p", sellSource: plugin, sellKind: "cash", gainUsd: 5 }} />
        <SignalBadge signal={{ type: "FLIP", reasoning: "f", buySource: "ebay_uk", sellSource: plugin }} />
      </>,
    );
    expect(screen.getByText("🛒 buy @ Kleinanzeigen DE")).toBeInTheDocument();
    expect(screen.getByText("💰 sell @ Kleinanzeigen DE cash (+$5.00)")).toBeInTheDocument();
    expect(screen.getByText("⇄ buy eBay UK → sell Kleinanzeigen DE")).toBeInTheDocument();
  });
});

describe("direction pills for the new signal types", () => {
  const byId = SOURCES_FIXTURE.reduce<Record<string, SourceInfo>>((acc, s) => ({ ...acc, [s.id]: s }), {});
  const high = (s: Partial<Signal> & Pick<Signal, "type">): Signal => ({ reasoning: "r", confidence: "high", ...s });

  it("names where to act for each new type", () => {
    expect(directionPill(high({ type: "TARGET_HIT", source: "ebay_uk" }), byId)?.label).toBe("🎯 target @ eBay UK");
    expect(directionPill(high({ type: "PRICE_DROP", source: "cex" }), byId)?.label).toBe("↓ price drop @ CeX UK");
    expect(directionPill(high({ type: "NEW_LOW", source: "ebay_uk" }), byId)?.label).toBe("↓ 90-day low @ eBay UK");
    expect(directionPill(high({ type: "BACK_IN_STOCK", source: "cex" }), byId)?.label).toBe("↺ in stock @ CeX UK");
    expect(directionPill(high({ type: "RISING", source: "ebay_uk" }), byId)?.label).toBe("↑ rising @ eBay UK");
  });

  it("gives them the opportunity tone and no pill without a source", () => {
    expect(directionPill(high({ type: "PRICE_DROP", source: "cex" }), byId)?.tone).toBe("opportunity");
    expect(directionPill(high({ type: "TARGET_HIT" }), byId)).toBeNull();
  });
});

