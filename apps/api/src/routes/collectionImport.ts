import type { FastifyInstance } from "fastify";
import { inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { PcImportResponse, PcImportRow } from "@retrowatchdog/shared";
import { games, ownedCopies } from "../db/schema.js";
import {
  fetchCollection,
  pcOfferUrl,
  PcFetchError,
  resolveImportRows,
} from "../importers/pricecharting/index.js";

const bodySchema = z.object({
  url: z.string().max(1000),
  dryRun: z.boolean().default(true),
  includeOfferIds: z.array(z.string().min(1)).optional(),
  /** review-row decisions: offerId -> chosen gameId (candidate picker) */
  overrides: z.record(z.string().min(1), z.number().int().positive()).optional(),
});

/** Only the public collection listing is accepted: /offers with a seller id. */
function validateCollectionUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostOk = url.hostname === "www.pricecharting.com" || url.hostname === "pricecharting.com";
  // https only: over http a redirect could send the fetch anywhere
  const protocolOk = url.protocol === "https:";
  if (!protocolOk || !hostOk || url.pathname !== "/offers" || !url.searchParams.has("seller")) {
    return null;
  }
  return url.toString();
}

function buildNotes(row: PcImportRow): string {
  // The public page has no purchase prices: record the market value in notes;
  // the acquisition leg stays null, never fabricated.
  let notes = `PriceCharting import: ${row.consoleName} — ${row.includes}`;
  if (row.valueUsd !== null) {
    notes += `; market value $${row.valueUsd.toFixed(2)} at import`;
  }
  return notes;
}

export async function collectionImportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/collection/import/pricecharting", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const url = validateCollectionUrl(parsed.data.url);
    if (url === null) {
      return reply.code(400).send({
        error: "url must be a pricecharting.com /offers link with a seller parameter",
      });
    }

    const { db, igdb, pcFetchPage } = app.deps;
    let raw;
    let totalCount: number | null;
    try {
      // re-fetch live: the confirm may come minutes after the preview
      ({ items: raw, totalCount } = await fetchCollection(url, pcFetchPage));
    } catch (err) {
      if (err instanceof PcFetchError) {
        req.log.warn(
          { statuses: err.statuses, attempts: err.attempts, err: err.message },
          "PriceCharting fetch failed after retries",
        );
        return reply.code(502).send({
          error: "PriceCharting is rate-limiting requests — wait a minute and try again",
          code: err.code,
        });
      }
      throw err;
    }

    const existing = await db
      .select({ acquiredUrl: ownedCopies.acquiredUrl })
      .from(ownedCopies)
      .where(isNotNull(ownedCopies.acquiredUrl));
    const existingUrls = new Set(
      existing.map((r) => r.acquiredUrl).filter((u): u is string => u !== null),
    );

    const rows = await resolveImportRows({ db, igdb }, raw, { existingUrls });

    const includeSet = parsed.data.includeOfferIds ? new Set(parsed.data.includeOfferIds) : null;
    const overrides = parsed.data.overrides ?? {};
    // Review rows import ONLY via an explicit override, never includeOfferIds.
    const eligible = rows.filter(
      (r) =>
        (r.matchStatus === "matched" &&
          r.game !== null &&
          (includeSet === null || includeSet.has(r.offerId))) ||
        (r.matchStatus === "review" && overrides[r.offerId] !== undefined),
    );
    const skippedDuplicates = eligible.filter((r) => r.duplicate).length;
    const toImport = eligible.filter((r) => !r.duplicate);

    // All-or-nothing override validation before any insert. Existence-only:
    // cross-platform picks are deliberate (the "Other" picker has a console selector).
    const overridden = toImport.filter((r) => r.matchStatus === "review");
    if (overridden.length > 0) {
      const chosenIds = [...new Set(overridden.map((r) => overrides[r.offerId]))];
      const chosen = await db
        .select({ id: games.id })
        .from(games)
        .where(inArray(games.id, chosenIds));
      const existing = new Set(chosen.map((g) => g.id));
      for (const r of overridden) {
        if (!existing.has(overrides[r.offerId])) {
          return reply.code(400).send({
            error: `override for offer ${r.offerId} must reference an existing game`,
            code: "invalid_override",
            offerId: r.offerId,
          });
        }
      }
    }

    let imported = 0;
    if (!parsed.data.dryRun && toImport.length > 0) {
      // A concurrent import that already landed an offer is skipped, not a 500.
      const inserted = await db.insert(ownedCopies).values(
        toImport.map((r) => {
          // Provenance: 'exact' auto-match, 'candidate' override (with its score),
          // or 'manual' for any other pick.
          const chosenCandidate =
            r.matchStatus === "review"
              ? r.candidates.find((c) => c.game.id === overrides[r.offerId])
              : undefined;
          const matchBasis =
            r.matchStatus === "review" ? (chosenCandidate ? "candidate" : "manual") : "exact";
          const matchScore =
            r.matchStatus === "review" ? (chosenCandidate?.score ?? null) : r.matchScore;
          return {
            // review rows import the game the user chose, matched rows their winner
            gameId: r.matchStatus === "review" ? overrides[r.offerId] : r.game!.id,
            region: r.region!,
            condition: r.condition!,
            status: "owned",
            acquiredSource: "pricecharting_import",
            acquiredUrl: pcOfferUrl(r.offerId),
            notes: buildNotes(r),
            matchBasis,
            matchScore,
            // acquisition price leg deliberately absent: no cost data on the public page
          };
        }),
      ).onConflictDoNothing().returning({ id: ownedCopies.id });
      imported = inserted.length;
    }

    const totals = {
      matched: rows.filter((r) => r.matchStatus === "matched").length,
      review: rows.filter((r) => r.matchStatus === "review").length,
      unmatched: rows.filter((r) => r.matchStatus === "unmatched").length,
      unsupported: rows.filter((r) => r.matchStatus === "unsupported_platform").length,
    };
    const body: PcImportResponse = {
      dryRun: parsed.data.dryRun,
      rows,
      imported,
      skippedDuplicates,
      totals,
      totalCount,
      // page cap or unparsed rows mean the preview is not the whole collection
      truncated: totalCount !== null && rows.length < totalCount,
    };
    return body;
  });
}
