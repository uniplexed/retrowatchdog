import { eq } from "drizzle-orm";
import { DEFAULT_ENABLED_CURRENCIES, SUPPORTED_CURRENCIES, type SupportedCurrency } from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";

/** app_settings key holding the currencies the menus offer (a SupportedCurrency[] JSON array) */
export const ENABLED_CURRENCIES_KEY = "enabled_currencies";

/** USD first, then the list order of SUPPORTED_CURRENCIES; unknown codes dropped */
const normalise = (codes: readonly string[]): SupportedCurrency[] =>
  SUPPORTED_CURRENCIES.filter((c) => c === "USD" || codes.includes(c));

/** Only which currencies are OFFERED: stored amounts in any supported currency stay valid. */
export async function loadEnabledCurrencies(db: Db): Promise<SupportedCurrency[]> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, ENABLED_CURRENCIES_KEY));
  const stored = Array.isArray(row?.value) ? (row.value as unknown[]).filter((v): v is string => typeof v === "string") : null;
  return normalise(stored ?? DEFAULT_ENABLED_CURRENCIES);
}

export async function saveEnabledCurrencies(db: Db, codes: readonly SupportedCurrency[]): Promise<SupportedCurrency[]> {
  const enabled = normalise(codes);
  const updatedAt = new Date();
  await db
    .insert(appSettings)
    .values({ key: ENABLED_CURRENCIES_KEY, value: enabled, updatedAt })
    .onConflictDoUpdate({ target: [appSettings.key], set: { value: enabled, updatedAt } });
  return enabled;
}
