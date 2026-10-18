// undici's fetch, not Node's builtin — only this one is MockAgent-interceptable
import { fetch } from "undici";
import { inArray } from "drizzle-orm";
import type { FxMode } from "@retrowatchdog/shared";
import { config } from "../config.js";
import type { Db } from "../db/index.js";
import { fxOverrides } from "../db/schema.js";

const CACHE_MS = 24 * 3_600_000;

interface CachedRate {
  rate: number;
  at: number;
}

// keyed "FROM->TO"; each direction is fetched and cached independently
const cache = new Map<string, CachedRate>();

export function resetFxCacheForTests(): void {
  cache.clear();
}

async function fetchRate(from: string, to: string): Promise<number> {
  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.ADAPTER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fx: HTTP ${res.status} for ${from}->${to}`);
  const body = (await res.json()) as { rates?: Record<string, number> };
  const rate = body.rates?.[to];
  if (typeof rate !== "number") throw new Error(`fx: no ${to} rate for ${from}`);
  return rate;
}

async function cachedRate(from: string, to: string): Promise<CachedRate> {
  const key = `${from}->${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const rate = await fetchRate(from, to);
  const entry = { rate, at: Date.now() };
  cache.set(key, entry);
  return entry;
}

/**
 * Manual fx_overrides by currency. manual_rate is USD->currency (the direction
 * the settings UI edits). db=null (unit tests) skips the lookup.
 */
async function manualOverrides(db: Db | null, currencies: string[]): Promise<Map<string, number>> {
  if (db === null || currencies.length === 0) return new Map();
  const rows = await db
    .select()
    .from(fxOverrides)
    .where(inArray(fxOverrides.currency, currencies));
  const out = new Map<string, number>();
  for (const row of rows) {
    const rate = row.manualRate === null ? null : Number(row.manualRate);
    if (row.mode === "manual" && rate !== null && rate > 0) out.set(row.currency, rate);
  }
  return out;
}

/**
 * X->USD rates for the write-time freezing path. A manual override wins
 * (inverted here). Amounts already frozen in USD are never recomputed.
 */
export async function ratesToUsd(db: Db | null, currencies: Iterable<string>): Promise<Map<string, number>> {
  const wanted = [...new Set(currencies)];
  const overrides = await manualOverrides(db, wanted.filter((c) => c !== "USD"));
  const out = new Map<string, number>();
  for (const currency of wanted) {
    if (currency === "USD") {
      out.set(currency, 1);
      continue;
    }
    const manual = overrides.get(currency);
    if (manual !== undefined) {
      out.set(currency, 1 / manual);
      continue;
    }
    out.set(currency, (await cachedRate(currency, "USD")).rate);
  }
  return out;
}

export interface DisplayRate {
  rate: number;
  /** null when the rate is a manual override — nothing was fetched */
  fetchedAt: Date | null;
  mode: FxMode;
}

/** USD->X display rate (/api/fx, header selector). Manual overrides win. */
export async function rateFromUsd(db: Db | null, to: string): Promise<DisplayRate> {
  if (to === "USD") return { rate: 1, fetchedAt: new Date(), mode: "auto" };
  const manual = (await manualOverrides(db, [to])).get(to);
  if (manual !== undefined) return { rate: manual, fetchedAt: null, mode: "manual" };
  const { rate, at } = await cachedRate("USD", to);
  return { rate, fetchedAt: new Date(at), mode: "auto" };
}

/** The Frankfurter USD->X rate ignoring overrides — the settings screen's greyed "auto:" reference. */
export async function autoRateFromUsd(to: string): Promise<{ rate: number; fetchedAt: Date }> {
  const { rate, at } = await cachedRate("USD", to);
  return { rate, fetchedAt: new Date(at) };
}
