import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionScreen } from "../src/screens/CollectionScreen.js";
import type {
  CollectionResponse,
  PcImportRequest,
  PcImportResponse,
  PcImportRow,
  SearchResponse,
} from "@retrowatchdog/shared";

const emptyCollection: CollectionResponse = {
  items: [],
  totalEstimatedUsd: 0,
  totalPaidUsd: 0,
  totalRealizedUsd: 0, totalReturnedUsd: 0,
  valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};

function row(overrides: Partial<PcImportRow> & Pick<PcImportRow, "offerId" | "title">): PcImportRow {
  return {
    consoleName: "GameBoy",
    includes: "Item, Box, and Manual",
    valueUsd: null,
    platform: "gb",
    region: "NTSC_U",
    condition: "cib",
    matchStatus: "matched",
    matchScore: 1,
    game: null,
    candidates: [],
    duplicate: false,
    ...overrides,
  };
}

// One of each preview group: matched (exact), review with two candidates,
// duplicate, unsupported platform, and unmatched.
const previewRows: PcImportRow[] = [
  row({
    offerId: "off-match",
    title: "Super Mario Land",
    valueUsd: 44.99,
    matchScore: 1,
    game: { id: 7, title: "Super Mario Land", platform: "gb", year: 1989, coverUrl: null },
    candidates: [
      {
        game: { id: 7, title: "Super Mario Land", platform: "gb", year: 1989, coverUrl: null },
        score: 1,
        numeralMismatch: false,
      },
    ],
  }),
  row({
    offerId: "off-review",
    title: "Wave Race",
    includes: "Item",
    condition: "loose",
    valueUsd: 12,
    matchStatus: "review",
    matchScore: 0.31,
    game: { id: 8, title: "Wave Race 64", platform: "gb", year: 1997, coverUrl: null },
    candidates: [
      {
        game: { id: 8, title: "Wave Race 64", platform: "gb", year: 1997, coverUrl: null },
        score: 0.31,
        numeralMismatch: true,
      },
      {
        game: { id: 12, title: "Wave Race Blue Storm", platform: "gb", year: 2001, coverUrl: null },
        score: 0.28,
        numeralMismatch: false,
      },
    ],
  }),
  row({
    offerId: "off-dup",
    title: "Tetris",
    valueUsd: 9.5,
    matchScore: 1,
    game: { id: 9, title: "Tetris", platform: "gb", year: 1989, coverUrl: null },
    candidates: [
      {
        game: { id: 9, title: "Tetris", platform: "gb", year: 1989, coverUrl: null },
        score: 1,
        numeralMismatch: false,
      },
    ],
    duplicate: true,
  }),
  row({
    offerId: "off-unsup",
    title: "Mario Kart Wii",
    consoleName: "Wii", // genuinely unsupported: not in the Platform union
    platform: null,
    region: null,
    condition: null,
    matchStatus: "unsupported_platform",
    matchScore: null,
  }),
  row({
    offerId: "off-unmatched",
    title: "Obscure Homebrew",
    consoleName: "NES",
    platform: "nes",
    matchStatus: "unmatched",
    matchScore: null,
  }),
];

const previewResponse: PcImportResponse = {
  dryRun: true,
  rows: previewRows,
  imported: 0,
  skippedDuplicates: 1,
  totals: { matched: 2, review: 1, unmatched: 1, unsupported: 1 },
  totalCount: previewRows.length, // summary count == rows fetched: nothing lost
  truncated: false,
};

const importResponse: PcImportResponse = {
  dryRun: false,
  rows: previewRows,
  imported: 1,
  skippedDuplicates: 0,
  totals: previewResponse.totals,
  totalCount: previewRows.length,
  truncated: false,
};

// The real failure that motivated the candidates UI: "Sonic the Hedgehog"
// [Game Gear] fuzzy-collapsed onto "Sonic the Hedgehog 2" — penalty-capped to
// review, and the right game only findable through the "Other…" search.
const sonicRow = row({
  offerId: "off-sonic",
  title: "Sonic the Hedgehog",
  consoleName: "PAL Sega Game Gear",
  includes: "Item",
  platform: "game_gear",
  region: "PAL",
  condition: "loose",
  matchStatus: "review",
  matchScore: 0.44,
  game: { id: 30, title: "Sonic the Hedgehog 2", platform: "game_gear", year: 1992, coverUrl: null },
  candidates: [
    {
      game: { id: 30, title: "Sonic the Hedgehog 2", platform: "game_gear", year: 1992, coverUrl: null },
      score: 0.44,
      numeralMismatch: true,
    },
  ],
});

const sonicPreview: PcImportResponse = {
  dryRun: true,
  rows: [sonicRow],
  imported: 0,
  skippedDuplicates: 0,
  totals: { matched: 0, review: 1, unmatched: 0, unsupported: 0 },
  totalCount: 1,
  truncated: false,
};

// same title on two consoles: exercises the console filter of the Other flow
const sonicSearch: SearchResponse = {
  games: [
    { id: 21, title: "Sonic the Hedgehog", platform: "game_gear", year: 1991, coverUrl: null },
    { id: 22, title: "Sonic the Hedgehog", platform: "megadrive", year: 1991, coverUrl: null },
  ],
};

/** Routes /api/search, GET /api/collection and the import POST; anything else throws. */
function stubApi(
  preview: Response | PcImportResponse,
  imported: PcImportResponse = importResponse,
  search: SearchResponse = { games: [] },
) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/search")) return new Response(JSON.stringify(search));
    if (u.includes("/api/collection/import/pricecharting")) {
      const body = JSON.parse(String(init?.body)) as PcImportRequest;
      if (body.dryRun === false) return new Response(JSON.stringify(imported));
      return preview instanceof Response ? preview : new Response(JSON.stringify(preview));
    }
    if (u.includes("/api/collection")) return new Response(JSON.stringify(emptyCollection));
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** body of the dryRun:false confirm call */
function importBody(fetchMock: ReturnType<typeof stubApi>): PcImportRequest {
  const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
  const call = calls.find(
    (c) => String(c[0]).includes("import/pricecharting") && String(c[1]?.body).includes('"dryRun":false'),
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]?.body)) as PcImportRequest;
}

async function openPanelAndPreview(): Promise<void> {
  render(<CollectionScreen onSelect={() => {}} />);
  await screen.findByText(/Nothing here yet/);
  await userEvent.click(screen.getByRole("button", { name: "Import from PriceCharting" }));
  await userEvent.type(
    screen.getByLabelText(/collection url/i),
    "https://www.pricecharting.com/offers?seller=abc&status=collection",
  );
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CollectionScreen PriceCharting import", () => {
  it("toggles the import panel from the header button", async () => {
    stubApi(previewResponse);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText(/Nothing here yet/);
    expect(screen.queryByLabelText(/collection url/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Import from PriceCharting" }));
    expect(screen.getByLabelText(/collection url/i)).toBeInTheDocument();
    expect(
      screen.getByText(/imported without\s+acquisition cost/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Import from PriceCharting" }));
    expect(screen.queryByLabelText(/collection url/i)).not.toBeInTheDocument();
  });

  it("renders the preview groups: matched checkboxes, candidate radios, duplicate, unsupported, unmatched", async () => {
    stubApi(previewResponse);
    await openPanelAndPreview();

    expect(await screen.findByText(/2 matched · 1 need review · 1 unmatched · 1 unsupported/)).toBeInTheDocument();

    // complete fetch (truncated: false): no truncation warning
    expect(screen.queryByText(/could not be fetched/)).not.toBeInTheDocument();

    // matched section: checked by default, native USD value only — no
    // conversion line (PriceCharting is natively USD)
    expect(screen.getByText("Matched")).toBeInTheDocument();
    const matchedBox = screen.getByRole("checkbox", { name: /super mario land/i });
    expect(matchedBox).toBeChecked();
    expect(matchedBox).toBeEnabled();
    expect(screen.getByText(/· \$44\.99/)).toBeInTheDocument();
    expect(screen.queryByText(/~£/)).not.toBeInTheDocument();

    // review row: no checkbox any more — a radio group instead, with per-
    // candidate percentage labels and the numeral-mismatch warning
    expect(screen.getByText("Import candidates")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /wave race/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /wave race 64 \(31%, number mismatch\)/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /wave race blue storm \(28%\)/i })).toBeInTheDocument();
    // "Don't import" is the default selection
    expect(screen.getByRole("radio", { name: /don't import/i })).toBeChecked();
    // review row value: same native USD rendering
    expect(screen.getByText(/GameBoy · Item · \$12\.00$/)).toBeInTheDocument();

    // duplicate row: visible but disabled and unchecked
    const dupBox = screen.getByRole("checkbox", { name: /tetris/i });
    expect(dupBox).toBeDisabled();
    expect(dupBox).not.toBeChecked();
    expect(screen.getByText(/already imported/)).toBeInTheDocument();

    // unsupported group: muted note with console names and the enabling hint
    expect(
      screen.getByText(/1 items on unsupported platforms \(Wii\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/packages\/shared\/src\/platforms\.ts to enable/)).toBeInTheDocument();
    // unsupported rows get no checkbox
    expect(screen.queryByRole("checkbox", { name: /mario kart wii/i })).not.toBeInTheDocument();

    // unmatched group: title + console, no checkbox
    expect(screen.getByText("Obscure Homebrew")).toBeInTheDocument();
    expect(screen.getByText("(NES)")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /obscure homebrew/i })).not.toBeInTheDocument();

    // button counts ONLY the checked matched row: review needs an active pick
    expect(screen.getByRole("button", { name: "Import 1 items" })).toBeInTheDocument();
  });

  it("imports the checked matched rows without overrides when nothing is picked", async () => {
    const fetchMock = stubApi(previewResponse);
    await openPanelAndPreview();
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 items" }));

    expect(await screen.findByText("Imported 1, skipped 0 duplicates")).toBeInTheDocument();
    const body = importBody(fetchMock);
    expect(body.includeOfferIds).toEqual(["off-match"]);
    expect(body.overrides).toBeUndefined();

    // preview list is cleared after a successful import
    expect(screen.queryByRole("checkbox", { name: /super mario land/i })).not.toBeInTheDocument();

    // collection list reloaded after the import
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    const collectionGets = calls.filter(
      (c) => !String(c[0]).includes("import/pricecharting") && String(c[0]).includes("/api/collection"),
    );
    expect(collectionGets.length).toBeGreaterThanOrEqual(2);
  });

  it("unchecking the matched row leaves nothing to import and disables the button", async () => {
    stubApi(previewResponse);
    await openPanelAndPreview();
    await userEvent.click(await screen.findByRole("checkbox", { name: /super mario land/i }));
    expect(screen.getByRole("button", { name: "Import 0 items" })).toBeDisabled();
  });

  it("selecting a listed candidate sends it in overrides alongside the checked matched rows", async () => {
    const fetchMock = stubApi(previewResponse);
    await openPanelAndPreview();
    await screen.findByRole("checkbox", { name: /super mario land/i });

    await userEvent.click(screen.getByRole("radio", { name: /wave race 64 \(31%, number mismatch\)/i }));
    await userEvent.click(screen.getByRole("button", { name: "Import 2 items" }));

    expect(await screen.findByText("Imported 1, skipped 0 duplicates")).toBeInTheDocument();
    const body = importBody(fetchMock);
    expect(body.includeOfferIds).toEqual(["off-match"]);
    expect(body.overrides).toEqual({ "off-review": 8 });
  });

  it("switching a candidate row back to Don't import removes its override", async () => {
    stubApi(previewResponse);
    await openPanelAndPreview();
    await userEvent.click(await screen.findByRole("radio", { name: /wave race 64/i }));
    expect(screen.getByRole("button", { name: "Import 2 items" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /don't import/i }));
    expect(screen.getByRole("button", { name: "Import 1 items" })).toBeInTheDocument();
  });

  it("Other… reveals console select + search, filters by console, and sends the pick in overrides", async () => {
    const fetchMock = stubApi(sonicPreview, importResponse, sonicSearch);
    await openPanelAndPreview();
    await userEvent.click(await screen.findByRole("radio", { name: /other/i }));

    // console select defaults to the row's detected platform
    const consoleSelect = screen.getByLabelText(/console/i) as HTMLSelectElement;
    expect(consoleSelect.value).toBe("game_gear");

    await userEvent.type(screen.getByLabelText(/search game/i), "sonic");
    // only the Game Gear result is visible; the Mega Drive sibling is hidden
    expect(
      await screen.findByRole("button", { name: /sonic the hedgehog \(game gear\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sonic the hedgehog \(mega drive\)/i }),
    ).not.toBeInTheDocument();

    // changing the console re-filters the same results
    await userEvent.selectOptions(consoleSelect, "megadrive");
    expect(
      await screen.findByRole("button", { name: /sonic the hedgehog \(mega drive\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sonic the hedgehog \(game gear\)/i }),
    ).not.toBeInTheDocument();

    // cross-platform pick is allowed (that is what the console selector is
    // for) and collapses the search behind the "→ pick" summary
    await userEvent.click(screen.getByRole("button", { name: /sonic the hedgehog \(mega drive\)/i }));
    expect(screen.getByText(/→ Sonic the Hedgehog \(Mega Drive\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/search game/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Import 1 items" }));
    const body = importBody(fetchMock);
    expect(body.includeOfferIds).toEqual([]);
    expect(body.overrides).toEqual({ "off-sonic": 22 });
  });

  it("switching from Other back to Don't import clears the manual pick", async () => {
    stubApi(sonicPreview, importResponse, sonicSearch);
    await openPanelAndPreview();
    await userEvent.click(await screen.findByRole("radio", { name: /other/i }));
    await userEvent.type(screen.getByLabelText(/search game/i), "sonic");
    await userEvent.click(
      await screen.findByRole("button", { name: /sonic the hedgehog \(game gear\)/i }),
    );
    expect(screen.getByRole("button", { name: "Import 1 items" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /don't import/i }));
    expect(screen.getByRole("button", { name: "Import 0 items" })).toBeDisabled();
    expect(screen.queryByText(/→ Sonic the Hedgehog/)).not.toBeInTheDocument();
  });

  it("floors near-exact candidate scores so a review row never shows a false 100%", async () => {
    // 0.9989 sits below the 0.999 exact cutoff (that is WHY the row needs
    // review) — rounding would display "100%" and contradict the section.
    stubApi({
      ...previewResponse,
      rows: [
        row({
          offerId: "off-almost",
          title: "Wario Land",
          matchStatus: "review",
          matchScore: 0.9989,
          game: { id: 9, title: "Wario Land", platform: "gb", year: 1994, coverUrl: null },
          candidates: [
            {
              game: { id: 9, title: "Wario Land", platform: "gb", year: 1994, coverUrl: null },
              score: 0.9989,
              numeralMismatch: false,
            },
          ],
        }),
      ],
      totals: { matched: 0, review: 1, unmatched: 0, unsupported: 0 },
    });
    await openPanelAndPreview();
    expect(await screen.findByRole("radio", { name: /wario land \(99%\)/i })).toBeInTheDocument();
    // no candidate label may claim (100%) — the section's own helper copy
    // legitimately mentions "100%", so match the parenthesized score shape
    expect(screen.queryByRole("radio", { name: /\(100%/ })).not.toBeInTheDocument();
  });

  it("warns when the preview is truncated (fewer rows than the page's own count)", async () => {
    stubApi({ ...previewResponse, totalCount: 67, truncated: true });
    await openPanelAndPreview();
    await screen.findByText(/2 matched · 1 need review · 1 unmatched · 1 unsupported/);
    expect(
      screen.getByText(/Showing 5 of 67 items — the rest could not be\s+fetched\./),
    ).toBeInTheDocument();
  });

  it("shows the server's error for a rejected URL", async () => {
    stubApi(
      new Response(
        JSON.stringify({ error: "url must be a pricecharting.com /offers link with a seller parameter" }),
        { status: 400 },
      ),
    );
    await openPanelAndPreview();
    expect(
      await screen.findByText(/API 400 importing from PriceCharting: url must be a pricecharting\.com/),
    ).toBeInTheDocument();
    // no preview groups rendered on error
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
