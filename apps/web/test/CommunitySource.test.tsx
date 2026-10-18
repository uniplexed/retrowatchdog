import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { GameDetail } from "../src/screens/GameDetail.js";
import { resetMoneyForTests } from "../src/lib/money.js";
import { setSourcesForTests } from "../src/lib/sources.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";
import type {
  CollectionResponse,
  PricePointDto,
  PricesResponse,
  SourceBlock,
  SourceInfoDto,
  WatchlistResponse,
} from "@retrowatchdog/shared";

/**
 * A market read through a community sidecar, as the game view renders it.
 *
 * Nothing in this screen knows what a sidecar is: the block is drawn from the
 * registry entry, so a source of asking prices gets the plain listing block a
 * marketplace deserves — no buy/sell switch (that belongs to a shop trading in
 * both directions), the caveat under its heading, and the three honest states
 * a source can be in.
 *
 * WHERE VINTED COMES FROM HERE. It is an imported plugin, so the registry the
 * tests below install is the one a deployment has AFTER the user approves it — `origin: "plugin"`, its label
 * and caveat from the manifest. Before that approval the API serves no block
 * for it at all (no adapter exists for a source no registry entry declares),
 * and exactly ONE case here pins how that renders: the LAST one, where the id
 * is missing from the registry the screen was given. That is the deployment
 * with stored Vinted prices and no approved plugin.
 *
 * The case just above it is not a second one, though it reads like it. Its
 * `kleinanzeigen_de` arrives with a full registry entry and `origin:
 * "plugin"` — the state AFTER an approval, for an id this BUILD has never
 * heard of. Different fact, and the one that proves the manifest left the
 * bundle.
 */

const game = { id: 42, title: "Pilotwings 64", platform: "n64" as const, year: 1996, coverUrl: null };

/** the source an approved Vinted plugin puts in the registry */
const vintedUk: SourceInfoDto = {
  id: "vinted_uk",
  label: "Vinted UK",
  family: "vinted",
  familyLabel: "Vinted",
  kind: "live",
  country: "GB",
  reach: "global",
  defaultRegion: null,
  expectedCurrencies: ["GBP"],
  kindLabels: { active_listing: "Vinted UK asking price" },
  kindRoles: { active_listing: "buy_listing" },
  caveat:
    "Vinted UK is read by an unofficial community scraper: asking prices from private sellers, best-effort, and it may stop working at any time.",
  configured: true,
  origin: "plugin",
  pluginId: 1,
};

/** the fixture registry plus the approved Vinted plugin's one source */
const withVinted = (): void => setSourcesForTests([...SOURCES_FIXTURE, vintedUk]);

function asking(overrides: Partial<PricePointDto>): PricePointDto {
  return {
    source: "vinted_uk",
    kind: "active_listing",
    region: "PAL",
    condition: "unknown",
    priceUsd: 24,
    priceOriginal: 20,
    currencyOriginal: "GBP",
    available: null,
    ...overrides,
  };
}

function prices(blocks: SourceBlock[]): PricesResponse {
  return { game, sources: blocks, signals: [], gamePriceMode: null };
}

const emptyCollection: CollectionResponse = {
  items: [], valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
  totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0,
};
const emptyWatchlist: WatchlistResponse = { items: [] };

function stubPrices(response: PricesResponse): void {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/prices")) return new Response(JSON.stringify(response));
    if (String(url).includes("/collection")) return new Response(JSON.stringify(emptyCollection));
    if (String(url).includes("/watchlist")) return new Response(JSON.stringify(emptyWatchlist));
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetMoneyForTests();
  window.localStorage.clear();
});

/**
 * Where one source shows on the game page: its rows in the shared price
 * table and its note under it. Waits until the source's name is on screen.
 */
async function blockOf(label: string): Promise<HTMLElement> {
  await screen.findAllByText(new RegExp(`^${label}`));
  return document.body;
}

describe("a community-sidecar market in the game view", () => {
  it("renders asking prices as a plain listing block, with its honesty caveat", async () => {
    withVinted();
    stubPrices(
      prices([
        {
          source: "vinted_uk",
          status: "ok",
          fetchedAt: "2026-09-03T10:00:00Z",
          points: [
            asking({ listingTitle: "Pilotwings 64 PAL", url: "https://www.vinted.co.uk/items/1" }),
            asking({ listingTitle: "Pilotwings 64 boxed", priceUsd: 40, priceOriginal: 33 }),
          ],
          cheapestListings: [
            { title: "Pilotwings 64 PAL", priceUsd: 24, priceOriginal: 20, currencyOriginal: "GBP", condition: "unknown", grade: null, url: "https://www.vinted.co.uk/items/1" },
          ],
        },
      ]),
    );
    render(<GameDetail game={game} onBack={() => {}} />);

    const block = await blockOf("Vinted UK");
    // the caveat comes from the manifest and is rendered like any other
    expect(within(block).getByText(/unofficial community scraper/i)).toBeInTheDocument();
    // a marketplace of private sellers has one side, so no buy/sell switch:
    // the screen reads that off the declared roles, not off the source id
    expect(within(block).queryByRole("button", { name: /sell/i })).toBeNull();
    expect(within(block).getByText("Pilotwings 64 PAL")).toBeInTheDocument();
    // an asking price is a thing you can go and look at: every row the source
    // gave a URL for is rendered as a link to that listing
    const links = within(block).getAllByRole("link");
    expect(links.some((a) => a.getAttribute("href") === "https://www.vinted.co.uk/items/1")).toBe(true);
  });

  it("hides the block entirely when no sidecar is deployed", async () => {
    // `not_configured` is the state of every deployment that never deployed
    // this community source, and it is not an outage: the screen says nothing
    // at all rather than showing a permanent error for a source nobody asked
    // for. The CeX block beside it proves the page rendered.
    //
    // The registry HAS this source (the plugin is approved), so the hiding is
    // the `not_configured` rule doing it and not the id going unrecognised —
    // an unknown id would hide this heading too, for a different reason.
    withVinted();
    stubPrices(
      prices([
        { source: "cex", status: "ok", fetchedAt: "2026-09-03T10:00:00Z", points: [] },
        { source: "vinted_uk", status: "not_configured", points: [] },
      ]),
    );
    render(<GameDetail game={game} onBack={() => {}} />);

    await blockOf("CeX UK");
    expect(screen.queryByText(/^Vinted UK/)).toBeNull();
  });

  it("says the source is failing and labels what it still has as old", async () => {
    // A deployed sidecar whose circuit has opened: the block appears, the
    // error is stated, and the stored asking prices are shown with their own
    // age rather than quietly passing for fresh.
    withVinted();
    stubPrices(
      prices([
        {
          source: "vinted_uk",
          status: "error",
          fetchedAt: "2026-09-01T09:00:00Z",
          points: [asking({ listingTitle: "Pilotwings 64 PAL" })],
        },
      ]),
    );
    render(<GameDetail game={game} onBack={() => {}} />);

    const block = await blockOf("Vinted UK");
    expect(within(block).getByText(/Source error/)).toBeInTheDocument();
    expect(within(block).getByText(/showing stale data/)).toBeInTheDocument();
  });

  it("renders a source this build has never heard of, from the registry alone", async () => {
    // The proof that the manifest left the bundle: this id appears in no
    // TypeScript file under src, and the block still gets its label, its
    // per-kind wording and its caveat.
    //
    // What it looked like before the registry moved to runtime, measured on
    // this same setup: the game view rendered as an empty <div> and threw
    // "Cannot read properties of undefined (reading 'label')" out of
    // GameDetail's block map. A blank screen, not a degraded one.
    const imported: SourceInfoDto = {
      id: "kleinanzeigen_de",
      label: "Kleinanzeigen DE",
      family: "kleinanzeigen",
      familyLabel: "Kleinanzeigen",
      kind: "live",
      country: "DE",
      reach: "global",
      defaultRegion: null,
      expectedCurrencies: ["EUR"],
      kindRoles: { active_listing: "buy_listing" },
      kindLabels: { active_listing: "Kleinanzeigen asking price" },
      caveat: "read by a community plugin",
      configured: true,
      origin: "plugin",
      pluginId: 7,
    };
    setSourcesForTests([...SOURCES_FIXTURE, imported]);
    stubPrices(
      prices([
        {
          source: "kleinanzeigen_de",
          status: "ok",
          fetchedAt: "2026-09-03T10:00:00Z",
          points: [asking({ source: "kleinanzeigen_de", currencyOriginal: "EUR", listingTitle: null })],
        },
      ]),
    );
    render(<GameDetail game={game} onBack={() => {}} />);

    const block = await blockOf("Kleinanzeigen DE");
    expect(within(block).getByText(/Kleinanzeigen asking price/)).toBeInTheDocument();
    expect(within(block).getByText("read by a community plugin")).toBeInTheDocument();
    // one-sided market: it declares no buy_store/bid pair, so no buy/sell switch
    expect(within(block).queryByRole("button", { name: /sell/i })).toBeNull();
  });

  it("names a source missing from the registry by its id rather than blanking", async () => {
    // The honest degraded state: the registry is KNOWN and this id is not in
    // it — a plugin disabled or removed after its prices were stored. (Not
    // the same as an unknown registry, which hides the price blocks outright;
    // see SourcesGate.test.tsx.) Nothing renders as blank and nothing throws
    // — the id stands in for the label and the shared kind wording stands in
    // for the source's own. What cannot be recovered is the buy/sell split:
    // the deployment says it has no such source, so nobody can say what its
    // roles were, and each row's own wording is all that is left.
    setSourcesForTests([]);
    stubPrices(
      prices([
        {
          source: "kleinanzeigen_de",
          status: "ok",
          fetchedAt: "2026-09-03T10:00:00Z",
          points: [asking({ source: "kleinanzeigen_de", currencyOriginal: "EUR", listingTitle: null })],
        },
      ]),
    );
    render(<GameDetail game={game} onBack={() => {}} />);

    const block = await blockOf("kleinanzeigen_de");
    expect(within(block).getByText(/^listing/)).toBeInTheDocument(); // KIND_LABEL_FALLBACK
  });
});
