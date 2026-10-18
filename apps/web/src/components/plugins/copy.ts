import type { PluginDto, PriceRole } from "@retrowatchdog/shared";
import { DRIFT_FIELDS } from "@retrowatchdog/shared";

/**
 * Every sentence the Plugins panel can say about a plugin's STATE, kept apart
 * from markup so contradicting sentences can be caught without a DOM.
 */

/** The role a person reads, beside the token the API's refusals name. */
export const ROLE_SHORT: Record<PriceRole, string> = {
  buy_listing: "buy price",
  buy_store: "shop price",
  bid: "pays you",
  reference: "baseline",
  guide: "reference only",
};

/**
 * What granting a role lets the app DO — the signal engine reads roles alone,
 * never source ids. Printed once per card.
 */
export const ROLE_MEANING: Record<PriceRole, string> = {
  buy_listing: "a copy for sale. Can trigger a bargain bark (signal).",
  buy_store: "a shop's sale price. Can trigger bargain and overpriced barks (signals).",
  bid: "what a shop pays you. Used for flip barks (signals) and profit.",
  reference: "the price every other price is compared to.",
  guide: "shown only. Triggers no barks (signals).",
};

/**
 * What each drifted field MEANS, so the panel never prints a field name.
 * Exhaustive over `DRIFT_FIELDS`: a new field without wording fails to compile.
 */
const DRIFT_PHRASE: Record<(typeof DRIFT_FIELDS)[number], string> = {
  kind: "fetch type",
  kindRoles: "price roles",
  kindLabels: "price names",
  kindLabelsShort: "short price names",
  reach: "reach",
  country: "country",
  defaultRegion: "default region",
  expectedCurrencies: "currencies",
  sellFeeRate: "selling fee",
  schedule: "sync schedule",
  productUrl: "product links",
  categoryPlatforms: "category mapping",
  caveat: "warning",
  family: "shop group",
};

function isDriftField(value: string): value is (typeof DRIFT_FIELDS)[number] {
  return (DRIFT_FIELDS as readonly string[]).includes(value);
}

/**
 * The drift list as phrases a person reads. An unrecognised entry passes
 * through verbatim: dropping it would hide a warning.
 */
export function driftPhrases(drift: readonly string[], labelFor: (id: string) => string): string[] {
  return drift.map((entry) => {
    if (entry === "requiredSecrets") return "required keys";
    if (entry.startsWith("+")) return `${labelFor(entry.slice(1))} added`;
    if (entry.startsWith("-")) return `${labelFor(entry.slice(1))} removed`;
    const dot = entry.lastIndexOf(".");
    if (dot > 0) {
      const field = entry.slice(dot + 1);
      if (isDriftField(field)) return `${labelFor(entry.slice(0, dot))} ${DRIFT_PHRASE[field]}`;
    }
    return entry;
  });
}

/** "A, B and C" — a list a person reads rather than a JSON array. */
export function sentenceList(items: readonly string[]): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type ChipTone = "ok" | "warning" | "muted";

export interface PluginState {
  /** the one word in the header chip */
  chip: string;
  tone: ChipTone;
  /** the address, and when it last answered if it ever has */
  addressLine: string;
  /** the one health problem worth a badge, or null when there is none */
  healthBadge: string | null;
  /** what this status means for whether prices are read at all */
  statusNote: string | null;
}

/**
 * The card's state as ONE decision, so no two of its sentences contradict.
 *
 * The chip is first-match-wins, and the order matters: `configured` is also
 * false for a plugin that never answered, so "no reply" must precede "needs
 * its keys"; `lastError` survives while health keeps the last GOOD reading,
 * so it is checked before the healthy fallback.
 */
export function pluginState(plugin: PluginDto): PluginState {
  const when = plugin.lastHealthAt === null ? null : new Date(plugin.lastHealthAt).toLocaleString();
  const addressLine = when === null ? plugin.baseUrl : `${plugin.baseUrl} · last reply ${when}`;

  // Health states are mutually exclusive: each has a different fix.
  let healthBadge: string | null = null;
  if (plugin.lastHealthAt === null) {
    healthBadge = "No reply. Check the address and that the plugin is running.";
  } else if (!plugin.configured) {
    healthBadge =
      plugin.requiredSecrets.length > 0
        ? `Missing ${sentenceList(plugin.requiredSecrets)}. Set them where the plugin runs and restart it.`
        : "Not set up. Fix its configuration and restart it.";
  }

  let statusNote: string | null = null;
  if (plugin.status === "pending") statusNote = "No prices are read until you approve it.";
  if (plugin.status === "disabled") statusNote = "No requests. Stored prices are kept.";

  const state = (chip: string, tone: ChipTone): PluginState => ({
    chip,
    tone,
    addressLine,
    healthBadge,
    statusNote,
  });

  if (plugin.status === "disabled") return state("off", "muted");
  if (plugin.lastHealthAt === null) return state("no reply", "warning");
  if (!plugin.configured) return state("needs its keys", "warning");
  if (plugin.status === "pending") return state("needs review", "warning");
  if (plugin.proposed !== null) return state("update to review", "warning");
  if (plugin.lastError !== null) return state("last call failed", "warning");
  return state("on", "ok");
}
