import { useSyncExternalStore } from "react";
import type { FxMode, SupportedCurrency } from "@retrowatchdog/shared";
import { SUPPORTED_CURRENCIES } from "@retrowatchdog/shared";
import { getFxRate } from "../api/client.js";

/**
 * App-wide display-currency store. Every amount the API serves is USD;
 * `formatMoney` is the ONE render-time conversion, `formatOriginal` never
 * converts. With /api/fx down, amounts show in USD with a visible note.
 */
export interface MoneyState {
  /** the user's selected display currency */
  currency: SupportedCurrency;
  /** USD->currency rate; null while loading or when the FX fetch failed */
  rate: number | null;
  /** when the auto rate was fetched; null for manual overrides */
  fetchedAt: string | null;
  mode: FxMode | null;
  /** /api/fx failed: amounts render in USD with a visible note */
  fxFailed: boolean;
}

const USD_STATE: MoneyState = { currency: "USD", rate: 1, fetchedAt: null, mode: null, fxFailed: false };

/** rates older than this get a "(rate from <date>)" note in the header */
export const RATE_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

let state: MoneyState = USD_STATE;
const listeners = new Set<() => void>();
// guards against out-of-order /api/fx responses when switching quickly
let fetchSeq = 0;

function setState(next: MoneyState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeMoney(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMoneySnapshot(): MoneyState {
  return state;
}

/** React binding: a subscribing component re-renders on any currency/rate change. */
export function useMoney(): MoneyState {
  return useSyncExternalStore(subscribeMoney, getMoneySnapshot);
}

// one cached formatter per currency code
const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let formatter = formatters.get(currency);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

/** the verbatim amount a source or the user actually quoted, beside its USD twin */
export interface OriginalAmount {
  amount: number;
  currency: string;
}

/**
 * THE money renderer: a USD amount in the display currency (plain USD while
 * the rate is loading or FX is down). When the display currency IS the
 * `original`'s, the quoted original wins — a round trip turns CeX's £177
 * into £176.37, a price nobody quoted.
 */
export function formatMoney(usd: number, original?: OriginalAmount | null): string {
  if (original != null && original.currency === state.currency) {
    return formatOriginal(original.amount, original.currency);
  }
  const converted = state.currency !== "USD" && state.rate !== null;
  const currency = converted ? state.currency : "USD";
  const amount = converted ? usd * (state.rate as number) : usd;
  return formatterFor(currency).format(amount);
}

/**
 * A verbatim original amount in its own currency — evidence, never converted
 * ("paid €25.00" stays euros whatever the display currency is).
 */
export function formatOriginal(amount: number, currency: string): string {
  try {
    return formatterFor(currency).format(amount);
  } catch {
    // unknown ISO code from a source: show the number and the code as-is
    const plain = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${plain.format(amount)} ${currency}`;
  }
}

/** Header note for the current FX state; null when nothing needs saying. */
export function fxNote(s: MoneyState = state): string | null {
  if (s.currency === "USD") return null;
  // "converted": quoted originals still show exactly, needing no rate
  if (s.fxFailed) return "FX unavailable — converted prices shown in USD";
  if (s.mode === "manual") return "manual rate";
  if (s.fetchedAt !== null && Date.now() - new Date(s.fetchedAt).getTime() > RATE_STALE_AFTER_MS) {
    return `rate from ${new Date(s.fetchedAt).toLocaleDateString()}`;
  }
  return null;
}

function isSupported(value: string | null): value is SupportedCurrency {
  return value !== null && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** Boot: restore the persisted display currency (default USD) and fetch its rate. */
export async function loadDisplayCurrency(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem("displayCurrency");
  } catch {
    // storage unavailable: default USD
  }
  await applyCurrency(isSupported(stored) ? stored : "USD");
}

export async function setDisplayCurrency(currency: SupportedCurrency): Promise<void> {
  try {
    window.localStorage.setItem("displayCurrency", currency);
  } catch {
    // persistence is a convenience; the in-memory switch still works
  }
  await applyCurrency(currency);
}

/** Re-fetch the current currency's rate (e.g. after an FX settings change). */
export async function refreshRate(): Promise<void> {
  await applyCurrency(state.currency);
}

async function applyCurrency(currency: SupportedCurrency): Promise<void> {
  const seq = ++fetchSeq;
  if (currency === "USD") {
    setState(USD_STATE);
    return;
  }
  if (state.currency !== currency) {
    // optimistic: amounts stay USD until the rate lands
    setState({ currency, rate: null, fetchedAt: null, mode: null, fxFailed: false });
  }
  try {
    const res = await getFxRate(currency);
    if (seq !== fetchSeq) return; // a later switch won the race
    setState({ currency, rate: res.rate, fetchedAt: res.fetchedAt, mode: res.mode, fxFailed: false });
  } catch {
    if (seq !== fetchSeq) return;
    setState({ currency, rate: null, fetchedAt: null, mode: null, fxFailed: true });
  }
}

/** Default currency for a new paid/sold amount: the last picked, initially GBP. */
export function loadLastPaidCurrency(): SupportedCurrency {
  try {
    const stored = window.localStorage.getItem("lastPaidCurrency");
    if (isSupported(stored)) return stored;
  } catch {
    // storage unavailable: fall through to the default
  }
  return "GBP";
}

export function saveLastPaidCurrency(currency: SupportedCurrency): void {
  try {
    window.localStorage.setItem("lastPaidCurrency", currency);
  } catch {
    // convenience only
  }
}

/** Test hook: back to the USD boot state (localStorage untouched). */
export function resetMoneyForTests(): void {
  fetchSeq++;
  setState(USD_STATE);
}
