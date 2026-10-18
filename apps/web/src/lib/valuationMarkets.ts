import type { CountryCode, ValuationMarkets } from "@retrowatchdog/shared";
import { COUNTRY_CODES, COUNTRY_LABEL, DEFAULT_VALUATION_MARKETS } from "@retrowatchdog/shared";

/**
 * Which markets may VALUE the user's copies (Settings → Valuation markets):
 * the home country, and whether foreign markets count too. Client-side.
 * Not the server-side Markets setting, which decides what is QUERIED.
 */
const COUNTRY_KEY = "valuationCountry";
const INCLUDE_FOREIGN_KEY = "valuationIncludeForeign";

function isCountryCode(value: string | null): value is CountryCode {
  return value !== null && (COUNTRY_CODES as readonly string[]).includes(value);
}

export function loadValuationMarkets(): ValuationMarkets {
  try {
    const country = window.localStorage.getItem(COUNTRY_KEY);
    const includeForeign = window.localStorage.getItem(INCLUDE_FOREIGN_KEY);
    return {
      country: isCountryCode(country) ? country : DEFAULT_VALUATION_MARKETS.country,
      // anything but the two strings save writes is the default
      includeForeign:
        includeForeign === "true"
          ? true
          : includeForeign === "false"
            ? false
            : DEFAULT_VALUATION_MARKETS.includeForeign,
    };
  } catch {
    // storage unavailable: fall through to the default
    return DEFAULT_VALUATION_MARKETS;
  }
}

/** How a total names the markets it was computed over (a foreign-inclusive sum mixes countries). */
export function valuationMarketsLabel(markets: ValuationMarkets): string {
  return markets.includeForeign ? "all countries" : COUNTRY_LABEL[markets.country];
}

export function saveValuationMarkets(markets: ValuationMarkets): void {
  try {
    window.localStorage.setItem(COUNTRY_KEY, markets.country);
    window.localStorage.setItem(INCLUDE_FOREIGN_KEY, String(markets.includeForeign));
  } catch {
    // persistence is a convenience; the in-memory choice still applies
  }
}
