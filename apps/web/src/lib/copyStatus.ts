import type { CopyStatus, SupportedCurrency, UpdateCopyInput } from "@retrowatchdog/shared";
import { SUPPORTED_CURRENCIES } from "@retrowatchdog/shared";
import { loadLastPaidCurrency } from "./money.js";

/** today as the API's YYYY-MM-DD date, the stamp the sold/returned flow uses */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** a status change's PATCH fragment: the status is always in it */
export type StatusPatch = UpdateCopyInput & { status: CopyStatus };

/**
 * Second half of the sold-flow prompt: the ONE currency covering the sale.
 * Not persisted here; it becomes the default only once the sale is saved.
 */
export function promptSoldCurrency(): SupportedCurrency | null {
  const raw = window.prompt(
    `Currency? (${SUPPORTED_CURRENCIES.join(", ")})`,
    loadLastPaidCurrency(),
  );
  if (raw === null) return null;
  const candidate = raw.trim().toUpperCase();
  if ((SUPPORTED_CURRENCIES as readonly string[]).includes(candidate)) {
    return candidate as SupportedCurrency;
  }
  window.alert("Invalid currency");
  return null;
}

/**
 * The PATCH fragment for a status change: sold prompts for amount and
 * currency, sold/returned stamp today. null when a prompt was cancelled or
 * invalid; the caller keeps the old status.
 */
export function statusPatchFor(status: CopyStatus): StatusPatch | null {
  if (status === "sold") {
    const price = window.prompt("Sold for? (amount)");
    if (price === null) return null; // cancelled
    if (price.trim() === "" || !Number.isFinite(Number(price))) {
      window.alert("Invalid price");
      return null;
    }
    const soldCurrency = promptSoldCurrency();
    if (soldCurrency === null) return null;
    return { status, soldAt: today(), soldPriceOriginal: Number(price), soldCurrency };
  }
  if (status === "returned") return { status, returnedAt: today() };
  return { status };
}
