import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionScreen } from "../src/screens/CollectionScreen.js";
import type {
  CollectionResponse,
  CsvCollectionImportResponse,
  CsvCollectionImportRow,
  CsvImportRequest,
} from "@retrowatchdog/shared";

const emptyCollection: CollectionResponse = {
  items: [],
  totalEstimatedUsd: 0,
  totalPaidUsd: 0,
  totalRealizedUsd: 0, totalReturnedUsd: 0,
  valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false },
};

// what the "file" contains; the stub asserts the request carries it verbatim
const csvText = [
  "game_id,title,platform,region,condition,grade,status,paid_original,paid_currency,paid_usd,notes,acquired_at,acquired_source,acquired_url,match_basis",
  "7,Super Mario Land,gb,PAL,cib,,owned,12.5,GBP,16,,,,,exact",
  ",Tetris,gb,PAL,loose,,owned,,,,,,,,",
  ",Wave Race,gb,PAL,loose,,owned,,,,,,,,",
  ",Mario Kart Wii,wii,PAL,cib,,owned,,,,,,,,",
  ",Obscure Homebrew,nes,PAL,loose,,owned,,,,,,,,",
].join("\n");

function row(
  overrides: Partial<CsvCollectionImportRow> & Pick<CsvCollectionImportRow, "rowIndex" | "title">,
): CsvCollectionImportRow {
  return {
    platformValue: "gb",
    platform: "gb",
    matchStatus: "matched",
    matchScore: 1,
    matchedBy: "game_id",
    game: null,
    candidates: [],
    duplicate: false,
    region: "PAL",
    condition: "cib",
    grade: null,
    status: "owned",
    paidOriginal: null,
    paidCurrency: null,
    paidUsd: null,
    notes: null,
    acquiredAt: null,
    acquiredSource: null,
    acquiredUrl: null,
    ...overrides,
  };
}

// One of each preview group: game_id restore (with paid money), matched-by-
// title duplicate (SELECTABLE on CSV), review with two candidates,
// unsupported platform value, unmatched.
const previewRows: CsvCollectionImportRow[] = [
  row({
    rowIndex: 0,
    title: "Super Mario Land",
    paidOriginal: 12.5,
    paidCurrency: "GBP",
    paidUsd: 16,
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
    rowIndex: 1,
    title: "Tetris",
    condition: "loose",
    matchedBy: "title",
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
    rowIndex: 2,
    title: "Wave Race",
    condition: "loose",
    matchStatus: "review",
    matchScore: 0.31,
    matchedBy: null,
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
    rowIndex: 3,
    title: "Mario Kart Wii",
    platformValue: "wii", // genuinely unsupported: not a Platform union id
    platform: null,
    matchStatus: "unsupported_platform",
    matchScore: null,
    matchedBy: null,
  }),
  row({
    rowIndex: 4,
    title: "Obscure Homebrew",
    platformValue: "nes",
    platform: "nes",
    matchStatus: "unmatched",
    matchScore: null,
    matchedBy: null,
  }),
];

const previewResponse: CsvCollectionImportResponse = {
  dryRun: true,
  rows: previewRows,
  imported: 0,
  skipped: 1,
  totals: { matched: 2, review: 1, unmatched: 1, unsupported: 1 },
};

const importResponse: CsvCollectionImportResponse = {
  dryRun: false,
  rows: previewRows,
  imported: 2,
  skipped: 0,
  totals: previewResponse.totals,
};

/** Routes GET /api/collection and the CSV import POST; anything else throws. */
function stubApi(
  preview: Response | CsvCollectionImportResponse,
  imported: CsvCollectionImportResponse = importResponse,
) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/collection/import/csv")) {
      const body = JSON.parse(String(init?.body)) as CsvImportRequest;
      if (body.dryRun === false) return new Response(JSON.stringify(imported));
      return preview instanceof Response ? preview : new Response(JSON.stringify(preview));
    }
    if (u.includes("/api/collection")) return new Response(JSON.stringify(emptyCollection));
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

/** body of the dryRun:false confirm call */
function confirmBody(fetchMock: ReturnType<typeof stubApi>): CsvImportRequest {
  const calls = fetchMock.mock.calls as unknown as FetchCall[];
  const call = calls.find(
    (c) => String(c[0]).includes("import/csv") && String(c[1]?.body).includes('"dryRun":false'),
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]?.body)) as CsvImportRequest;
}

async function openPanelAndUpload(csv: string = csvText): Promise<void> {
  render(<CollectionScreen onSelect={() => {}} />);
  await screen.findByText(/Nothing here yet/);
  await userEvent.click(screen.getByRole("button", { name: "Import CSV" }));
  await userEvent.upload(
    screen.getByLabelText(/csv file/i),
    new File([csv], "retrowatchdog-collection-20260901.csv", { type: "text/csv" }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear(); // the view toggle persists; keep tests isolated
});

describe("CollectionScreen CSV export", () => {
  it("renders a plain download anchor to the export endpoint and says what it includes", async () => {
    stubApi(previewResponse);
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText(/Nothing here yet/);
    const link = screen.getByRole("link", { name: "Export CSV" });
    expect(link).toHaveAttribute("href", "/api/collection/export");
    expect(link).toHaveAttribute("download");
    expect(
      screen.getByText("Includes sold and returned items with their sale and return details."),
    ).toBeInTheDocument();
  });
});

describe("CollectionScreen CSV import", () => {
  it("reads the file, POSTs a dryRun preview with the file's text, and renders every group", async () => {
    const fetchMock = stubApi(previewResponse);
    await openPanelAndUpload();

    expect(
      await screen.findByText(/2 matched · 1 need review · 1 unmatched · 1 unsupported/),
    ).toBeInTheDocument();

    // the preview request carried the file text verbatim, as a dryRun
    const calls = fetchMock.mock.calls as unknown as FetchCall[];
    const previewCall = calls.find((c) => String(c[0]).includes("import/csv"));
    expect(previewCall).toBeDefined();
    const body = JSON.parse(String(previewCall![1]?.body)) as CsvImportRequest;
    expect(body.csv).toBe(csvText);
    expect(body.dryRun).toBe(true);
    expect(body.includeRowIndexes).toBeUndefined();

    // matched game_id restore: checked, verbatim original paid money, and no
    // "→ title" arrow (it would repeat the row title)
    const matchedBox = screen.getByRole("checkbox", { name: /super mario land/i });
    expect(matchedBox).toBeChecked();
    expect(matchedBox).toBeEnabled();
    expect(screen.getByText(/paid £12\.50/)).toBeInTheDocument();
    expect(screen.queryByText(/→ Super Mario Land/)).not.toBeInTheDocument();

    // review row: radio group with candidate percentages, Don't import default
    expect(screen.getByText("Import candidates")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /wave race 64 \(31%, number mismatch\)/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /wave race blue storm \(28%\)/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /don't import/i })).toBeChecked();

    // unsupported group: raw platform value preserved
    expect(screen.getByText(/1 rows with unsupported platform values \(wii\)/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /mario kart wii/i })).not.toBeInTheDocument();

    // unmatched group: title + raw platform value, no checkbox
    expect(screen.getByText("Obscure Homebrew")).toBeInTheDocument();
    expect(screen.getByText("(nes)")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /obscure homebrew/i })).not.toBeInTheDocument();

    // button counts only the checked non-duplicate matched row
    expect(screen.getByRole("button", { name: "Import 1 items" })).toBeInTheDocument();
  });

  it("duplicates are default-unchecked but SELECTABLE, with the possible-duplicate note", async () => {
    const fetchMock = stubApi(previewResponse);
    await openPanelAndUpload();

    // unlike the PriceCharting import's disabled duplicates
    const dupBox = await screen.findByRole("checkbox", { name: /tetris/i });
    expect(dupBox).not.toBeChecked();
    expect(dupBox).toBeEnabled();
    expect(screen.getByText(/possible duplicate/)).toBeInTheDocument();

    await userEvent.click(dupBox);
    await userEvent.click(screen.getByRole("button", { name: "Import 2 items" }));

    expect(await screen.findByText("Imported 2 items")).toBeInTheDocument();
    const body = confirmBody(fetchMock);
    // numeric row indexes, explicitly including the re-added duplicate
    expect(body.includeRowIndexes).toEqual([0, 1]);
    expect(body.overrides).toBeUndefined();
  });

  it("confirm sends numeric includeRowIndexes and decimal-string override keys", async () => {
    const fetchMock = stubApi(previewResponse);
    await openPanelAndUpload();

    await userEvent.click(
      await screen.findByRole("radio", { name: /wave race 64 \(31%, number mismatch\)/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Import 2 items" }));

    expect(await screen.findByText("Imported 2 items")).toBeInTheDocument();
    const body = confirmBody(fetchMock);
    expect(body.includeRowIndexes).toEqual([0]);
    expect(body.overrides).toEqual({ "2": 8 });

    // preview cleared and the collection reloaded after the import
    expect(screen.queryByRole("checkbox", { name: /super mario land/i })).not.toBeInTheDocument();
    const calls = fetchMock.mock.calls as unknown as FetchCall[];
    const collectionGets = calls.filter(
      (c) => !String(c[0]).includes("import/csv") && String(c[0]).includes("/api/collection"),
    );
    expect(collectionGets.length).toBeGreaterThanOrEqual(2);
  });

  it("unchecking everything disables the import button", async () => {
    stubApi(previewResponse);
    await openPanelAndUpload();
    await userEvent.click(await screen.findByRole("checkbox", { name: /super mario land/i }));
    expect(screen.getByRole("button", { name: "Import 0 items" })).toBeDisabled();
  });

  it("renders every rowError of an invalid_rows 400 (all-or-nothing: nothing imported)", async () => {
    stubApi(
      new Response(
        JSON.stringify({
          error: "CSV rows failed validation",
          code: "invalid_rows",
          rowErrors: [
            {
              rowIndex: 2,
              column: "paid_currency",
              message: "paid_original and paid_currency go together (both or neither)",
            },
            { rowIndex: 4, column: "acquired_at", message: "must be an ISO date (YYYY-MM-DD), or empty" },
          ],
        }),
        { status: 400 },
      ),
    );
    await openPanelAndUpload();

    expect(
      await screen.findByText(/API 400 importing CSV: CSV rows failed validation/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing was imported/)).toBeInTheDocument();
    // 1-based data-row numbering, as announced by the header line
    expect(
      screen.getByText(/Row 3: paid_currency — paid_original and paid_currency go together/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Row 5: acquired_at — must be an ISO date/)).toBeInTheDocument();
    // no preview groups rendered on error
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows the server's message for an invalid header", async () => {
    stubApi(
      new Response(
        JSON.stringify({
          error: "invalid CSV header — missing: [grade], unknown: [grading]",
          code: "invalid_header",
          missing: ["grade"],
          unknown: ["grading"],
        }),
        { status: 400 },
      ),
    );
    await openPanelAndUpload("grading\nmint");
    expect(
      await screen.findByText(/API 400 importing CSV: invalid CSV header — missing: \[grade\]/),
    ).toBeInTheDocument();
  });
});
