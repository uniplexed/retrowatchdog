import type {
  Condition,
  ItemGrade,
  PriceKind,
  PricePointDto,
  PriceRole,
  Region,
  Signal,
  SignalAmount,
  SignalConfidence,
  SignalConfigDto,
  SourceId,
  SourceInfo,
} from "@retrowatchdog/shared";
import { kindDisplayLabel, PROFIT_FEE_CAVEAT } from "@retrowatchdog/shared";
import type { SignalHistory } from "./history.js";
/**
 * What the rules read: the stored configuration (settings/signals.ts) plus the
 * minimum gain converted to USD when it was loaded.
 */
export type SignalConfig = SignalConfigDto & {
  /** FLIP and PROFIT below this USD gain are dropped; null = no floor */
  minGainUsd: number | null;
};

/**
 * `export type`, not `export {}`: esbuild turns a value re-export of a
 * type-only binding into a RUNTIME "does not provide an export" error.
 */
export type { SignalAmount } from "@retrowatchdog/shared";

/** A role-tagged price point: everything a generic rule needs to fire. */
export interface RolePricePoint {
  source: SourceId;
  /** the source's own price kind — carries the bid flavor (cash/voucher) into reasoning */
  kind: PriceKind;
  condition: Condition;
  /** cosmetic grade (e.g. a CeX Mint SKU); null for ungraded points and references */
  grade: ItemGrade | null;
  price: SignalAmount;
  url: string | null;
  title: string | null;
}

/** reference-role points always carry the sample size behind the baseline */
export type ReferencePoint = RolePricePoint & { sampleSize: number };

/**
 * What an owned copy's owner paid, plus the tier the copy IS (inputs are
 * region-scoped, so rule 5 needs the condition here). Set only by the
 * collection route, so PROFIT is inert for prices/watchlist by construction.
 */
export type AcquiredCopy = SignalAmount & { condition: Condition };

export interface SignalInput {
  region: Region;
  /** lowest buy_store offer per (source, condition): the price you'd actually pay */
  storeOffers: RolePricePoint[];
  /** highest bid per (source, kind, condition): the payout you'd actually take */
  bids: RolePricePoint[];
  /** every buy_listing point that survives the grade gate — each a bargain candidate */
  listings: RolePricePoint[];
  /** market reference per condition (one per condition; multi-reference blending is out of scope) */
  referenceByCondition: Partial<Record<Condition, ReferencePoint>>;
  /** references built from region-'unknown' points: the ONLY permitted
   * cross-group fallback, always labeled in reasoning */
  referenceUnknownRegion?: Partial<Record<Condition, ReferencePoint>>;
  /** Grade of the owned copy (collection route only, whose slice is
   * grade-honest): a bid of this grade skips the grade-asymmetry downgrade.
   * Never set for market-wide slices. */
  guaranteedGrade?: ItemGrade | null;
  /** Rule 5 (PROFIT) fuel; collection route only. */
  acquired?: AcquiredCopy;
  /** an owned copy's condition (collection route only): RISING watches its reference */
  owned?: { condition: Condition };
  /** the slice in the past, for PRICE_DROP, NEW_LOW, BACK_IN_STOCK and RISING */
  history?: SignalHistory;
  /** the buy targets of the watches on this game, for TARGET_HIT */
  targets?: WatchTarget[];
}

/** a watch's buy target and the condition it watches (null = any condition) */
export type WatchTarget = SignalAmount & { condition: Condition | null };

/** The fields the gates read. `PricePointDto` satisfies it; so does a history row. */
export type RoleCandidate = Pick<
  PricePointDto,
  "source" | "kind" | "priceUsd" | "available" | "sampleSize" | "grade"
>;

/**
 * The role this point plays, or null when it is not comparable at all.
 * Runs BEFORE `buildSignalInputs` creates the region's entry, so a point
 * refused here creates none; that is why the gates are split.
 */
export function comparableRole(p: RoleCandidate, sources: Record<string, SourceInfo>): PriceRole | null {
  const role = sources[p.source]?.kindRoles[p.kind];
  // guide prices are informational, never signal fuel
  if (role === undefined || role === "guide") return null;
  // A zero is storable but not comparable: every rule is a ratio and 0 wins
  // all of them. In practice a 0 is a missing amount (e.g. CeX's `?? 0`), not
  // evidence about a market.
  if (p.priceUsd <= 0) return null;
  // Availability gate: a price you cannot buy at is not an offer. Only BUY
  // roles are gated (CeX still buys an out-of-stock box, so its bids stay
  // FLIP fuel). `null` counts as available so legacy rows don't go silent.
  // Measured: 11 of 17 CeX rows for FFTA were out of stock and still drove
  // OVERPRICED_STORE.
  if ((role === "buy_store" || role === "buy_listing") && p.available === false) return null;
  return role;
}

/**
 * The sample a `reference` point stands on, or null (unusable as a baseline).
 * Returns the number, not a boolean, so the caller's assignment narrows.
 */
export function referenceSample(p: RoleCandidate): number | null {
  return p.sampleSize ?? null;
}

/** A damaged item is not a bargain candidate: fair/poor must never feed UNDERPRICED. */
export function gradeAllowsListing(p: RoleCandidate): boolean {
  return p.grade !== "fair" && p.grade !== "poor";
}

/**
 * All three gates composed: the role the engine would use this stored point
 * as, or null. pricing/history.ts uses it so the chart cannot include a price
 * the signals ignore.
 */
export function usableRole(p: RoleCandidate, sources: Record<string, SourceInfo>): PriceRole | null {
  const role = comparableRole(p, sources);
  if (role === null) return null;
  if (role === "reference" && referenceSample(p) === null) return null;
  if (role === "buy_listing" && !gradeAllowsListing(p)) return null;
  return role;
}

/**
 * One SignalInput per region: cross-region comparison is impossible by
 * construction. Roles come from `sources[point.source].kindRoles`; a kind
 * with no declared role is inert. `sources` is required: without it every
 * plugin source would be silently role-less.
 */
export function buildSignalInputs(
  points: PricePointDto[],
  sources: Record<string, SourceInfo>,
  history?: ReadonlyMap<Region, SignalHistory>,
): SignalInput[] {
  const byRegion = new Map<Region, SignalInput>();
  const input = (region: Region): SignalInput => {
    let existing = byRegion.get(region);
    if (!existing) {
      existing = {
        region,
        storeOffers: [],
        bids: [],
        listings: [],
        referenceByCondition: {},
      };
      byRegion.set(region, existing);
    }
    return existing;
  };
  const toRolePoint = (p: PricePointDto): RolePricePoint => ({
    source: p.source,
    kind: p.kind,
    condition: p.condition,
    grade: p.grade ?? null,
    price: { usd: p.priceUsd, original: p.priceOriginal, currency: p.currencyOriginal },
    url: p.url ?? null,
    title: p.listingTitle ?? null,
  });

  for (const p of points) {
    // early gates only: a reference-without-sample or fair/poor listing
    // (refused below) still creates its region's entry
    const role = comparableRole(p, sources);
    if (role === null) continue;
    const target = input(p.region);
    if (role === "buy_store") {
      // lowest offer per (source, condition): conservative for
      // OVERPRICED_STORE, and the price you'd actually pay for UNDERPRICED
      const i = target.storeOffers.findIndex((s) => s.source === p.source && s.condition === p.condition);
      if (i === -1) target.storeOffers.push(toRolePoint(p));
      else if (p.priceUsd < target.storeOffers[i].price.usd) target.storeOffers[i] = toRolePoint(p);
    } else if (role === "bid") {
      // highest bid per (source, kind, condition): cash and voucher stay
      // distinct and can each fire their own FLIP
      const i = target.bids.findIndex(
        (b) => b.source === p.source && b.kind === p.kind && b.condition === p.condition,
      );
      if (i === -1) target.bids.push(toRolePoint(p));
      else if (p.priceUsd > target.bids[i].price.usd) target.bids[i] = toRolePoint(p);
    } else if (role === "reference") {
      const sampleSize = referenceSample(p);
      if (sampleSize === null) continue;
      target.referenceByCondition[p.condition] = { ...toRolePoint(p), sampleSize };
    } else if (role === "buy_listing") {
      if (!gradeAllowsListing(p)) continue;
      target.listings.push(toRolePoint(p));
    }
  }
  // unknown-region references become the labeled fallback for every concrete
  // region: eBay titles very often carry no region keyword at all
  const unknownRegion = byRegion.get("unknown");
  const inputs = [...byRegion.values()];
  if (unknownRegion) {
    for (const input of inputs) {
      if (input.region !== "unknown") {
        input.referenceUnknownRegion = unknownRegion.referenceByCondition;
      }
    }
  }
  if (history !== undefined) {
    for (const input of inputs) {
      const past = history.get(input.region);
      if (past !== undefined) input.history = past;
    }
  }
  return inputs;
}

/** the reference the ladder settled on, plus the fallback rungs it took to get there */
export type ChosenReference = ReferencePoint & {
  viaUnknownCondition: boolean;
  viaUnknownRegion: boolean;
};

/**
 * The reference ladder, shared by every "market median for this copy" reader:
 * exact -> undeclared condition -> undeclared region -> both undeclared.
 * Never any other cross-region comparison.
 *
 * Picks the first rung at or above minSample, not the first present one (a
 * 1-listing median once outranked an 18-listing one). The winning rung's
 * flags travel with it, so a fallback is always labeled and "potential".
 */
export function lookupReference(
  input: SignalInput,
  condition: Condition,
  minSample: number,
): ChosenReference | null {
  const unknownRegionRefs = input.referenceUnknownRegion ?? {};
  const ladder = [
    { m: input.referenceByCondition[condition], uc: false, ur: false },
    { m: input.referenceByCondition.unknown, uc: true, ur: false },
    { m: unknownRegionRefs[condition], uc: false, ur: true },
    { m: unknownRegionRefs.unknown, uc: true, ur: true },
  ];
  const found = ladder.find((c) => c.m !== undefined && c.m.sampleSize >= minSample);
  if (!found?.m) return null;
  return { ...found.m, viaUnknownCondition: found.uc, viaUnknownRegion: found.ur };
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", GBP: "£", EUR: "€", JPY: "¥", CHF: "CHF ", CAD: "CA$", AUD: "A$",
};

export const money = (n: number, currency: string): string =>
  `${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${Number.isInteger(n) ? n : n.toFixed(2)}`;

/**
 * Evidence rule: reasoning quotes amounts in the currency the comparison
 * actually happened in. The math runs on frozen USD (ratios are
 * currency-invariant); same-currency sides quote the verbatim originals
 * ("£45 vs £32"), mixed-currency sides fall back to USD.
 */
const evidencePair = (a: SignalAmount, b: SignalAmount): [string, string] =>
  a.currency === b.currency
    ? [money(a.original, a.currency), money(b.original, b.currency)]
    : [money(a.usd, "USD"), money(b.usd, "USD")];

/**
 * The five generic rules, computed from roles only — never from source ids:
 * 1. UNDERPRICED:      buy_listing or buy_store under reference * factor (a
 *    store only when no same-condition listing is cheaper); plus
 *    the direct pairwise rule (listing < another source's store * factor).
 * 2. OVERPRICED_STORE: buy_store over reference * factor.
 * 3. FLIP:             bid over acquisition proxy * factor, where the proxy is
 *    min(reference, cheapest buy_listing) when both exist, else whichever does.
 * 4. INSUFFICIENT_DATA when a wanted comparison had no usable reference and
 *    no market signal (1–3) fired; a PROFIT does not silence it.
 * 5. PROFIT:           an OWNED copy's best net sell-side reading per
 *    (source, kind) — a bid per instrument, or the reference net of the
 *    source's sellFeeRate — over the paid price * factor, only when the
 *    input carries an acquisition context.
 */
export function computeSignals(
  input: SignalInput,
  cfg: SignalConfig,
  sources: Record<string, SourceInfo>,
): Signal[] {
  const signals: Signal[] = [];
  let sawUnresolvedComparison = false;
  /** a ratio as a percent, one decimal */
  const edge = (ratio: number): number => Math.round(ratio * 1000) / 10;
  /**
   * now ÷ then over time: in the quoted currency when both sides share it, so
   * an FX move on an unchanged price is not read as a change; USD otherwise
   */
  const overTime = (now: SignalAmount, then: SignalAmount): number =>
    now.currency === then.currency && then.original > 0 ? now.original / then.original : now.usd / then.usd;
  /** FLIP and PROFIT under the configured floor are not worth a signal */
  const meetsMinGain = (gainUsd: number): boolean => cfg.minGainUsd === null || gainUsd >= cfg.minGainUsd;

  const srcLabel = (id: SourceId): string => sources[id]?.label ?? id;

  /** pure ladder lookup: no unresolved-flag side effect */
  const ladder = (condition: Condition): ChosenReference | null =>
    lookupReference(input, condition, cfg.minSample);

  /** reference lookup for rules where the reference IS the comparison:
   * failing to find one means that comparison could not run */
  const referenceFor = (condition: Condition): ChosenReference | null => {
    const m = ladder(condition);
    if (m === null) sawUnresolvedComparison = true;
    return m;
  };

  const describeReference = (m: ChosenReference, amountStr: string): string => {
    const notes = [
      m.viaUnknownCondition ? "undeclared condition" : null,
      m.viaUnknownRegion ? "undeclared region" : null,
    ].filter(Boolean);
    return `${kindDisplayLabel(sources, m.source, m.kind)} ${amountStr} (${m.sampleSize} listings${notes.length > 0 ? `, ${notes.join(", ")}` : ""})`;
  };

  // Confidence: caveats never change whether a rule fires, only the label.
  // Any caveat -> "potential"; none -> "high".
  const withConfidence = (
    caveats: string[],
  ): { confidence: SignalConfidence; caveats: string[] } =>
    caveats.length > 0
      ? { confidence: "potential", caveats }
      : { confidence: "high", caveats: [] };

  /** downgrade 1 — the reference median was only reachable via a fallback rung */
  const referenceCaveats = (m: ChosenReference): string[] => [
    ...(m.viaUnknownCondition ? ["market median from listings with undeclared condition"] : []),
    ...(m.viaUnknownRegion ? ["market median from listings with undeclared region"] : []),
  ];

  /** downgrade 2 — the compared point itself sits on undeclared dimensions */
  const dimensionCaveats = (p: RolePricePoint, noun: string): string[] => [
    ...(p.condition === "unknown" ? [`${noun} condition not declared`] : []),
    ...(input.region === "unknown" ? [`${noun} region not declared`] : []),
  ];

  /** downgrade 2 for the owned copy itself (rule 5's compared side) */
  const copyDimensionCaveats = (copy: AcquiredCopy): string[] => [
    ...(copy.condition === "unknown" ? ["copy condition not declared"] : []),
    ...(input.region === "unknown" ? ["copy region not declared"] : []),
  ];

  /** downgrade 3 — grade asymmetry: a graded store price (e.g. Mint SKU) vs a
   * side with no grade guarantee is not like-for-like */
  const storeGradeCaveats = (s: RolePricePoint, otherGrade: ItemGrade | null): string[] =>
    s.grade !== null && s.grade !== otherGrade
      ? [`store price is for a ${s.grade.replaceAll("_", " ")} copy — compared side's grade unverified`]
      : [];

  /** downgrade 3 for FLIP — a graded bid vs an acquisition side that cannot
   * guarantee that grade; guaranteedGrade lifts it */
  const bidGradeCaveats = (b: RolePricePoint, acquisitionGrade: ItemGrade | null): string[] =>
    b.grade !== null && b.grade !== acquisitionGrade && input.guaranteedGrade !== b.grade
      ? [`requires a ${b.grade.replaceAll("_", " ")} copy — listing grades unverified`]
      : [];

  // Rule 2 — OVERPRICED_STORE: don't buy at that store. No url: store/bid
  // signals come from aggregated best offers, not one listing.
  for (const s of input.storeOffers) {
    const m = referenceFor(s.condition);
    if (!m) continue;
    if (s.price.usd > m.price.usd * cfg.overpricedFactor) {
      const [sellStr, refStr] = evidencePair(s.price, m.price);
      signals.push({
        type: "OVERPRICED_STORE",
        reasoning: `${input.region}/${s.condition}: ${kindDisplayLabel(sources, s.source, s.kind)} ${sellStr} vs ${describeReference(m, refStr)} — don't buy at ${srcLabel(s.source)}`,
        source: s.source,
        price: s.price,
        ...withConfidence([
          ...referenceCaveats(m),
          ...dimensionCaveats(s, "store price"),
          ...storeGradeCaveats(s, m.grade),
        ]),
      });
    }
  }

  // Rule 3 — FLIP: buy at the acquisition proxy, sell to the bidder.
  // Proxy = min(reference, cheapest same-condition buy_listing), else
  // whichever exists.
  interface AcquisitionProxy {
    price: SignalAmount;
    source: SourceId;
    /** the grade the acquisition side can guarantee; null for medians */
    grade: ItemGrade | null;
    /** confidence caveats the proxy itself contributes (reference fallbacks) */
    caveats: string[];
    describe: (amountStr: string) => string;
  }

  const acquisitionFor = (condition: Condition): AcquisitionProxy | null => {
    // A comparison resolved through the listing proxy IS resolved: only when
    // neither a reference nor a listing exists is the unresolved flag set.
    const m = ladder(condition);
    const cheapest = input.listings
      .filter((l) => l.condition === condition)
      .reduce<RolePricePoint | null>(
        (best, l) => (best === null || l.price.usd < best.price.usd ? l : best),
        null,
      );
    if (m !== null && (cheapest === null || m.price.usd <= cheapest.price.usd)) {
      return {
        price: m.price,
        source: m.source,
        grade: null, // a median never guarantees any grade
        caveats: referenceCaveats(m),
        describe: (a) => describeReference(m, a),
      };
    }
    if (cheapest !== null) {
      return {
        price: cheapest.price,
        source: cheapest.source,
        grade: cheapest.grade,
        caveats: [],
        describe: (a) =>
          `cheapest ${srcLabel(cheapest.source)} listing "${cheapest.title ?? "listing"}" at ${a}`,
      };
    }
    sawUnresolvedComparison = true;
    return null;
  };

  for (const b of input.bids) {
    const acq = acquisitionFor(b.condition);
    if (!acq) continue;
    // a source can't flip into itself ("buy at X, sell to X")
    if (acq.source === b.source) continue;
    if (b.price.usd > acq.price.usd * cfg.flipFactor && meetsMinGain(b.price.usd - acq.price.usd)) {
      const [bidStr, acqStr] = evidencePair(b.price, acq.price);
      signals.push({
        type: "FLIP",
        reasoning: `${input.region}/${b.condition}: ${kindDisplayLabel(sources, b.source, b.kind)} ${bidStr} vs ${acq.describe(acqStr)} — buy at ${srcLabel(acq.source)}, sell to ${srcLabel(b.source)}`,
        // UIs read buySource/sellSource, not the type
        buySource: acq.source,
        // the entry cost; the bid is already quoted in the reasoning
        price: acq.price,
        sellSource: b.source,
        edgePct: edge(b.price.usd / acq.price.usd - 1),
        ...withConfidence([
          ...acq.caveats,
          ...dimensionCaveats(b, "bid"),
          ...bidGradeCaveats(b, acq.grade),
        ]),
      });
    }
  }

  // Rule 1 — UNDERPRICED vs reference: any purchasable price under the market.
  // A listing that fires here gets no second badge from the pairwise rule
  // (tracked by object identity).
  const firedVsReference = new Set<RolePricePoint>();
  for (const l of input.listings) {
    // pure lookup: listings never "want" a comparison (rule 4)
    const m = ladder(l.condition);
    if (!m) continue;
    if (l.price.usd < m.price.usd * cfg.underpricedFactor) {
      firedVsReference.add(l);
      const [priceStr, refStr] = evidencePair(l.price, m.price);
      signals.push({
        type: "UNDERPRICED",
        reasoning: `${input.region}/${l.condition}: "${l.title ?? `${srcLabel(l.source)} listing`}" at ${priceStr} vs ${describeReference(m, refStr)} — bargain candidate`,
        url: l.url ?? undefined,
        source: l.source,
        price: l.price,
        edgePct: edge(1 - l.price.usd / m.price.usd),
        ...withConfidence([...referenceCaveats(m), ...dimensionCaveats(l, "listing")]),
      });
    }
  }
  // ...including a STORE selling under the market. Not when a listing of the
  // same condition (and the store's grade, if it has one) is cheaper: then the
  // store is not below the market, the median is (a thin, inflated one put
  // "buy at CeX £42" beside a £31.90 complete copy on eBay).
  const undercutByListing = (s: RolePricePoint): boolean =>
    input.listings.some(
      (l) =>
        l.source !== s.source &&
        l.condition === s.condition &&
        (s.grade === null || l.grade === s.grade) &&
        l.price.usd < s.price.usd,
    );
  for (const s of input.storeOffers) {
    const m = referenceFor(s.condition);
    if (!m) continue;
    if (s.price.usd < m.price.usd * cfg.underpricedFactor && !undercutByListing(s)) {
      const [priceStr, refStr] = evidencePair(s.price, m.price);
      signals.push({
        type: "UNDERPRICED",
        reasoning: `${input.region}/${s.condition}: ${kindDisplayLabel(sources, s.source, s.kind)} ${priceStr} vs ${describeReference(m, refStr)} — below market, buy at ${srcLabel(s.source)}`,
        url: s.url ?? undefined,
        source: s.source,
        price: s.price,
        edgePct: edge(1 - s.price.usd / m.price.usd),
        ...withConfidence([
          ...referenceCaveats(m),
          ...dimensionCaveats(s, "store price"),
          ...storeGradeCaveats(s, m.grade),
        ]),
      });
    }
  }
  // Rule 1 pairwise — a listing undercutting another source's store price
  // (works when no reference exists). Condition matching is STRICT.
  for (const l of input.listings) {
    if (firedVsReference.has(l)) continue; // already badged vs the reference
    for (const s of input.storeOffers) {
      if (s.source === l.source) continue; // a store can't undercut itself
      if (s.condition !== l.condition) continue;
      if (l.price.usd < s.price.usd * cfg.crossStoreFactor) {
        const [priceStr, storeStr] = evidencePair(l.price, s.price);
        signals.push({
          type: "UNDERPRICED",
          reasoning: `${input.region}/${l.condition}: "${l.title ?? `${srcLabel(l.source)} listing`}" at ${priceStr} vs ${kindDisplayLabel(sources, s.source, s.kind)} ${storeStr} — cheaper than buying at ${srcLabel(s.source)}`,
          url: l.url ?? undefined,
          source: l.source,
          price: l.price,
          edgePct: edge(1 - l.price.usd / s.price.usd),
          ...withConfidence([
            ...dimensionCaveats(l, "listing"),
            ...storeGradeCaveats(s, l.grade),
          ]),
        });
      }
    }
  }

  // Rule 6 — TARGET_HIT: a purchasable price at or under the watch's target.
  // Always high: the user set the bar, so no fallback is involved. Compared in
  // the quoted currency when it matches the target's, in USD otherwise.
  const targets = (input.targets ?? []).filter((t) => t.usd > 0);
  if (targets.length > 0) {
    const atOrUnder = (price: SignalAmount, target: SignalAmount): boolean =>
      price.currency === target.currency ? price.original <= target.original : price.usd <= target.usd;
    const hit = (p: RolePricePoint, label: string): void => {
      // a watch on cib never fires for a loose cart; among the watches that
      // admit this condition, the strictest target decides
      const target = targets
        .filter((t) => t.condition === null || t.condition === p.condition)
        .sort((a, b) => a.usd - b.usd)[0];
      if (target === undefined || !atOrUnder(p.price, target)) return;
      const [priceStr, targetStr] = evidencePair(p.price, target);
      signals.push({
        type: "TARGET_HIT",
        reasoning: `${input.region}/${p.condition}: ${label} ${priceStr} is at or under your target ${targetStr}`,
        url: p.url ?? undefined,
        source: p.source,
        price: p.price,
        edgePct: edge(1 - p.price.usd / target.usd),
        ...withConfidence([]),
      });
    };
    for (const l of input.listings) hit(l, `"${l.title ?? `${srcLabel(l.source)} listing`}" at`);
    for (const st of input.storeOffers) hit(st, kindDisplayLabel(sources, st.source, st.kind));
  }

  // Rule 7 — PRICE_DROP: a store price or a market median fell by
  // cfg.priceDropPct against the same source, condition (and kind) as of
  // cfg.priceDropDays ago. Exact slices only: no fallback rung on either end.
  const past = input.history?.dropAgo;
  if (past !== undefined) {
    const fell = (now: SignalAmount, then: SignalAmount): boolean =>
      then.usd > 0 && overTime(now, then) <= 1 - cfg.priceDropPct / 100;
    const drop = (now: RolePricePoint, then: RolePricePoint, label: string): void => {
      if (!fell(now.price, then.price)) return;
      const [nowStr, thenStr] = evidencePair(now.price, then.price);
      signals.push({
        type: "PRICE_DROP",
        // the batch compared against can be older than the setting when refreshes were rare
        reasoning: `${input.region}/${now.condition}: ${label} ${nowStr}, down from ${thenStr} ${input.history?.dropAgeDays[now.source] ?? cfg.priceDropDays} days ago`,
        url: now.url ?? undefined,
        source: now.source,
        price: now.price,
        edgePct: edge(1 - overTime(now.price, then.price)),
        ...withConfidence([]),
      });
    };
    for (const s of input.storeOffers) {
      const then = past.storeOffers.find(
        (o) => o.source === s.source && o.condition === s.condition && o.grade === s.grade,
      );
      if (then !== undefined) drop(s, then, kindDisplayLabel(sources, s.source, s.kind));
    }
    for (const [condition, now] of Object.entries(input.referenceByCondition)) {
      const then = past.referenceByCondition[condition as Condition];
      if (now === undefined || then === undefined) continue;
      if (then.source !== now.source || then.kind !== now.kind) continue;
      if (now.sampleSize < cfg.minSample || then.sampleSize < cfg.minSample) continue;
      drop(now, then, kindDisplayLabel(sources, now.source, now.kind));
    }
  }

  // Rule 8 — NEW_LOW: today's cheapest purchasable price per source and
  // condition is under the lowest of the last cfg.newLowDays. A month of
  // history makes it high; less is only potential.
  const lowest = input.history?.lowest;
  if (lowest !== undefined) {
    const cheapest = new Map<string, { point: RolePricePoint; label: string }>();
    const consider = (p: RolePricePoint, label: string): void => {
      const key = `${p.source}|${p.condition}`;
      const current = cheapest.get(key);
      if (current === undefined || p.price.usd < current.point.price.usd) cheapest.set(key, { point: p, label });
    };
    for (const l of input.listings) consider(l, `"${l.title ?? `${srcLabel(l.source)} listing`}" at`);
    for (const st of input.storeOffers) consider(st, kindDisplayLabel(sources, st.source, st.kind));
    for (const [key, { point, label }] of cheapest) {
      const low = lowest[key];
      if (low === undefined || low.usd <= 0) continue;
      // the quoted amount decides when the window kept one currency: a frozen
      // USD twin moves with FX for an unchanged price
      const quoted = low.original !== null && low.currency === point.price.currency;
      if (quoted ? point.price.original >= low.original! : point.price.usd >= low.usd) continue;
      const lowAmount: SignalAmount = quoted
        ? { usd: low.usd, original: low.original!, currency: low.currency }
        : { usd: low.usd, original: low.usd, currency: "USD" };
      const [nowStr, lowStr] = evidencePair(point.price, lowAmount);
      signals.push({
        type: "NEW_LOW",
        reasoning: `${input.region}/${point.condition}: ${label} ${nowStr} is the lowest in ${cfg.newLowDays} days (was ${lowStr})`,
        url: point.url ?? undefined,
        source: point.source,
        price: point.price,
        edgePct: edge(quoted ? 1 - point.price.original / low.original! : 1 - point.price.usd / low.usd),
        ...withConfidence(low.daysCovered >= 30 ? [] : ["less than 30 days of history"]),
      });
    }
  }

  // Rule 9 — BACK_IN_STOCK: a store box that was out of stock in the batch
  // before this one is on offer now (today's out-of-stock boxes never reach
  // storeOffers). Keyed by grade: a Mint SKU is its own box.
  const wasAvailable = input.history?.previousAvailability;
  if (wasAvailable !== undefined) {
    for (const st of input.storeOffers) {
      if (wasAvailable[`${st.source}|${st.condition}|${st.grade ?? ""}`] !== false) continue;
      const [priceStr] = evidencePair(st.price, st.price);
      signals.push({
        type: "BACK_IN_STOCK",
        reasoning: `${input.region}/${st.condition}: ${srcLabel(st.source)} has it back in stock at ${priceStr}`,
        url: st.url ?? undefined,
        source: st.source,
        price: st.price,
        ...withConfidence([]),
      });
    }
  }

  // Rule 10 — RISING: an owned copy's market reference rose by cfg.risingPct
  // over cfg.risingDays. Both ends must sit on the same ladder rung (same
  // source and fallbacks), and a fallback rung is only potential.
  const risingPast = input.history?.risingAgo;
  if (input.owned !== undefined && risingPast !== undefined) {
    const condition = input.owned.condition;
    const now = ladder(condition);
    const then = lookupReference(risingPast, condition, cfg.minSample);
    const sameRung =
      now !== null &&
      then !== null &&
      now.source === then.source &&
      now.kind === then.kind &&
      now.viaUnknownCondition === then.viaUnknownCondition &&
      now.viaUnknownRegion === then.viaUnknownRegion;
    if (sameRung && overTime(now.price, then.price) >= 1 + cfg.risingPct / 100) {
      const [nowStr, thenStr] = evidencePair(now.price, then.price);
      signals.push({
        type: "RISING",
        reasoning: `${input.region}/${condition}: ${describeReference(now, nowStr)}, up from ${thenStr} ${cfg.risingDays} days ago`,
        source: now.source,
        price: now.price,
        edgePct: edge(overTime(now.price, then.price) - 1),
        ...withConfidence(referenceCaveats(now)),
      });
    }
  }

  // Rule 5 — PROFIT: an OWNED copy's sell-side reading beats what was paid.
  // Never raises the unresolved flag. Readings for the copy's own tier:
  //   - a bid is what the source PAYS you, already net of any fee;
  //   - the reference is what copies are LISTED for, so it is netted by the
  //     source's sellFeeRate and is never more than potential.
  // One signal per (source, kind): a voucher gain must not hide the cash gain.
  const acquired = input.acquired;
  if (acquired !== undefined && acquired.usd > 0) {
    interface SellReading {
      source: SourceId;
      kind: PriceKind;
      net: SignalAmount;
      reasoning: string;
      caveats: string[];
    }
    const bestByInstrument = new Map<string, SellReading>();
    const consider = (reading: SellReading): void => {
      const key = `${reading.source} ${reading.kind}`;
      const current = bestByInstrument.get(key);
      if (current === undefined || reading.net.usd > current.net.usd) bestByInstrument.set(key, reading);
    };
    for (const b of input.bids) {
      if (b.condition !== acquired.condition) continue;
      const [bidStr, paidStr] = evidencePair(b.price, acquired);
      consider({
        source: b.source,
        kind: b.kind,
        net: b.price,
        reasoning: `${input.region}/${b.condition}: ${kindDisplayLabel(sources, b.source, b.kind)} ${bidStr} vs paid ${paidStr} — trade in at ${srcLabel(b.source)}`,
        // the owned copy is the acquisition side: its grade is the guarantee
        caveats: [...dimensionCaveats(b, "bid"), ...bidGradeCaveats(b, input.guaranteedGrade ?? null)],
      });
    }
    const m = ladder(acquired.condition);
    if (m !== null) {
      const feeRate = sources[m.source]?.sellFeeRate ?? 0;
      // netted in both spaces so the evidence quotes the after-fees figure
      const net: SignalAmount = {
        usd: m.price.usd * (1 - feeRate),
        original: m.price.original * (1 - feeRate),
        currency: m.price.currency,
      };
      const [grossStr, paidStr] = evidencePair(m.price, acquired);
      const [netStr] = evidencePair(net, acquired);
      const netClause = feeRate > 0 ? ` → ≈${netStr} after fees` : "";
      consider({
        source: m.source,
        kind: m.kind,
        net,
        reasoning: `${input.region}/${acquired.condition}: ${describeReference(m, grossStr)}${netClause} vs paid ${paidStr} — sell on ${srcLabel(m.source)}`,
        caveats: [
          PROFIT_FEE_CAVEAT,
          ...referenceCaveats(m),
          ...copyDimensionCaveats(acquired),
        ],
      });
    }
    for (const reading of bestByInstrument.values()) {
      if (reading.net.usd > acquired.usd * cfg.profitFactor && meetsMinGain(reading.net.usd - acquired.usd)) {
        signals.push({
          type: "PROFIT",
          reasoning: reading.reasoning,
          // UIs read sellSource/sellKind, not the type
          sellSource: reading.source,
          sellKind: reading.kind,
          price: reading.net,
          gainUsd: Math.round((reading.net.usd - acquired.usd) * 100) / 100,
          edgePct: edge(reading.net.usd / acquired.usd - 1),
          ...withConfidence(reading.caveats),
        });
      }
    }
  }

  // Rule 4 — INSUFFICIENT_DATA: only store offers and bids "want" a
  // comparison. Fires when one could not run and no MARKET signal survived
  // the configuration (one that did proves the market was comparable). Only
  // the market comparisons count: PROFIT reads the paid price, TARGET_HIT the
  // user's bar, and the time-based types the source's own past.
  const gated = applyConfigGates(signals, cfg);
  const wantedComparison = input.storeOffers.length > 0 || input.bids.length > 0;
  const noMarketSignalFired = !gated.some((s) => MARKET_PROOF.has(s.type));
  if (noMarketSignalFired && wantedComparison && sawUnresolvedComparison) {
    gated.push({
      type: "INSUFFICIENT_DATA",
      reasoning: `${input.region}: not enough reference listings to compare against (need ${cfg.minSample}+ per group)`,
    });
  }
  return gated;
}

/**
 * The configuration's last word: a switched-off type never fires (INSUFFICIENT_DATA
 * is not a type the user turns off), and a signal that would send the user to,
 * or rest on a price from, an excluded source is dropped. Excluded sources still
 * anchor references: this filters what is raised, not what is compared.
 */
/** the signals that prove a market comparison ran */
const MARKET_PROOF: ReadonlySet<Signal["type"]> = new Set<Signal["type"]>(["UNDERPRICED", "OVERPRICED_STORE", "FLIP"]);

function applyConfigGates(signals: Signal[], cfg: SignalConfig): Signal[] {
  const enabled = new Set(cfg.enabledTypes);
  const excluded = new Set<string>(cfg.excludedSources);
  return signals.filter((s) => {
    if (s.type === "INSUFFICIENT_DATA") return true;
    if (!enabled.has(s.type)) return false;
    return ![s.source, s.buySource, s.sellSource].some((id) => id !== undefined && excluded.has(id));
  });
}
