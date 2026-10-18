import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { stubMatchMedia } from "./helpers/matchMedia.js";
import userEvent from "@testing-library/user-event";
import { SettingsScreen } from "../src/screens/SettingsScreen.js";
import { formatMoney, resetMoneyForTests, setDisplayCurrency } from "../src/lib/money.js";
import type {
  FxSettingDto,
  FxSettingsResponse,
  MarketDto,
  SourceId,
  SourceInfoDto,
  UpdateFxSettingInput,
  UpdateMarketsInput,
} from "@retrowatchdog/shared";
import { setSourcesForTests } from "../src/lib/sources.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";

const FETCHED_AT = "2026-09-01T06:00:00.000Z";

// Six rows, contract order, one per supported currency except the USD base.
// EUR starts manual; AUD is auto but keeps a stored manualRate from an earlier
// toggle; CAD simulates FX down (autoRate/fetchedAt null) — the row still renders.
const rows: FxSettingDto[] = [
  { currency: "GBP", mode: "auto", manualRate: null, autoRate: 0.79, fetchedAt: FETCHED_AT },
  { currency: "EUR", mode: "manual", manualRate: 0.95, autoRate: 0.92, fetchedAt: FETCHED_AT },
  { currency: "JPY", mode: "auto", manualRate: null, autoRate: 147.2, fetchedAt: FETCHED_AT },
  { currency: "CHF", mode: "auto", manualRate: null, autoRate: 0.8, fetchedAt: FETCHED_AT },
  { currency: "CAD", mode: "auto", manualRate: null, autoRate: null, fetchedAt: null },
  { currency: "AUD", mode: "auto", manualRate: 1.6, autoRate: 1.5, fetchedAt: FETCHED_AT },
];
const settingsResponse: FxSettingsResponse = { currencies: rows };

interface RecordedPut {
  url: string;
  body: UpdateFxSettingInput;
}

// Every market this deployment serves, as the API reports it — derived from
// SOURCES_FIXTURE so a source added upstream shows up on this screen's test
// too. Every one of them is an approved PLUGIN's source, and all are
// configured: a test that needs an unconfigured market flips one itself.
const marketRows: MarketDto[] = SOURCES_FIXTURE.map((s) => ({
  source: s.id,
  label: s.label,
  family: s.family,
  country: s.country,
  configured: true,
}));

const SEEDED_MARKETS: SourceId[] = ["cex", "ebay_uk"];

/**
 * Stubs GET /api/settings/fx, PUT /api/settings/fx/:currency, /api/fx and
 * GET/PUT /api/settings/markets. Once GBP is switched to manual, /api/fx
 * serves the manual rate — pinning that a saved override reaches the header
 * display conversion. The markets PUT mirrors the real route: it refuses an
 * unconfigured source with the server's own 400 message, and answers with the
 * stored list in manifest order however the screen sent it.
 */
function stubApi(
  // The rows GET /api/settings/markets answers with. Defaults to every market
  // this deployment serves; a case that needs one to be unconfigured hands in
  // its own copy rather than making every other case live with it.
  markets: MarketDto[] = marketRows,
): {
  fetchMock: ReturnType<typeof vi.fn>;
  puts: RecordedPut[];
  marketPuts: SourceId[][];
} {
  let gbpManualRate: number | null = null;
  let enabled: SourceId[] = [...SEEDED_MARKETS];
  const puts: RecordedPut[] = [];
  const marketPuts: SourceId[][] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/settings/markets") {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as UpdateMarketsInput;
        marketPuts.push(body.enabled);
        const unconfigured = body.enabled.filter(
          (s) => markets.find((m) => m.source === s)?.configured !== true,
        );
        if (unconfigured.length > 0) {
          return new Response(
            JSON.stringify({
              error: `not configured, cannot be enabled: ${unconfigured.join(", ")}`,
            }),
            { status: 400 },
          );
        }
        enabled = markets.filter((m) => body.enabled.includes(m.source)).map((m) => m.source);
      }
      return new Response(JSON.stringify({ enabled, available: markets }));
    }
    if (init?.method === "PUT" && u.startsWith("/api/settings/fx/")) {
      const currency = u.split("/").pop()!;
      const body = JSON.parse(String(init.body)) as UpdateFxSettingInput;
      puts.push({ url: u, body });
      if (currency === "GBP") gbpManualRate = body.mode === "manual" ? (body.manualRate ?? null) : null;
      const row = rows.find((r) => r.currency === currency)!;
      return new Response(
        JSON.stringify({ ...row, mode: body.mode, manualRate: body.manualRate ?? row.manualRate }),
      );
    }
    if (u === "/api/settings/fx") return new Response(JSON.stringify(settingsResponse));
    if (u.includes("/api/fx")) {
      return new Response(
        JSON.stringify(
          gbpManualRate !== null
            ? { base: "USD", to: "GBP", rate: gbpManualRate, fetchedAt: null, mode: "manual" }
            : { base: "USD", to: "GBP", rate: 0.79, fetchedAt: new Date().toISOString(), mode: "auto" },
        ),
      );
    }
    // Settings mounts the Plugins panel above Markets, and it reads this on
    // render. An empty list is this build's truth — no plugin has ever been
    // imported on a real deployment — and it keeps each test below about its
    // own block. PluginsPanel.test.tsx is where the panel itself is driven.
    if (u === "/api/plugins") return new Response(JSON.stringify({ plugins: [] }));
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, puts, marketPuts };
}

function fxRow(currency: string): HTMLElement {
  // the Appearance currency selector lists the same codes: the row is the one inside .fx-row
  const row = screen.getAllByText(currency).map((e) => e.closest(".fx-row")).find((r) => r !== null) ?? null;
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  window.localStorage.clear();
});

describe("SettingsScreen sections", () => {
  it("desktop shows one section at a time", async () => {
    stubApi();
    stubMatchMedia({ desktop: true });
    render(<SettingsScreen />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    // the section buttons, not their ⓘ tips
    expect(within(nav).getAllByRole("button").filter((b) => !b.classList.contains("info-tip-button")).map((b) => b.textContent)).toEqual([
      "Appearance", "Barks (Signals)", "Valuation", "Markets", "Currencies", "Plugins",
    ]);
    // Appearance first: the theme and currency, one line each
    expect(within(nav).getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Light, dark, or follow the system.")).toBeInTheDocument();
    expect(screen.queryByText(/^Plugins are separate services/)).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: "Plugins" }));
    expect(await screen.findByText(/^Plugins are separate services/)).toBeInTheDocument();
    expect(screen.queryByText("Light, dark, or follow the system.")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("settingsSection")).toBe("plugins");
  });

  it("phone shows sections as folds, all closed", async () => {
    stubApi();
    render(<SettingsScreen />);
    const folds = [...document.querySelectorAll("details.ui-fold")] as HTMLDetailsElement[];
    // each summary's title, without its ⓘ tip
    expect(folds.map((f) => f.querySelector("summary")?.childNodes[0]?.textContent?.trim())).toEqual([
      "Appearance", "Barks (Signals)", "Valuation", "Markets", "Currencies", "Plugins",
    ]);
    expect(folds.every((f) => !f.open)).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
  });
});

describe("SettingsScreen FX section", () => {
  it("renders one row per non-USD currency: auto rate + fetch time, manual input, FX-down row", async () => {
    stubApi();
    render(<SettingsScreen />);
    expect(await screen.findByText("Exchange rates", { selector: "h3" })).toBeInTheDocument();
    for (const row of rows) expect(fxRow(row.currency)).toBeInTheDocument();

    // auto row: the Frankfurter rate and when it was fetched
    expect(within(fxRow("GBP")).getByText("0.79")).toBeInTheDocument();
    expect(within(fxRow("GBP")).getByText(/· updated/)).toBeInTheDocument();

    // manual row: input with the stored rate, auto rate greyed for reference
    const eurInput = screen.getByLabelText("Manual USD to EUR rate") as HTMLInputElement;
    expect(eurInput.value).toBe("0.95");
    expect(within(fxRow("EUR")).getByText("Auto: 0.92")).toBeInTheDocument();

    // FX down: the row renders anyway, with an honest placeholder
    expect(within(fxRow("CAD")).getByText("No rate")).toBeInTheDocument();
  });

  it("saves a manual rate via PUT and the display conversion picks it up", async () => {
    const { puts } = stubApi();
    await setDisplayCurrency("GBP"); // auto rate 0.79 until the override lands
    await waitFor(() => expect(formatMoney(100)).toBe("£79.00"));

    render(<SettingsScreen />);
    await screen.findByText("Exchange rates", { selector: "h3" });
    // no stored manualRate on GBP: picking manual opens the input, no PUT yet
    await userEvent.click(within(fxRow("GBP")).getByLabelText("Manual"));
    expect(puts).toHaveLength(0);
    await userEvent.type(screen.getByLabelText("Manual USD to GBP rate"), "0.8");
    await userEvent.click(within(fxRow("GBP")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toBe("/api/settings/fx/GBP");
    expect(puts[0].body).toEqual({ mode: "manual", manualRate: 0.8 });

    // the row now shows the greyed auto reference next to the manual input
    expect(await within(fxRow("GBP")).findByText("Auto: 0.79")).toBeInTheDocument();
    // and the header conversion now runs on the manual rate
    await waitFor(() => expect(formatMoney(100)).toBe("£80.00"));
  });

  it("rejects an empty/invalid manual rate without any PUT", async () => {
    const { puts } = stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Exchange rates", { selector: "h3" });
    await userEvent.click(within(fxRow("GBP")).getByLabelText("Manual"));
    await userEvent.click(within(fxRow("GBP")).getByRole("button", { name: "Save" }));
    expect(await within(fxRow("GBP")).findByText("Enter a rate greater than 0")).toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });

  it("switches a manual row back to auto (server keeps the manual rate for re-toggling)", async () => {
    const { puts } = stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Exchange rates", { selector: "h3" });
    await userEvent.click(within(fxRow("EUR")).getByLabelText("Auto"));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toBe("/api/settings/fx/EUR");
    expect(puts[0].body).toEqual({ mode: "auto" });
    // back on auto: the Frankfurter rate + fetch time render again
    expect(await within(fxRow("EUR")).findByText("0.92")).toBeInTheDocument();
    expect(within(fxRow("EUR")).getByText(/· updated/)).toBeInTheDocument();
  });

  it("re-activates a stored manual rate directly when toggling manual again", async () => {
    const { puts } = stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Exchange rates", { selector: "h3" });
    // AUD is auto but carries manualRate 1.6 from an earlier toggle
    await userEvent.click(within(fxRow("AUD")).getByLabelText("Manual"));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ mode: "manual", manualRate: 1.6 });
  });
});

describe("SettingsScreen Collection value section", () => {
  const basisRadio = (name: RegExp): HTMLInputElement =>
    screen.getByRole("radio", { name }) as HTMLInputElement;

  it("offers the three bases with their one-line readings, market checked on first load", async () => {
    stubApi();
    render(<SettingsScreen />);
    expect(await screen.findByText("Collection value")).toBeInTheDocument();
    expect(basisRadio(/^market/).checked).toBe(true);
    expect(basisRadio(/^trade-in/).checked).toBe(false);
    expect(basisRadio(/^replacement/).checked).toBe(false);
    expect(screen.getByText(/what similar copies are listed for/)).toBeInTheDocument();
    // "a shop", not "CeX": three CeX countries are selectable, so the
    // explanation names the mechanism and the per-copy tag names the market
    expect(screen.getByText(/what a shop would pay you/)).toBeInTheDocument();
    expect(screen.getByText(/what it costs to rebuy in a shop/)).toBeInTheDocument();
    // nothing was persisted by merely rendering the default
    expect(window.localStorage.getItem("valuationBasis")).toBeNull();
  });

  it("groups the three radios under an accessible 'Collection value' name", async () => {
    stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Collection value");
    // a screen reader announces "Collection value, group" before "market,
    // radio, 1 of 3" — the heading is the group's name, not a stray h3
    const group = screen.getByRole("group", { name: "Collection value" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: /^market/ })).toBeInTheDocument();
  });

  it("persists a pick immediately under the 'valuationBasis' key", async () => {
    stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Collection value");
    await userEvent.click(basisRadio(/^trade-in/));
    expect(basisRadio(/^trade-in/).checked).toBe(true);
    expect(basisRadio(/^market/).checked).toBe(false);
    expect(window.localStorage.getItem("valuationBasis")).toBe("trade_in");
    await userEvent.click(basisRadio(/^replacement/));
    expect(window.localStorage.getItem("valuationBasis")).toBe("replacement");
  });

  it("starts on the stored preference", async () => {
    window.localStorage.setItem("valuationBasis", "replacement");
    stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Collection value");
    expect(basisRadio(/^replacement/).checked).toBe(true);
    expect(basisRadio(/^market/).checked).toBe(false);
  });

  it("still renders when the FX settings fail to load — only the FX block shows the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === "/api/settings/fx") return new Response(null, { status: 500 });
        if (String(url) === "/api/plugins") return new Response(JSON.stringify({ plugins: [] }));
        throw new Error(`unexpected fetch ${String(url)}`);
      }),
    );
    render(<SettingsScreen />);
    expect(await screen.findByText("Could not load FX settings")).toBeInTheDocument();
    expect(screen.getByText("Collection value")).toBeInTheDocument();
    expect(basisRadio(/^market/).checked).toBe(true);
    // the FX heading stays so the error is attributable to that block
    expect(screen.getByText("Exchange rates", { selector: "h3" })).toBeInTheDocument();
  });
});

describe("SettingsScreen Valuation markets section", () => {
  const countryPicker = (): HTMLSelectElement =>
    screen.getByLabelText("Your country") as HTMLSelectElement;
  const foreignBox = (): HTMLInputElement =>
    screen.getByRole("checkbox", { name: /Include other countries/ }) as HTMLInputElement;

  it("defaults to the home country only, and persists nothing by rendering", async () => {
    stubApi();
    render(<SettingsScreen />);
    expect(await screen.findByText("Valuation markets")).toBeInTheDocument();
    expect(countryPicker().value).toBe("GB");
    expect(foreignBox().checked).toBe(false);
    expect(window.localStorage.getItem("valuationCountry")).toBeNull();
    expect(window.localStorage.getItem("valuationIncludeForeign")).toBeNull();
  });

  it("offers every country this build has a market in, by name", async () => {
    stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Valuation markets");
    const names = [...countryPicker().options].map((o) => o.textContent);
    expect(names).toEqual(["United Kingdom", "Spain", "Ireland", "Germany", "France", "Italy", "Portugal", "United States"]);
  });

  it("says in one line what each control does", async () => {
    stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Valuation markets");
    expect(screen.getByText("Markets in this country value your copies.")).toBeInTheDocument();
    expect(screen.getByText(/Barks \(signals\) use every market/)).toBeInTheDocument();
  });

  it("persists a country pick and the foreign-markets choice immediately", async () => {
    stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Valuation markets");
    await userEvent.selectOptions(countryPicker(), "ES");
    expect(countryPicker().value).toBe("ES");
    expect(window.localStorage.getItem("valuationCountry")).toBe("ES");
    expect(window.localStorage.getItem("valuationIncludeForeign")).toBe("false");

    await userEvent.click(foreignBox());
    expect(foreignBox().checked).toBe(true);
    expect(window.localStorage.getItem("valuationIncludeForeign")).toBe("true");
    // the country survives the second write
    expect(window.localStorage.getItem("valuationCountry")).toBe("ES");
  });

  it("starts on the stored preference", async () => {
    window.localStorage.setItem("valuationCountry", "IE");
    window.localStorage.setItem("valuationIncludeForeign", "true");
    stubApi();
    render(<SettingsScreen />);
    await screen.findByText("Valuation markets");
    expect(countryPicker().value).toBe("IE");
    expect(foreignBox().checked).toBe(true);
  });

  it("renders whatever the API-backed blocks do", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    render(<SettingsScreen />);
    expect(await screen.findByText("Valuation markets")).toBeInTheDocument();
    expect(countryPicker().value).toBe("GB");
    expect(foreignBox().checked).toBe(false);
  });
});

describe("SettingsScreen Markets section", () => {
  const marketBox = (name: RegExp): HTMLInputElement =>
    screen.getByRole("checkbox", { name }) as HTMLInputElement;

  /** the markets block, so a query cannot stray into the valuation one */
  const marketsBlock = async (): Promise<HTMLElement> => {
    const heading = await screen.findByText("Markets", { selector: "h3" });
    return heading.closest(".source-block") as HTMLElement;
  };

  it("lists every known market grouped by service, each named with its country", async () => {
    stubApi();
    render(<SettingsScreen />);
    const block = await marketsBlock();
    // the family headings group the shops; the country is on every row, so
    // "CeX ES" and "CeX UK" are never two unlabelled numbers
    for (const family of ["CeX", "eBay"]) {
      expect(within(block).getByRole("heading", { name: family })).toBeInTheDocument();
    }
    expect(within(block).getAllByRole("checkbox")).toHaveLength(marketRows.length);
    expect(marketBox(/CeX UK.*United Kingdom/)).toBeInTheDocument();
    expect(marketBox(/CeX ES.*Spain/)).toBeInTheDocument();
    expect(marketBox(/eBay DE.*Germany/)).toBeInTheDocument();
    expect(marketBox(/eBay US.*United States/)).toBeInTheDocument();
    // Vinted is NOT among them, and its absence is the point of this screen
    // being driven by the API: it is an imported plugin, so it appears in
    // Markets only after the user approves it in Settings → Plugins. The very
    // next test is that case — a market of a family this build never compiled
    // in, offered exactly like the rest once the registry names it.
    expect(within(block).queryByRole("heading", { name: "Vinted" })).toBeNull();
  });

  /**
   * A market of a family this build has no compiled name for, plus the
   * registry entry that names it. Kept out of stubApi so no other test sees
   * an extra market.
   */
  const importedMarket: MarketDto = {
    source: "kleinanzeigen_de",
    label: "Kleinanzeigen DE",
    family: "kleinanzeigen",
    country: "DE",
    configured: true,
  };
  const importedSource: SourceInfoDto = {
    ...importedMarket,
    id: importedMarket.source,
    familyLabel: "Kleinanzeigen",
    kind: "live",
    reach: "global",
    defaultRegion: null,
    expectedCurrencies: ["EUR"],
    kindRoles: { active_listing: "buy_listing" },
    origin: "plugin",
    pluginId: 7,
  };

  function stubMarketsOnly(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u === "/api/settings/markets") {
          return new Response(
            JSON.stringify({ enabled: SEEDED_MARKETS, available: [...marketRows, importedMarket] }),
          );
        }
        if (u === "/api/settings/fx") return new Response(JSON.stringify(settingsResponse));
        if (u.includes("/api/fx")) {
          return new Response(
            JSON.stringify({ base: "USD", to: "GBP", rate: 0.79, fetchedAt: FETCHED_AT, mode: "auto" }),
          );
        }
        if (u === "/api/plugins") return new Response(JSON.stringify({ plugins: [] }));
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
  }

  it("heads a group with the family name the registry gives, not one compiled in", async () => {
    // This screen used to hold its own Record<SourceFamily, string>. With
    // SourceFamily a plain string that Record was a bare index signature, so a
    // family it did not list — every imported plugin's — rendered as an empty
    // <h4></h4>, measured on this build before the registry moved to runtime.
    setSourcesForTests([...SOURCES_FIXTURE, importedSource]);
    stubMarketsOnly();
    render(<SettingsScreen />);
    const block = await marketsBlock();
    expect(within(block).getByRole("heading", { name: "Kleinanzeigen" })).toBeInTheDocument();
  });

  it("falls back to the family id when the registry has no source of that family", async () => {
    // The honest degraded state (/api/sources down, or the plugin disabled
    // between the two calls): ugly, and never an empty heading.
    setSourcesForTests(SOURCES_FIXTURE);
    stubMarketsOnly();
    render(<SettingsScreen />);
    const block = await marketsBlock();
    expect(within(block).getByRole("heading", { name: "kleinanzeigen" })).toBeInTheDocument();
  });

  it("checks exactly the markets the server says are enabled", async () => {
    stubApi();
    render(<SettingsScreen />);
    await marketsBlock();
    expect(marketBox(/CeX UK/).checked).toBe(true);
    expect(marketBox(/eBay UK/).checked).toBe(true);
    expect(marketBox(/CeX ES/).checked).toBe(false);
    expect(marketBox(/eBay FR/).checked).toBe(false);
  });

  it("states the cost per service: a live call per live market, a catalogue sync per synced shop", async () => {
    // Was one sentence for both ("Every market you add is another external
    // call per game view and more eBay quota"), which is wrong for the three
    // CeX rows: a CeX search reads the local catalog, so opening a game makes
    // no CeX call. Their real cost — a background catalog sync, serialized
    // behind the other CeX countries' — was the one a user would act on and
    // was not stated at all.
    stubApi();
    render(<SettingsScreen />);
    await marketsBlock();
    const note = screen.getByText(/Each live market adds a request per game you open/);
    expect(note).toHaveTextContent(/Each synced shop adds a background catalogue sync/);
  });

  it("PUTs the complete list on a toggle and shows the list the server stored", async () => {
    const { marketPuts } = stubApi();
    render(<SettingsScreen />);
    await marketsBlock();
    await userEvent.click(marketBox(/eBay FR/));

    await waitFor(() => expect(marketPuts).toHaveLength(1));
    // the whole list, never a delta
    expect(marketPuts[0]).toEqual(["cex", "ebay_uk", "ebay_fr"]);
    await waitFor(() => expect(marketBox(/eBay FR/).checked).toBe(true));
    expect(marketBox(/CeX UK/).checked).toBe(true);

    // and off again
    await userEvent.click(marketBox(/CeX UK/));
    await waitFor(() => expect(marketPuts).toHaveLength(2));
    expect(marketPuts[1]).toEqual(["ebay_uk", "ebay_fr"]);
    await waitFor(() => expect(marketBox(/CeX UK/).checked).toBe(false));
  });

  it("cannot enable a market this deployment is not configured for, and says why", async () => {
    // A market that cannot answer is always a PLUGIN that cannot answer now:
    // one plugin, one health reading, shared by every source it declares. eBay
    // FR stands in for it here — an id the seed does not enable, so the row is
    // unchecked, which is the half this case is about (the checked-and-dead
    // row is the next case).
    const rowsWithDeadFr: MarketDto[] = marketRows.map((m) =>
      m.source === "ebay_fr" ? { ...m, configured: false } : m,
    );
    const { marketPuts } = stubApi(rowsWithDeadFr);
    render(<SettingsScreen />);
    await marketsBlock();
    const dead = marketBox(/eBay FR/);
    expect(dead.disabled).toBe(true);
    expect(dead.checked).toBe(false);
    expect(screen.getByText("Not configured.")).toBeInTheDocument();
    await userEvent.click(dead);
    expect(marketPuts).toHaveLength(0);
  });

  it("an enabled market that lost its configuration can still be switched off", async () => {
    // The trap this closes: the box was checked AND disabled, and every save
    // carried the dead id, so the whole Markets block became read-only with
    // an inline error. Reachable with no operator error — ENABLED_SOURCES
    // seeds ebay_uk, and a deployment without eBay credentials reports it
    // unconfigured.
    const rowsWithDeadUk: MarketDto[] = marketRows.map((m) =>
      m.source === "ebay_uk" ? { ...m, configured: false } : m,
    );
    let enabled: SourceId[] = ["cex", "ebay_uk"];
    const marketPuts: SourceId[][] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/settings/markets") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as UpdateMarketsInput;
          marketPuts.push(body.enabled);
          // the route's own rule: only ADDING an unconfigured market is refused
          const added = body.enabled.filter(
            (s) =>
              !enabled.includes(s) &&
              rowsWithDeadUk.find((m) => m.source === s)?.configured !== true,
          );
          if (added.length > 0) {
            return new Response(
              JSON.stringify({ error: `not configured, cannot be enabled: ${added.join(", ")}` }),
              { status: 400 },
            );
          }
          enabled = rowsWithDeadUk.filter((m) => body.enabled.includes(m.source)).map((m) => m.source);
        }
        return new Response(JSON.stringify({ enabled, available: rowsWithDeadUk }));
      }
      if (u === "/api/settings/fx") return new Response(JSON.stringify(settingsResponse));
      if (u.includes("/api/fx")) {
        return new Response(
          JSON.stringify({ base: "USD", to: "GBP", rate: 0.79, fetchedAt: null, mode: "auto" }),
        );
      }
      if (u === "/api/plugins") return new Response(JSON.stringify({ plugins: [] }));
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsScreen />);
    await marketsBlock();

    const uk = marketBox(/eBay UK/);
    expect(uk.checked).toBe(true);
    expect(uk.disabled).toBe(false);
    expect(screen.getByText("Not configured. Turn it off.")).toBeInTheDocument();

    // an unrelated market still saves rather than 400-ing on the carried id
    await userEvent.click(marketBox(/CeX ES/));
    await waitFor(() => expect(marketPuts).toHaveLength(1));
    expect(marketPuts[0]).toEqual(["cex", "ebay_uk", "cex_es"]);
    await waitFor(() => expect(marketBox(/CeX ES/).checked).toBe(true));

    // and the dead one can be turned off
    await userEvent.click(marketBox(/eBay UK/));
    await waitFor(() => expect(marketBox(/eBay UK/).checked).toBe(false));
    // once off it is like any other unconfigured row: no longer clickable
    expect(marketBox(/eBay UK/).disabled).toBe(true);
  });

  it("surfaces the server's refusal inline and keeps the checkboxes on its list", async () => {
    // a market the screen believed configured but the server refuses: the
    // failure must be visible, and the box must not lie about being on
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/settings/markets" && init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "not configured, cannot be enabled: ebay_fr" }), {
          status: 400,
        });
      }
      if (u === "/api/settings/markets") {
        return new Response(JSON.stringify({ enabled: SEEDED_MARKETS, available: marketRows }));
      }
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsScreen />);
    await marketsBlock();
    await userEvent.click(marketBox(/eBay FR/));
    expect(
      await screen.findByText(/not configured, cannot be enabled: ebay_fr/),
    ).toBeInTheDocument();
    expect(marketBox(/eBay FR/).checked).toBe(false);
  });

  it("shows its own error when the markets fail to load, leaving the rest working", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === "/api/settings/markets") return new Response(null, { status: 500 });
        if (String(url) === "/api/settings/fx") return new Response(JSON.stringify(settingsResponse));
        if (String(url) === "/api/plugins") return new Response(JSON.stringify({ plugins: [] }));
        throw new Error(`unexpected fetch ${String(url)}`);
      }),
    );
    render(<SettingsScreen />);
    expect(await screen.findByText("Could not load markets")).toBeInTheDocument();
    // the heading stays so the error is attributable to this block
    expect(screen.getByText("Markets", { selector: "h3" })).toBeInTheDocument();
    // and every other section is untouched by it
    expect(await screen.findByText("Exchange rates", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByText("0.79")).toBeInTheDocument();
    expect(screen.getByText("Collection value")).toBeInTheDocument();
    expect((screen.getByRole("radio", { name: /^market/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Valuation markets")).toBeInTheDocument();
    expect((screen.getByLabelText("Your country") as HTMLSelectElement).value).toBe("GB");
  });
});

describe("SettingsScreen Appearance: eBay in its own block", () => {
  it("is a switch, off by default, remembered in this browser", async () => {
    stubApi();
    render(<SettingsScreen />);
    const sw = await screen.findByRole("switch", { name: "eBay prices in their own block" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("ebayOwnBlock")).toBe("1");
  });
});
