import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WatchlistScreen } from "../src/screens/WatchlistScreen.js";
import type {
  CsvImportRequest,
  CsvWatchlistImportResponse,
  CsvWatchlistImportRow,
} from "@retrowatchdog/shared";

// what the "file" contains; the stub asserts the request carries it verbatim
const csvText = [
  "game_id,title,platform,region,condition,target_original,target_currency,target_usd",
  "7,Super Metroid,snes,,,30,GBP,38",
  "9,EarthBound,snes,PAL,cib,,,",
].join("\n");

function row(
  overrides: Partial<CsvWatchlistImportRow> & Pick<CsvWatchlistImportRow, "rowIndex" | "title">,
): CsvWatchlistImportRow {
  return {
    platformValue: "snes",
    platform: "snes",
    matchStatus: "matched",
    matchScore: 1,
    matchedBy: "game_id",
    game: null,
    candidates: [],
    duplicate: false,
    region: null,
    condition: null,
    targetOriginal: null,
    targetCurrency: null,
    targetUsd: null,
    ...overrides,
  };
}

const previewRows: CsvWatchlistImportRow[] = [
  // ANY-prefs watch with a verbatim target original
  row({
    rowIndex: 0,
    title: "Super Metroid",
    targetOriginal: 30,
    targetCurrency: "GBP",
    targetUsd: 38,
    game: { id: 7, title: "Super Metroid", platform: "snes", year: 1994, coverUrl: null },
  }),
  // already-watched (game, region, condition): skipped by the constraint
  row({
    rowIndex: 1,
    title: "EarthBound",
    region: "PAL",
    condition: "cib",
    game: { id: 9, title: "EarthBound", platform: "snes", year: 1994, coverUrl: null },
    duplicate: true,
  }),
];

const previewResponse: CsvWatchlistImportResponse = {
  dryRun: true,
  rows: previewRows,
  imported: 0,
  skipped: 1, // the flagged-duplicate estimate
  totals: { matched: 2, review: 0, unmatched: 0, unsupported: 0 },
};

const importResponse: CsvWatchlistImportResponse = {
  dryRun: false,
  rows: previewRows,
  imported: 1,
  skipped: 1,
  totals: previewResponse.totals,
};

/** Routes GET /api/watchlist and the CSV import POST; anything else throws. */
function stubApi(
  preview: Response | CsvWatchlistImportResponse = previewResponse,
  imported: CsvWatchlistImportResponse = importResponse,
) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/watchlist/import/csv")) {
      const body = JSON.parse(String(init?.body)) as CsvImportRequest;
      if (body.dryRun === false) return new Response(JSON.stringify(imported));
      return preview instanceof Response ? preview : new Response(JSON.stringify(preview));
    }
    if (u.includes("/api/watchlist")) return new Response(JSON.stringify({ items: [] }));
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

async function openPanelAndUpload(): Promise<void> {
  render(<WatchlistScreen onSelect={() => {}} />);
  await screen.findByText(/Nothing watched yet/);
  await userEvent.click(screen.getByRole("button", { name: "Import CSV" }));
  await userEvent.upload(
    screen.getByLabelText(/csv file/i),
    new File([csvText], "retrowatchdog-watchlist-20260901.csv", { type: "text/csv" }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear(); // the view toggle persists; keep tests isolated
});

describe("WatchlistScreen CSV export", () => {
  it("renders a plain download anchor to the export endpoint", async () => {
    stubApi();
    render(<WatchlistScreen onSelect={() => {}} />);
    await screen.findByText(/Nothing watched yet/);
    const link = screen.getByRole("link", { name: "Export CSV" });
    expect(link).toHaveAttribute("href", "/api/watchlist/export");
    expect(link).toHaveAttribute("download");
  });
});

describe("WatchlistScreen CSV import", () => {
  it("previews with ANY prefs, verbatim target money, and the skip estimate", async () => {
    const fetchMock = stubApi();
    await openPanelAndUpload();

    expect(
      await screen.findByText(/2 matched · 0 need review · 0 unmatched · 0 unsupported/),
    ).toBeInTheDocument();

    // the preview request carried the file text verbatim, as a dryRun
    const calls = fetchMock.mock.calls as unknown as FetchCall[];
    const previewCall = calls.find((c) => String(c[0]).includes("import/csv"));
    const body = JSON.parse(String(previewCall![1]?.body)) as CsvImportRequest;
    expect(body.csv).toBe(csvText);
    expect(body.dryRun).toBe(true);

    // null region/condition render as "any"; the target stays a verbatim original
    expect(screen.getByText(/SNES · any · any · target £30\.00/)).toBeInTheDocument();

    // duplicate: disabled (the unique constraint skips it at insert anyway)
    const dupBox = screen.getByRole("checkbox", { name: /earthbound/i });
    expect(dupBox).toBeDisabled();
    expect(dupBox).not.toBeChecked();
    expect(screen.getByText(/already watched — will be skipped/)).toBeInTheDocument();

    // the flagged-duplicate estimate from the dryRun response
    expect(screen.getByText(/1 rows are already watched and will be skipped/)).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Import 1 items" })).toBeInTheDocument();
  });

  it("confirms with numeric includeRowIndexes and reports the constraint skips", async () => {
    const fetchMock = stubApi();
    await openPanelAndUpload();

    await userEvent.click(await screen.findByRole("button", { name: "Import 1 items" }));

    expect(await screen.findByText("Imported 1, skipped 1 already watched")).toBeInTheDocument();
    const calls = fetchMock.mock.calls as unknown as FetchCall[];
    const confirm = calls.find(
      (c) => String(c[0]).includes("import/csv") && String(c[1]?.body).includes('"dryRun":false'),
    );
    expect(confirm).toBeDefined();
    const body = JSON.parse(String(confirm![1]?.body)) as CsvImportRequest;
    expect(body.includeRowIndexes).toEqual([0]);
    expect(body.overrides).toBeUndefined();

    // preview cleared and the watchlist reloaded after the import
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const watchlistGets = calls.filter(
      (c) => !String(c[0]).includes("import/csv") && String(c[0]).includes("/api/watchlist"),
    );
    expect(watchlistGets.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces an FX-down 503 without wiping the preview state message area", async () => {
    stubApi(previewResponse, importResponse);
    const fetchMock = vi.mocked(fetch);
    // replace only the confirm call with a 503
    fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/watchlist/import/csv")) {
        const body = JSON.parse(String(init?.body)) as CsvImportRequest;
        if (body.dryRun === false) {
          return new Response(
            JSON.stringify({ error: "FX rate for GBP is unavailable — cannot convert to USD right now, try again later" }),
            { status: 503 },
          );
        }
        return new Response(JSON.stringify(previewResponse));
      }
      if (u.includes("/api/watchlist")) return new Response(JSON.stringify({ items: [] }));
      throw new Error(`unexpected fetch: ${u}`);
    });
    await openPanelAndUpload();
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 items" }));
    expect(
      await screen.findByText(/API 503 importing CSV: FX rate for GBP is unavailable/),
    ).toBeInTheDocument();
    // nothing was written: the preview stays so the user can retry
    expect(screen.getByRole("button", { name: "Import 1 items" })).toBeInTheDocument();
  });
});
