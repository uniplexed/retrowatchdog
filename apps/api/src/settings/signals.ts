import { eq } from "drizzle-orm";
import {
  RECOMMENDATION_DEFAULTS,
  SIGNAL_THRESHOLD_DEFAULTS,
  SIGNAL_TYPES,
  type SignalConfigDto,
} from "@retrowatchdog/shared";
import type { Db } from "../db/index.js";
import { appSettings } from "../db/schema.js";
import { config } from "../config.js";
import { ratesToUsd } from "../pricing/fx.js";
import type { SignalConfig } from "../signals/computeSignals.js";

/** app_settings key holding the SignalConfigDto JSON */
export const SIGNAL_CONFIG_KEY = "signal_config";

/** how long one process trusts its copy; the worker therefore sees a save within a minute */
const CACHE_MS = 60_000;

/** The configuration before anyone edits it: the env factors and the fixed thresholds. */
export function defaultSignalConfig(): SignalConfigDto {
  return {
    underpricedFactor: config.SIGNAL_UNDERPRICED_FACTOR,
    overpricedFactor: config.SIGNAL_OVERPRICED_FACTOR,
    flipFactor: config.SIGNAL_VOUCHER_FACTOR,
    profitFactor: config.SIGNAL_PROFIT_FACTOR,
    crossStoreFactor: config.SIGNAL_CROSS_STORE_FACTOR,
    minSample: config.SIGNAL_MIN_SAMPLE,
    ...SIGNAL_THRESHOLD_DEFAULTS,
    ...RECOMMENDATION_DEFAULTS,
    enabledTypes: SIGNAL_TYPES.filter((t) => t !== "INSUFFICIENT_DATA"),
    excludedSources: [],
    minGain: null,
    alertLowConfidence: false,
  };
}

/**
 * A stored object laid over the defaults key by key. Only known keys whose
 * value has the default's shape survive, so a hand-edited or older row can
 * neither inject a field nor break a rule with a string where a number goes.
 */
function mergeStored(stored: unknown): SignalConfigDto {
  const merged: Record<string, unknown> = { ...defaultSignalConfig() };
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return merged as unknown as SignalConfigDto;
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in merged)) continue;
    const fallback = merged[key];
    const sameShape =
      key === "minGain"
        ? value === null || (typeof value === "object" && !Array.isArray(value))
        : Array.isArray(fallback)
          ? Array.isArray(value)
          : typeof value === typeof fallback;
    if (sameShape) merged[key] = value;
  }
  return merged as unknown as SignalConfigDto;
}

/** minGain in USD at today's rate; FX down means no floor rather than a failed request */
export async function withMinGainUsd(db: Db, dto: SignalConfigDto): Promise<SignalConfig> {
  if (dto.minGain === null) return { ...dto, minGainUsd: null };
  try {
    const rate = (await ratesToUsd(db, [dto.minGain.currency])).get(dto.minGain.currency);
    return { ...dto, minGainUsd: rate === undefined ? null : Math.round(dto.minGain.amount * rate * 100) / 100 };
  } catch (err) {
    console.warn(`signal_config: minimum gain ignored, no ${dto.minGain.currency} rate (${String(err)})`);
    return { ...dto, minGainUsd: null };
  }
}

let cache: { at: number; config: SignalConfig } | null = null;

/** The configuration every signal computation uses, cached per process for CACHE_MS. */
export async function loadSignalConfig(db: Db): Promise<SignalConfig> {
  if (cache !== null && Date.now() - cache.at < CACHE_MS) return cache.config;
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SIGNAL_CONFIG_KEY));
  const loaded = await withMinGainUsd(db, mergeStored(row?.value));
  cache = { at: Date.now(), config: loaded };
  return loaded;
}

/** the wire shape: the engine-only minGainUsd stripped */
export function toSignalConfigDto(cfg: SignalConfig): SignalConfigDto {
  const { minGainUsd: _derived, ...dto } = cfg;
  return dto;
}

/** called after every config write, so caches derived from the config (insights) drop */
export const onSignalConfigSaved: Array<() => void> = [];

export async function saveSignalConfig(db: Db, dto: SignalConfigDto): Promise<SignalConfig> {
  await db
    .insert(appSettings)
    .values({ key: SIGNAL_CONFIG_KEY, value: dto })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: dto, updatedAt: new Date() } });
  cache = null;
  for (const f of onSignalConfigSaved) f();
  return loadSignalConfig(db);
}

export async function resetSignalConfig(db: Db): Promise<SignalConfigDto> {
  await db.delete(appSettings).where(eq(appSettings.key, SIGNAL_CONFIG_KEY));
  cache = null;
  for (const f of onSignalConfigSaved) f();
  return toSignalConfigDto(await loadSignalConfig(db));
}

export function clearSignalConfigCacheForTests(): void {
  cache = null;
}
