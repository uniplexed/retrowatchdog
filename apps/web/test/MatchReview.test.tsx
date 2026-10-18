import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionScreen } from "../src/screens/CollectionScreen.js";
import type { CollectionResponse, GameSummary, OwnedCopyDto, SearchResponse } from "@retrowatchdog/shared";

function copy(overrides: Partial<OwnedCopyDto> & Pick<OwnedCopyDto, "id" | "game">): OwnedCopyDto {
  return {
    region: "PAL", condition: "loose", notes: null,
    acquiredAt: null, acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: null,
    status: "owned",
    itemGrade: null, workingState: null, authenticity: null,
    acquiredSource: null, acquiredUrl: null, acquisitionId: null,
    soldAt: null, soldPriceOriginal: null, soldFeesOriginal: null, soldCurrency: null,
    soldPriceUsd: null, soldFeesUsd: null, soldVenue: null,
    returnedAt: null, refundOriginal: null, returnCostsOriginal: null,
    refundUsd: null, returnCostsUsd: null,
    estimatedValueUsd: null, valueBasis: null, valueFetchedAt: null,
    signals: [], matchBasis: null, matchScore: null,
    ...overrides,
  };
}

// The real failure behind this screen: Sonic 1 (Game Gear) imported as
// Sonic 2 through a 72% candidate pick, noticed days later.
const sonic2: GameSummary = { id: 30, title: "Sonic the Hedgehog 2", platform: "game_gear", year: 1992, coverUrl: "https://covers.example/s2.jpg" };
const sonic1: GameSummary = { id: 21, title: "Sonic the Hedgehog", platform: "game_gear", year: 1991, coverUrl: null };
const waveRace: GameSummary = { id: 8, title: "Wave Race 64", platform: "gb", year: 1997, coverUrl: null };
const tetris: GameSummary = { id: 9, title: "Tetris", platform: "gb", year: 1989, coverUrl: null };
const marioLand: GameSummary = { id: 7, title: "Super Mario Land", platform: "gb", year: 1989, coverUrl: null };

const items: OwnedCopyDto[] = [
  copy({
    id: 1, game: sonic2, matchBasis: "candidate", matchScore: 0.72,
    notes: "PriceCharting import: PAL Sega Game Gear — Item",
  }),
  copy({ id: 2, game: waveRace, matchBasis: "manual", matchScore: null }),
  copy({ id: 3, game: tetris, matchBasis: "exact", matchScore: 1 }),
  copy({ id: 4, game: marioLand }), // hand-added: nothing to review
];

function collectionOf(list: OwnedCopyDto[]): CollectionResponse {
  return { items: list, valuationBasis: "market", valuationMarkets: { country: "GB", includeForeign: false }, totalEstimatedUsd: 0, totalPaidUsd: 0, totalRealizedUsd: 0, totalReturnedUsd: 0 };
}

/**
 * Routes GET /api/collection (serving whatever `state.current` holds),
 * /api/search, and the two review endpoints; the endpoint handlers can swap
 * `state.current` so the follow-up reload sees the write.
 */
function stubApi(opts: {
  initial: CollectionResponse;
  afterConfirm?: CollectionResponse;
  afterLink?: CollectionResponse;
  search?: SearchResponse;
}) {
  const state = { current: opts.initial };
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/search")) return new Response(JSON.stringify(opts.search ?? { games: [] }));
    if (u.includes("/confirm-link")) {
      if (opts.afterConfirm) state.current = opts.afterConfirm;
      return new Response(JSON.stringify(state.current.items[0]));
    }
    if (u.includes("/link")) {
      if (opts.afterLink) state.current = opts.afterLink;
      return new Response(JSON.stringify(state.current.items[0]));
    }
    if (u.includes("/api/collection") && init?.method === undefined) {
      return new Response(JSON.stringify(state.current));
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function reviewRowOf(title: string): HTMLElement {
  return screen.getByText(title).closest(".review-row") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("CollectionScreen match review", () => {
  it("counts candidate+manual items in the Review chip and lists them with provenance and import notes", async () => {
    stubApi({ initial: collectionOf(items) });
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    await userEvent.click(screen.getByRole("button", { name: "Review (2)" }));

    // only the unconfirmed machine/hand picks are listed
    expect(screen.getAllByText(/currently →/)).toHaveLength(2);
    expect(within(reviewRowOf("Sonic the Hedgehog 2")).getByText(/basis candidate 72%/)).toBeInTheDocument();
    expect(within(reviewRowOf("Wave Race 64")).getByText(/basis manual/)).toBeInTheDocument();
    // the original imported title, for judging source title vs linked game
    expect(screen.getByText("PriceCharting import: PAL Sega Game Gear — Item")).toBeInTheDocument();
  });

  it("hides the Review chip when nothing needs review", async () => {
    stubApi({ initial: collectionOf([items[2], items[3]]) }); // exact + hand-added only
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    expect(screen.queryByRole("button", { name: /Review \(/ })).not.toBeInTheDocument();
  });

  it("Confirm calls confirm-link and the row leaves the list", async () => {
    const confirmed = items.map((i) =>
      i.id === 1 ? { ...i, matchBasis: "confirmed" as const } : i,
    );
    const fetchMock = stubApi({
      initial: collectionOf(items),
      afterConfirm: collectionOf(confirmed),
    });
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    await userEvent.click(screen.getByRole("button", { name: "Review (2)" }));
    await userEvent.click(within(reviewRowOf("Sonic the Hedgehog 2")).getByRole("button", { name: "Confirm" }));

    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    const post = calls.find((c) => String(c[0]).includes("/confirm-link"));
    expect(post).toBeDefined();
    expect(String(post![0])).toContain("/api/collection/1/confirm-link");
    expect(post![1]?.method).toBe("POST");

    // reload: the confirmed row is gone, the other stays, the chip counts down
    await waitFor(() =>
      expect(screen.queryByText("Sonic the Hedgehog 2")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Wave Race 64")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review (1)" })).toBeInTheDocument();
  });

  it("Re-link opens the shared console+game picker and PATCHes the picked game; the row shows the new target", async () => {
    const relinked = items.map((i) =>
      i.id === 1
        ? { ...i, game: sonic1, matchBasis: "manual" as const, matchScore: null }
        : i,
    );
    const fetchMock = stubApi({
      initial: collectionOf(items),
      afterLink: collectionOf(relinked),
      search: { games: [sonic1] },
    });
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    await userEvent.click(screen.getByRole("button", { name: "Review (2)" }));
    await userEvent.click(within(reviewRowOf("Sonic the Hedgehog 2")).getByRole("button", { name: "Re-link…" }));

    // the SAME picker the import preview's "Other…" uses, preset to the
    // current link's console
    const consoleSelect = screen.getByLabelText(/console/i) as HTMLSelectElement;
    expect(consoleSelect.value).toBe("game_gear");
    await userEvent.type(screen.getByLabelText(/search game/i), "sonic");
    await userEvent.click(
      await screen.findByRole("button", { name: /sonic the hedgehog \(game gear\)/i }),
    );

    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    const patch = calls.find((c) => c[1]?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(String(patch![0])).toContain("/api/collection/1/link");
    expect(JSON.parse(String(patch![1]?.body))).toEqual({ gameId: 21 });

    // the row now shows the corrected target and stays listed until confirmed
    expect(await screen.findByText("Sonic the Hedgehog")).toBeInTheDocument();
    expect(within(reviewRowOf("Sonic the Hedgehog")).getByText(/basis manual/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review (2)" })).toBeInTheDocument();
  });

  it("a row's Re-link action opens the review UI focused on that single copy", async () => {
    stubApi({ initial: collectionOf(items) });
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    // one action per row, in item order — Tetris (exact, unflagged) is third:
    // ANY copy can be re-linked, not only the flagged ones
    const relinks = screen.getAllByRole("button", { name: /^Re-link / });
    expect(relinks).toHaveLength(4);
    await userEvent.click(relinks[2]);

    // focused review: only the Tetris row, provenance included
    expect(screen.getAllByText(/currently →/)).toHaveLength(1);
    expect(within(reviewRowOf("Tetris")).getByText(/basis exact 100%/)).toBeInTheDocument();
    expect(screen.queryByText("Wave Race 64")).not.toBeInTheDocument();
    expect(screen.queryByText("Sonic the Hedgehog 2")).not.toBeInTheDocument();
  });

  it("focused Confirm exits back to the list with a confirmation note and the refreshed basis", async () => {
    const confirmed = items.map((i) =>
      i.id === 1 ? { ...i, matchBasis: "confirmed" as const } : i,
    );
    stubApi({ initial: collectionOf(items), afterConfirm: collectionOf(confirmed) });
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    // focus the flagged Sonic 2 copy (first row) via its Re-link action
    await userEvent.click(screen.getAllByRole("button", { name: /^Re-link / })[0]);
    expect(screen.getAllByText(/currently →/)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    // back on the list — not parked on a focused row the id-filter would keep
    // rendering with dead buttons
    await waitFor(() => expect(screen.queryByText(/currently →/)).not.toBeInTheDocument());
    // every row's Edit action marks the list
    expect(screen.getAllByRole("button", { name: /^Edit copy/ })).toHaveLength(4);
    // the transient note gives the action visible feedback
    expect(screen.getByText("Link confirmed ✓")).toBeInTheDocument();
    // the reload picked up the confirmed matchBasis: the chip counts one fewer
    expect(screen.getByRole("button", { name: "Review (1)" })).toBeInTheDocument();
  });

  it("review mode always has a way back to the list, even with nothing left flagged", async () => {
    // a confirmed copy re-linked from its row: no copy is flagged, so the
    // Review (N) chip has nothing to count — the way back must still be there
    const allConfirmed = items.map((i) => ({ ...i, matchBasis: "confirmed" as const }));
    stubApi({ initial: collectionOf(allConfirmed) });
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    await userEvent.click(screen.getAllByRole("button", { name: /^Re-link / })[0]);
    expect(screen.getAllByText(/currently →/)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Back to the list" }));
    expect(screen.queryByText(/currently →/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Edit copy/ })).toHaveLength(4);
  });

  it("focused re-link stays on the focused review row until confirmed", async () => {
    const relinked = items.map((i) =>
      i.id === 1
        ? { ...i, game: sonic1, matchBasis: "manual" as const, matchScore: null }
        : i,
    );
    stubApi({
      initial: collectionOf(items),
      afterLink: collectionOf(relinked),
      search: { games: [sonic1] },
    });
    render(<CollectionScreen onSelect={() => {}} />);
    await screen.findByText("Tetris");
    await userEvent.click(screen.getAllByRole("button", { name: /^Re-link / })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Re-link…" }));
    await userEvent.type(screen.getByLabelText(/search game/i), "sonic");
    await userEvent.click(
      await screen.findByRole("button", { name: /sonic the hedgehog \(game gear\)/i }),
    );

    // still the focused review row, now showing the corrected link — a
    // re-link must remain visible until confirmed; only Confirm exits
    expect(await screen.findByText("Sonic the Hedgehog")).toBeInTheDocument();
    expect(within(reviewRowOf("Sonic the Hedgehog")).getByText(/basis manual/)).toBeInTheDocument();
    expect(screen.getAllByText(/currently →/)).toHaveLength(1);
    expect(screen.queryByText("Link confirmed ✓")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/status/i)).not.toBeInTheDocument();
    // still review mode, not the list: no row Edit action either
    expect(screen.queryByRole("button", { name: /^Edit copy/ })).not.toBeInTheDocument();
  });
});
