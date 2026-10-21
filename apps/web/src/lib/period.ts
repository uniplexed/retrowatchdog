import { useSyncExternalStore } from "react";

/**
 * The one period every history chart and the dashboard's delta are drawn
 * over, chosen once and shared, remembered in this browser. Days are UTC, as
 * the API counts them; "all" is the API's two-year ceiling.
 */
export type PeriodPreset = "7d" | "30d" | "90d" | "1y" | "all" | "custom";
export interface Period {
  preset: PeriodPreset;
  /** custom only, YYYY-MM-DD */
  from?: string;
  to?: string;
}
export interface Window {
  from: string;
  to: string;
}

const KEY = "period";
const DEFAULT: Period = { preset: "90d" };
const DAYS: Record<Exclude<PeriodPreset, "custom">, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: 730 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PERIOD_OPTIONS: Array<{ value: PeriodPreset; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** how a change over the period reads: "in 30 days", "since 2026-01-01" */
export function periodPhrase(period: Period, today: Date = new Date()): string {
  if (period.preset === "custom" || period.preset === "all") return `since ${resolvePeriod(period, today).from}`;
  return `in ${PERIOD_OPTIONS.find((o) => o.value === period.preset)!.label}`;
}

/** the [from, to] the API is asked for, both inclusive */
export function resolvePeriod(period: Period, today: Date = new Date()): Window {
  const to = dayOf(today);
  if (period.preset === "custom") {
    if (period.from !== undefined && period.to !== undefined && DATE.test(period.from) && DATE.test(period.to)) {
      return period.from <= period.to ? { from: period.from, to: period.to } : { from: period.to, to: period.from };
    }
    return resolvePeriod(DEFAULT, today);
  }
  return { from: dayOf(new Date(today.getTime() - (DAYS[period.preset] - 1) * 86_400_000)), to };
}

const isPeriod = (v: unknown): v is Period =>
  typeof v === "object" && v !== null && PERIOD_OPTIONS.some((o) => o.value === (v as Period).preset);

/** localStorage can throw (private mode, blocked storage): every access is guarded */
export function loadPeriod(): Period {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return isPeriod(parsed) ? { preset: parsed.preset, ...(parsed.preset === "custom" ? { from: parsed.from, to: parsed.to } : {}) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

let current: Period | null = null;
const listeners = new Set<() => void>();

export function setPeriod(period: Period): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(period));
  } catch {
    // storage unavailable: the choice holds for this session
  }
  current = period;
  for (const listener of listeners) listener();
}

const read = (): Period => (current ??= loadPeriod());
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function usePeriod(): Period {
  return useSyncExternalStore(subscribe, read, () => DEFAULT);
}

export function resetPeriodForTests(): void {
  current = null;
  listeners.clear();
}
