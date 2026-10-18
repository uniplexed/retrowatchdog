import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_ENABLED_CURRENCIES, type CurrencySettingsResponse, type SupportedCurrency } from "@retrowatchdog/shared";

// The currencies the menus offer, shared by every menu; loaded once, defaults until then.
let enabled: SupportedCurrency[] = [...DEFAULT_ENABLED_CURRENCIES];
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: SupportedCurrency[]): void {
  enabled = next;
  for (const l of listeners) l();
}

function load(): void {
  loading ??= fetch("/api/settings/currencies")
    .then((r) => (r.ok ? (r.json() as Promise<CurrencySettingsResponse>) : null))
    .then((body) => {
      if (body !== null && Array.isArray(body.enabled)) set(body.enabled);
    })
    // the defaults stay: a menu must never come up empty
    .catch(() => undefined);
}

/** React binding: the enabled currencies, USD first. */
export function useEnabledCurrencies(): SupportedCurrency[] {
  useEffect(load, []);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => enabled,
  );
}

/** Saves the list; the answer (USD added, list order) is what every menu shows. */
export async function saveEnabledCurrencies(next: SupportedCurrency[]): Promise<void> {
  const res = await fetch("/api/settings/currencies", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: next }),
  });
  if (!res.ok) throw new Error(`Could not save currencies (HTTP ${res.status})`);
  set(((await res.json()) as CurrencySettingsResponse).enabled);
}

/** A menu's options: the enabled ones, plus the value it already holds when that one was switched off. */
export function offered(list: readonly SupportedCurrency[], current?: string | null): SupportedCurrency[] {
  return current && !list.includes(current as SupportedCurrency) ? [...list, current as SupportedCurrency] : [...list];
}

/** Test hook: back to the defaults, next use reloads. */
export function resetCurrenciesForTests(): void {
  enabled = [...DEFAULT_ENABLED_CURRENCIES];
  loading = null;
}
