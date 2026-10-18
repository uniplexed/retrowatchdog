import type { FastifyInstance, FastifyReply } from "fastify";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ACQUIRED_SOURCES,
  COLLECTION_CSV_COLUMNS,
  COLLECTION_CSV_OPTIONAL_COLUMNS,
  CONDITIONS,
  COPY_STATUSES,
  ITEM_GRADES,
  PLATFORMS,
  REGIONS,
  SUPPORTED_CURRENCIES,
  WATCHLIST_CSV_COLUMNS,
} from "@retrowatchdog/shared";
import type {
  AcquiredSource,
  Condition,
  CopyStatus,
  CsvCollectionImportResponse,
  CsvCollectionImportRow,
  CsvImportRowBase,
  CsvRowError,
  CsvWatchlistImportResponse,
  CsvWatchlistImportRow,
  GameSummary,
  ItemGrade,
  MatchBasis,
  Platform,
  Region,
  SupportedCurrency,
} from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { games, ownedCopies, watchlist } from "../db/schema.js";
import { CsvParseError, headerIndex, parseCsv, validateHeader } from "../lib/csv.js";
import { createTitleMatcher, type TitleMatcherDeps } from "../importers/matching.js";
import { ratesToUsd } from "../pricing/fx.js";

/**
 * CSV imports for collection and watchlist: dryRun preview, then confirm,
 * keyed by 0-based data-row index. A valid game_id skips matching (exact restore).
 */

// each row costs a trigram query and maybe an IGDB call: a cap, not a quota
const MAX_CSV_ROWS = 5000;
const bodySchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(true),
  includeRowIndexes: z.array(z.number().int().nonnegative()).optional(),
  /** review-row decisions: rowIndex (decimal string) -> chosen gameId */
  overrides: z.record(z.string().regex(/^\d+$/), z.number().int().positive()).optional(),
});

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Per-row field readers that accumulate CsvRowError instead of throwing. */
function fieldParsers(get: (col: string) => string, rowIndex: number, errors: CsvRowError[]) {
  const err = (column: string, message: string): null => {
    errors.push({ rowIndex, column, message });
    return null;
  };
  return {
    err,
    enumField<T extends string, E extends T | null>(col: string, allowed: readonly T[], empty: E): T | E | null {
      const v = get(col);
      if (v === "") return empty;
      if ((allowed as readonly string[]).includes(v)) return v as T;
      return err(col, `must be one of: ${allowed.join(", ")} — or empty`);
    },
    currencyField(col: string): SupportedCurrency | null {
      const v = get(col).toUpperCase();
      if (v === "") return null;
      if ((SUPPORTED_CURRENCIES as readonly string[]).includes(v)) return v as SupportedCurrency;
      return err(col, `must be one of: ${SUPPORTED_CURRENCIES.join(", ")} — or empty`);
    },
    decimalField(col: string): number | null {
      const v = get(col);
      if (v === "") return null;
      if (!DECIMAL_RE.test(v)) return err(col, "must be a non-negative decimal number, or empty");
      // numeric(10,2) bounds: reject what the insert would fail on or round.
      const [intPart, fracPart = ""] = v.split(".");
      const intDigits = intPart.replace(/^0+(?=\d)/, "");
      if (intDigits.length > 8) return err(col, "must have at most 8 digits before the decimal point");
      if (fracPart.length > 2) return err(col, "must have at most 2 decimal places");
      return Number(v);
    },
    gameIdField(col: string): number | null {
      const v = get(col);
      if (v === "") return null;
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 2_147_483_647) {
        return err(col, "must be a positive integer id, or empty");
      }
      return Number(v);
    },
    dateField(col: string): string | null {
      const v = get(col);
      if (v === "") return null;
      if (!DATE_RE.test(v)) return err(col, "must be an ISO date (YYYY-MM-DD), or empty");
      // Reject calendar-invalid dates ("2026-02-30") so confirm never 500s.
      const [y, m, d] = v.split("-").map(Number);
      const dt = new Date(0);
      dt.setUTCFullYear(y, m - 1, d);
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
        return err(col, "must be a real calendar date");
      }
      return v;
    },
    textField(col: string, max: number): string | null {
      const v = get(col);
      if (v === "") return null;
      if (v.length > max) return err(col, `must be at most ${max} characters`);
      return v;
    },
  };
}

interface CsvContext {
  header: string[];
  rows: string[][];
  get: (row: string[], col: string) => string;
}

/** Parses + header-validates the CSV; on failure sends the 400 and returns null. */
function readCsvOr400(
  reply: FastifyReply,
  csvText: string,
  expected: readonly string[],
  optional: readonly string[] = [],
): CsvContext | null {
  let parsed;
  try {
    parsed = parseCsv(csvText);
  } catch (e) {
    if (e instanceof CsvParseError) {
      reply.code(400).send({ error: e.message, code: "invalid_csv" });
      return null;
    }
    throw e;
  }
  if (parsed.rows.length > MAX_CSV_ROWS) {
    reply.code(400).send({ error: `at most ${MAX_CSV_ROWS} rows per import`, code: "invalid_csv" });
    return null;
  }
  if (parsed.rows.length > MAX_CSV_ROWS) {
    reply.code(400).send({ error: `at most ${MAX_CSV_ROWS} rows per import`, code: "invalid_csv" });
    return null;
  }
  if (parsed.rows.length > MAX_CSV_ROWS) {
    reply.code(400).send({ error: `at most ${MAX_CSV_ROWS} rows per import`, code: "invalid_csv" });
    return null;
  }
  const problems = validateHeader(parsed.header, expected, optional);
  if (problems) {
    reply.code(400).send({
      error:
        `invalid CSV header — missing: [${problems.missing.join(", ")}], ` +
        `unknown: [${problems.unknown.join(", ")}]`,
      code: "invalid_header",
      ...problems,
    });
    return null;
  }
  const idx = headerIndex(parsed.header);
  return {
    header: parsed.header,
    rows: parsed.rows,
    // an optional column left out of the file reads as empty
    get: (row, col) => (idx.has(col) ? row[idx.get(col)!] : ""),
  };
}

type MatchFields = Pick<
  CsvImportRowBase,
  "matchStatus" | "matchScore" | "matchedBy" | "game" | "candidates"
>;

const gameSummary = (g: {
  id: number;
  title: string;
  platform: string;
  year: number | null;
  coverUrl: string | null;
}): GameSummary => ({
  id: g.id,
  title: g.title,
  platform: g.platform as Platform,
  year: g.year,
  coverUrl: g.coverUrl,
});

/** A game_id that exists short-circuits to matched; otherwise the fuzzy pipeline. */
async function resolveCsvMatches(
  deps: TitleMatcherDeps,
  rows: Array<{ gameId: number | null; title: string; platformValue: string }>,
): Promise<Array<MatchFields & { platform: Platform | null }>> {
  const { db } = deps;
  const explicitIds = [...new Set(rows.map((r) => r.gameId).filter((id): id is number => id !== null))];
  const found =
    explicitIds.length === 0
      ? []
      : await db.select().from(games).where(inArray(games.id, explicitIds));
  const gameById = new Map(found.map((g) => [g.id, gameSummary(g)]));

  const matcher = createTitleMatcher(deps);
  const out: Array<MatchFields & { platform: Platform | null }> = [];
  for (const row of rows) {
    const known = row.gameId !== null ? gameById.get(row.gameId) : undefined;
    if (known) {
      out.push({
        matchStatus: "matched",
        matchScore: 1,
        matchedBy: "game_id",
        game: known,
        candidates: [{ game: known, score: 1, numeralMismatch: false }],
        platform: known.platform,
      });
      continue;
    }
    // empty or foreign game_id: fuzzy path against the CSV platform column
    const platformKey = row.platformValue.toLowerCase();
    const platform = Object.hasOwn(PLATFORMS, platformKey) ? (platformKey as Platform) : null;
    if (platform === null) {
      out.push({
        matchStatus: "unsupported_platform",
        matchScore: null,
        matchedBy: null,
        game: null,
        candidates: [],
        platform: null,
      });
      continue;
    }
    const match = await matcher.match(row.title, platform);
    out.push({
      ...match,
      matchedBy: match.matchStatus === "matched" ? "title" : null,
      platform,
    });
  }
  return out;
}

/**
 * All-or-nothing: every chosen game must exist (cross-platform picks are allowed).
 * Returns the bad rowIndex, or null.
 */
async function findInvalidOverride(
  db: Db,
  overriddenRows: Array<{ rowIndex: number; chosenId: number }>,
): Promise<number | null> {
  if (overriddenRows.length === 0) return null;
  const chosenIds = [...new Set(overriddenRows.map((r) => r.chosenId))];
  const found = await db.select({ id: games.id }).from(games).where(inArray(games.id, chosenIds));
  const existing = new Set(found.map((g) => g.id));
  for (const r of overriddenRows) {
    if (!existing.has(r.chosenId)) return r.rowIndex;
  }
  return null;
}

/**
 * Money leg for insert. A USD twin in the CSV is taken verbatim (frozen amounts
 * are never re-derived); a usd-only leg stores no synthesized original.
 */
function moneyLeg(
  original: number | null,
  currency: SupportedCurrency | null,
  usd: number | null,
  rateFor: (currency: SupportedCurrency) => number,
): { original: string | null; currency: SupportedCurrency | null; usd: string } | null {
  if (original !== null && currency !== null) {
    const frozenUsd = usd ?? round2(original * rateFor(currency));
    return { original: String(original), currency, usd: String(frozenUsd) };
  }
  if (usd !== null) return { original: null, currency: null, usd: String(usd) };
  return null;
}

/**
 * A collection row's sale/return group. sold_currency denominates all four
 * amounts; a purchase returned unsold falls back to paid_currency for its
 * return leg, as PATCH /api/collection/:id does.
 */
interface Disposal {
  soldAt: string | null;
  soldVenue: string | null;
  currency: SupportedCurrency | null;
  returnCurrency: SupportedCurrency | null;
  sold: AmountCols;
  fees: AmountCols;
  returnedAt: string | null;
  refund: AmountCols;
  returnCosts: AmountCols;
}
interface AmountCols {
  original: number | null;
  usd: number | null;
}

function parseDisposal(
  p: ReturnType<typeof fieldParsers>,
  status: CopyStatus,
  paidCurrency: SupportedCurrency | null,
): Disposal {
  const amount = (originalCol: string, usdCol: string): AmountCols => ({
    original: p.decimalField(originalCol),
    usd: p.decimalField(usdCol),
  });
  const currency = p.currencyField("sold_currency");
  const d: Disposal = {
    soldAt: p.dateField("sold_at"),
    soldVenue: p.textField("sold_venue", 100),
    currency,
    returnCurrency: currency ?? paidCurrency,
    sold: amount("sold_original", "sold_usd"),
    fees: amount("sold_fees_original", "sold_fees_usd"),
    returnedAt: p.dateField("returned_at"),
    refund: amount("refund_original", "refund_usd"),
    returnCosts: amount("return_costs_original", "return_costs_usd"),
  };
  // PATCH /api/collection/:id's rules, except a returned copy keeps its sale
  const isSet = (a: AmountCols): boolean => a.original !== null || a.usd !== null;
  const hasSold = d.soldAt !== null || d.soldVenue !== null || isSet(d.sold) || isSet(d.fees);
  const hasReturned = d.returnedAt !== null || isSet(d.refund) || isSet(d.returnCosts);
  if (status === "sold" && (d.soldAt === null || d.sold.original === null)) {
    p.err("status", "status 'sold' requires sold_at and sold_original");
  }
  if (hasSold && status !== "sold" && status !== "returned") {
    p.err("status", "sold_* columns require status 'sold' or 'returned'");
  }
  if (hasReturned && status !== "returned") {
    p.err("status", "returned_at, refund_* and return_costs_* require status 'returned'");
  }
  if ((d.sold.original !== null || d.fees.original !== null) && d.currency === null) {
    p.err("sold_currency", "required when a sale amount is set");
  }
  if ((d.refund.original !== null || d.returnCosts.original !== null) && d.returnCurrency === null) {
    p.err("sold_currency", "a return amount needs sold_currency, or paid_currency for a purchase returned unsold");
  }
  return d;
}

const disposalAmounts = (d: Disposal): AmountCols[] => [d.sold, d.fees, d.refund, d.returnCosts];

const currencyOf = (d: Disposal, a: AmountCols): SupportedCurrency | null =>
  a === d.sold || a === d.fees ? d.currency : d.returnCurrency;

function disposalLegs(d: Disposal) {
  return disposalAmounts(d).map((a) => ({ original: a.original, currency: currencyOf(d, a), usd: a.usd }));
}

function disposalValues(d: Disposal, rateFor: (currency: SupportedCurrency) => number) {
  const [sold, fees, refund, returnCosts] = disposalAmounts(d).map((a) =>
    moneyLeg(a.original, a.original === null ? null : currencyOf(d, a), a.usd, rateFor),
  );
  return {
    soldAt: d.soldAt,
    soldVenue: d.soldVenue,
    soldCurrency: d.currency,
    soldPriceOriginal: sold?.original ?? null,
    soldPriceUsd: sold?.usd ?? null,
    soldFeesOriginal: fees?.original ?? null,
    soldFeesUsd: fees?.usd ?? null,
    returnedAt: d.returnedAt,
    refundOriginal: refund?.original ?? null,
    refundUsd: refund?.usd ?? null,
    returnCostsOriginal: returnCosts?.original ?? null,
    returnCostsUsd: returnCosts?.usd ?? null,
  };
}

/** FX down and a row needs a conversion: the write must fail cleanly (503), never store a guess. */
class FxUnavailableError extends Error {
  constructor(currency: string) {
    super(`FX rate for ${currency} is unavailable — cannot convert to USD right now, try again later`);
    this.name = "FxUnavailableError";
  }
}

/** X->USD rates for every currency that needs an import-time conversion. */
async function ratesForImport(
  db: Db,
  legs: Array<{ original: number | null; currency: SupportedCurrency | null; usd: number | null }>,
): Promise<(currency: SupportedCurrency) => number> {
  const wanted = [
    ...new Set(
      legs
        .filter((l) => l.original !== null && l.currency !== null && l.usd === null)
        .map((l) => l.currency!),
    ),
  ];
  let rates: Map<string, number>;
  try {
    rates = await ratesToUsd(db, wanted);
  } catch {
    throw new FxUnavailableError(wanted[0] ?? "?");
  }
  return (currency) => {
    const rate = rates.get(currency);
    if (rate === undefined) throw new FxUnavailableError(currency);
    return rate;
  };
}

const totalsOf = (rows: CsvImportRowBase[]) => ({
  matched: rows.filter((r) => r.matchStatus === "matched").length,
  review: rows.filter((r) => r.matchStatus === "review").length,
  unmatched: rows.filter((r) => r.matchStatus === "unmatched").length,
  unsupported: rows.filter((r) => r.matchStatus === "unsupported_platform").length,
});

/** Provenance for an inserted row (same rules as the PriceCharting importer). */
function provenance(
  row: CsvImportRowBase,
  chosenId: number | undefined,
): { matchBasis: MatchBasis; matchScore: number | null } {
  if (row.matchStatus === "review") {
    const chosenCandidate = row.candidates.find((c) => c.game.id === chosenId);
    return chosenCandidate
      ? { matchBasis: "candidate", matchScore: chosenCandidate.score }
      : { matchBasis: "manual", matchScore: null };
  }
  // An explicit game_id has no fuzzy score.
  return row.matchedBy === "game_id"
    ? { matchBasis: "exact", matchScore: null }
    : { matchBasis: "exact", matchScore: row.matchScore };
}

export async function csvImportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/collection/import/csv", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { db, igdb } = app.deps;

    const csv = readCsvOr400(reply, parsed.data.csv, COLLECTION_CSV_COLUMNS, COLLECTION_CSV_OPTIONAL_COLUMNS);
    if (csv === null) return reply;

    // ---- row-level validation (all errors collected, then all-or-nothing 400)
    const errors: CsvRowError[] = [];
    interface RowData {
      rowIndex: number;
      gameId: number | null;
      title: string;
      platformValue: string;
      region: Region;
      condition: Condition;
      grade: ItemGrade | null;
      status: CopyStatus;
      paidOriginal: number | null;
      paidCurrency: SupportedCurrency | null;
      paidUsd: number | null;
      notes: string | null;
      acquiredAt: string | null;
      acquiredSource: AcquiredSource | null;
      acquiredUrl: string | null;
      disposal: Disposal;
    }
    const rowsData: RowData[] = [];
    for (const [rowIndex, fields] of csv.rows.entries()) {
      if (fields.length !== csv.header.length) {
        errors.push({
          rowIndex,
          column: "(row)",
          message: `expected ${csv.header.length} fields, got ${fields.length}`,
        });
        continue;
      }
      const raw = (col: string): string => csv.get(fields, col);
      const get = (col: string): string => raw(col).trim();
      const p = fieldParsers(get, rowIndex, errors);
      const gameId = p.gameIdField("game_id");
      const title = get("title");
      if (gameId === null && title === "") {
        p.err("title", "required when game_id is empty");
      }
      const paidOriginal = p.decimalField("paid_original");
      const paidCurrency = p.currencyField("paid_currency");
      if ((paidOriginal === null) !== (paidCurrency === null)) {
        p.err("paid_currency", "paid_original and paid_currency go together (both or neither)");
      }
      // notes keep leading/trailing whitespace (round-trip fidelity)
      const notesRaw = raw("notes");
      let notes: string | null = null;
      if (notesRaw !== "") {
        if (notesRaw.length > 500) p.err("notes", "must be at most 500 characters");
        else notes = notesRaw;
      }
      const status = p.enumField("status", COPY_STATUSES, "owned") ?? "owned";
      rowsData.push({
        rowIndex,
        gameId,
        title,
        platformValue: get("platform"),
        // region/condition default to "unknown" on the collection (NOT NULL columns)
        region: p.enumField("region", REGIONS, "unknown") ?? "unknown",
        condition: p.enumField("condition", CONDITIONS, "unknown") ?? "unknown",
        grade: p.enumField("grade", ITEM_GRADES, null),
        status,
        paidOriginal,
        paidCurrency,
        paidUsd: p.decimalField("paid_usd"),
        notes,
        acquiredAt: p.dateField("acquired_at"),
        acquiredSource: p.enumField("acquired_source", ACQUIRED_SOURCES, null),
        acquiredUrl: p.textField("acquired_url", 500),
        // match_basis is deliberately ignored: provenance is re-derived on import
        disposal: parseDisposal(p, status, paidCurrency),
      });
    }
    if (errors.length > 0) {
      return reply.code(400).send({
        error: "CSV rows failed validation",
        code: "invalid_rows",
        rowErrors: errors,
      });
    }

    // ---- matching (game_id short-circuit + shared fuzzy pipeline)
    const matches = await resolveCsvMatches({ db, igdb }, rowsData);

    // ---- duplicate flags: same (gameId, region, condition[, grade]) as an owned copy
    const existingCopies = await db
      .select({
        gameId: ownedCopies.gameId,
        region: ownedCopies.region,
        condition: ownedCopies.condition,
        itemGrade: ownedCopies.itemGrade,
      })
      .from(ownedCopies);
    const gradesByTriple = new Map<string, Set<string>>();
    for (const c of existingCopies) {
      const key = `${c.gameId}|${c.region}|${c.condition}`;
      const set = gradesByTriple.get(key) ?? new Set<string>();
      set.add(c.itemGrade ?? "");
      gradesByTriple.set(key, set);
    }
    const isDuplicate = (gameId: number, region: Region, condition: Condition, grade: ItemGrade | null): boolean => {
      const set = gradesByTriple.get(`${gameId}|${region}|${condition}`);
      if (!set) return false;
      return grade === null ? true : set.has(grade);
    };

    const overrides = parsed.data.overrides ?? {};
    const chosenFor = (rowIndex: number): number | undefined => overrides[String(rowIndex)];

    const rows: CsvCollectionImportRow[] = rowsData.map((data, i) => {
      const match = matches[i];
      const effectiveId =
        match.matchStatus === "matched"
          ? match.game!.id
          : match.matchStatus === "review"
            ? chosenFor(data.rowIndex)
            : undefined;
      return {
        rowIndex: data.rowIndex,
        title: data.title,
        platformValue: data.platformValue,
        platform: match.platform,
        matchStatus: match.matchStatus,
        matchScore: match.matchScore,
        matchedBy: match.matchedBy,
        game: match.game,
        candidates: match.candidates,
        duplicate:
          effectiveId !== undefined &&
          isDuplicate(effectiveId, data.region, data.condition, data.grade),
        region: data.region,
        condition: data.condition,
        grade: data.grade,
        status: data.status,
        paidOriginal: data.paidOriginal,
        paidCurrency: data.paidCurrency,
        paidUsd: data.paidUsd,
        notes: data.notes,
        acquiredAt: data.acquiredAt,
        acquiredSource: data.acquiredSource,
        acquiredUrl: data.acquiredUrl,
      };
    });

    // ---- eligibility. Duplicates are selectable but default-unchecked (a restore
    // may re-add a copy); review rows import only via an explicit override.
    const includeSet = parsed.data.includeRowIndexes
      ? new Set(parsed.data.includeRowIndexes)
      : null;
    const toImport = rows.filter(
      (r) =>
        (r.matchStatus === "matched" &&
          (includeSet === null ? !r.duplicate : includeSet.has(r.rowIndex))) ||
        (r.matchStatus === "review" && chosenFor(r.rowIndex) !== undefined),
    );
    const skipped =
      includeSet === null
        ? rows.filter((r) => r.matchStatus === "matched" && r.duplicate).length
        : 0;

    // all-or-nothing override validation BEFORE any insert
    const invalidOverride = await findInvalidOverride(
      db,
      toImport
        .filter((r) => r.matchStatus === "review")
        .map((r) => ({ rowIndex: r.rowIndex, chosenId: chosenFor(r.rowIndex)! })),
    );
    if (invalidOverride !== null) {
      return reply.code(400).send({
        error: `override for row ${invalidOverride} must reference an existing game`,
        code: "invalid_override",
        rowIndex: invalidOverride,
      });
    }

    let imported = 0;
    if (!parsed.data.dryRun && toImport.length > 0) {
      let rateFor: (currency: SupportedCurrency) => number;
      const disposalOf = new Map(rowsData.map((d) => [d.rowIndex, d.disposal]));
      const legs = toImport.flatMap((r) => [
        { original: r.paidOriginal, currency: r.paidCurrency, usd: r.paidUsd },
        ...disposalLegs(disposalOf.get(r.rowIndex)!),
      ]);
      try {
        rateFor = await ratesForImport(db, legs);
        // a PriceCharting offer already in the collection is skipped (owned_copies_pc_offer)
        const inserted = await db.insert(ownedCopies).values(
          toImport.map((r) => {
            const chosenId = chosenFor(r.rowIndex);
            const gameId = r.matchStatus === "review" ? chosenId! : r.game!.id;
            const leg = moneyLeg(r.paidOriginal, r.paidCurrency, r.paidUsd, rateFor);
            return {
              gameId,
              region: r.region,
              condition: r.condition,
              itemGrade: r.grade,
              // Status inserts verbatim: a CSV restore reproduces prior state.
              status: r.status,
              notes: r.notes,
              acquiredAt: r.acquiredAt,
              acquiredSource: r.acquiredSource,
              acquiredUrl: r.acquiredUrl,
              acquiredPriceOriginal: leg?.original ?? null,
              acquiredCurrency: leg?.currency ?? null,
              acquiredPriceUsd: leg?.usd ?? null,
              ...disposalValues(disposalOf.get(r.rowIndex)!, rateFor),
              ...provenance(r, chosenId),
            };
          }),
        ).onConflictDoNothing().returning({ id: ownedCopies.id });
        imported = inserted.length;
      } catch (err) {
        if (err instanceof FxUnavailableError) return reply.code(503).send({ error: err.message });
        throw err;
      }
    }

    const body: CsvCollectionImportResponse = {
      dryRun: parsed.data.dryRun,
      rows,
      imported,
      skipped,
      totals: totalsOf(rows),
    };
    return body;
  });

  app.post("/api/watchlist/import/csv", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { db, igdb } = app.deps;

    const csv = readCsvOr400(reply, parsed.data.csv, WATCHLIST_CSV_COLUMNS);
    if (csv === null) return reply;

    const errors: CsvRowError[] = [];
    interface RowData {
      rowIndex: number;
      gameId: number | null;
      title: string;
      platformValue: string;
      region: Region | null;
      condition: Condition | null;
      targetOriginal: number | null;
      targetCurrency: SupportedCurrency | null;
      targetUsd: number | null;
    }
    const rowsData: RowData[] = [];
    for (const [rowIndex, fields] of csv.rows.entries()) {
      if (fields.length !== csv.header.length) {
        errors.push({
          rowIndex,
          column: "(row)",
          message: `expected ${csv.header.length} fields, got ${fields.length}`,
        });
        continue;
      }
      const get = (col: string): string => csv.get(fields, col).trim();
      const p = fieldParsers(get, rowIndex, errors);
      const gameId = p.gameIdField("game_id");
      const title = get("title");
      if (gameId === null && title === "") {
        p.err("title", "required when game_id is empty");
      }
      const targetOriginal = p.decimalField("target_original");
      const targetCurrency = p.currencyField("target_currency");
      if ((targetOriginal === null) !== (targetCurrency === null)) {
        p.err("target_currency", "target_original and target_currency go together (both or neither)");
      }
      rowsData.push({
        rowIndex,
        gameId,
        title,
        platformValue: get("platform"),
        // watchlist: empty region/condition = "any" (NULL prefs)
        region: p.enumField("region", REGIONS, null),
        condition: p.enumField("condition", CONDITIONS, null),
        targetOriginal,
        targetCurrency,
        targetUsd: p.decimalField("target_usd"),
      });
    }
    if (errors.length > 0) {
      return reply.code(400).send({
        error: "CSV rows failed validation",
        code: "invalid_rows",
        rowErrors: errors,
      });
    }

    const matches = await resolveCsvMatches({ db, igdb }, rowsData);

    // duplicate flag: these rows will be skipped by the unique constraint
    const existingWatches = await db
      .select({ gameId: watchlist.gameId, region: watchlist.region, condition: watchlist.condition })
      .from(watchlist);
    const watchKey = (gameId: number, region: string | null, condition: string | null): string =>
      `${gameId}|${region ?? ""}|${condition ?? ""}`;
    const existingKeys = new Set(existingWatches.map((w) => watchKey(w.gameId, w.region, w.condition)));

    const overrides = parsed.data.overrides ?? {};
    const chosenFor = (rowIndex: number): number | undefined => overrides[String(rowIndex)];

    const rows: CsvWatchlistImportRow[] = rowsData.map((data, i) => {
      const match = matches[i];
      const effectiveId =
        match.matchStatus === "matched"
          ? match.game!.id
          : match.matchStatus === "review"
            ? chosenFor(data.rowIndex)
            : undefined;
      return {
        rowIndex: data.rowIndex,
        title: data.title,
        platformValue: data.platformValue,
        platform: match.platform,
        matchStatus: match.matchStatus,
        matchScore: match.matchScore,
        matchedBy: match.matchedBy,
        game: match.game,
        candidates: match.candidates,
        duplicate:
          effectiveId !== undefined && existingKeys.has(watchKey(effectiveId, data.region, data.condition)),
        region: data.region,
        condition: data.condition,
        targetOriginal: data.targetOriginal,
        targetCurrency: data.targetCurrency,
        targetUsd: data.targetUsd,
      };
    });

    // eligibility: default all matched rows; review rows via override
    const includeSet = parsed.data.includeRowIndexes
      ? new Set(parsed.data.includeRowIndexes)
      : null;
    const toImport = rows.filter(
      (r) =>
        (r.matchStatus === "matched" && (includeSet === null || includeSet.has(r.rowIndex))) ||
        (r.matchStatus === "review" && chosenFor(r.rowIndex) !== undefined),
    );

    const invalidOverride = await findInvalidOverride(
      db,
      toImport
        .filter((r) => r.matchStatus === "review")
        .map((r) => ({ rowIndex: r.rowIndex, chosenId: chosenFor(r.rowIndex)! })),
    );
    if (invalidOverride !== null) {
      return reply.code(400).send({
        error: `override for row ${invalidOverride} must reference an existing game`,
        code: "invalid_override",
        rowIndex: invalidOverride,
      });
    }

    let imported = 0;
    let skipped = 0;
    if (!parsed.data.dryRun && toImport.length > 0) {
      const legs = toImport.map((r) => ({
        original: r.targetOriginal,
        currency: r.targetCurrency,
        usd: r.targetUsd,
      }));
      try {
        const rateFor = await ratesForImport(db, legs);
        // Also skips intra-CSV repeats; the returning count is what landed.
        const inserted = await db
          .insert(watchlist)
          .values(
            toImport.map((r) => {
              const gameId = r.matchStatus === "review" ? chosenFor(r.rowIndex)! : r.game!.id;
              const leg = moneyLeg(r.targetOriginal, r.targetCurrency, r.targetUsd, rateFor);
              return {
                gameId,
                region: r.region,
                condition: r.condition,
                targetPriceOriginal: leg?.original ?? null,
                targetCurrency: leg?.currency ?? null,
                targetPriceUsd: leg?.usd ?? null,
              };
            }),
          )
          .onConflictDoNothing()
          .returning({ id: watchlist.id });
        imported = inserted.length;
        skipped = toImport.length - inserted.length;
      } catch (err) {
        if (err instanceof FxUnavailableError) return reply.code(503).send({ error: err.message });
        throw err;
      }
    } else {
      // preview: report what WOULD skip (flagged duplicates among the selection)
      skipped = toImport.filter((r) => r.duplicate).length;
    }

    const body: CsvWatchlistImportResponse = {
      dryRun: parsed.data.dryRun,
      rows,
      imported,
      skipped,
      totals: totalsOf(rows),
    };
    return body;
  });
}
