import type {
  AcquiredSource,
  AddCopyInput,
  AddWatchInput,
  CollectionHistoryResponse,
  CollectionResponse,
  CsvCollectionImportResponse,
  CsvImportRequest,
  CsvRowError,
  CsvWatchlistImportResponse,
  FxRateResponse,
  FxSettingDto,
  FxSettingsResponse,
  HistoryResponse,
  LinkCopyInput,
  MarketSettingsResponse,
  OwnedCopyDto,
  PcImportRequest,
  PcImportResponse,
  PricesResponse,
  SearchResponse,
  SignalConfigDto,
  SignalPreviewResponse,
  SourceId,
  SourcesResponse,
  SupportedCurrency,
  UpdateCopyInput,
  UpdateFxSettingInput,
  UpdateMarketsInput,
  UpdateWatchInput,
  ValuationBasis,
  InsightsResponse,
  SuggestedThresholdsResponse,
  WatchlistHistoryResponse,
  SparklinesResponse,
  ValuationMarkets,
  WatchlistResponse,
} from "@retrowatchdog/shared";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Error for a failed write, carrying the server's {error} detail (e.g. FX-down 503). */
async function apiError(res: Response, action: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) detail = `: ${body.error}`;
  } catch {
    // non-JSON error body: fall back to the generic message
  }
  return new Error(`API ${res.status} ${action}${detail}`);
}

export function searchGames(q: string): Promise<SearchResponse> {
  return getJson(`/api/search?q=${encodeURIComponent(q)}`);
}

export function getPrices(
  gameId: number,
  opts: { region?: string; condition?: string; signalRegion?: string; signalCondition?: string; refresh?: boolean } = {},
): Promise<PricesResponse> {
  const params = new URLSearchParams();
  if (opts.region) params.set("region", opts.region);
  if (opts.condition) params.set("condition", opts.condition);
  if (opts.signalRegion) params.set("signalRegion", opts.signalRegion);
  if (opts.signalCondition) params.set("signalCondition", opts.signalCondition);
  if (opts.refresh) params.set("refresh", "true");
  const suffix = params.size > 0 ? `?${params}` : "";
  return getJson(`/api/games/${gameId}/prices${suffix}`);
}

export function getCollectionHistory(
  basis: ValuationBasis,
  markets: ValuationMarkets,
  window: { from: string; to: string },
): Promise<CollectionHistoryResponse> {
  const params = new URLSearchParams({
    valuation: basis,
    country: markets.country,
    includeForeign: String(markets.includeForeign),
    from: window.from,
    to: window.to,
  });
  return getJson(`/api/collection/history?${params}`);
}

export function getPriceHistory(
  gameId: number,
  opts: { region: string; condition: string; from: string; to: string },
): Promise<HistoryResponse> {
  const params = new URLSearchParams({ region: opts.region, condition: opts.condition, from: opts.from, to: opts.to });
  return getJson(`/api/games/${gameId}/history?${params}`);
}

export async function setGamePriceMode(
  gameId: number,
  priceMode: "live" | "cached_only" | null,
): Promise<void> {
  const res = await fetch(`/api/games/${gameId}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ priceMode }),
  });
  if (!res.ok) throw new Error(`API ${res.status} setting price mode`);
}

/** The collection valued under a basis and markets; omitted = API defaults. */
export function getCollection(
  basis?: ValuationBasis,
  markets?: ValuationMarkets,
): Promise<CollectionResponse> {
  const params = new URLSearchParams();
  if (basis !== undefined) params.set("valuation", basis);
  if (markets !== undefined) {
    params.set("country", markets.country);
    // spelled out both ways: the API reads only the exact string "true"
    params.set("includeForeign", String(markets.includeForeign));
  }
  const suffix = params.size > 0 ? `?${params}` : "";
  return getJson(`/api/collection${suffix}`);
}

export async function addCopy(input: AddCopyInput): Promise<{ id: number }> {
  const res = await fetch("/api/collection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "adding copy");
  return (await res.json()) as { id: number };
}

export async function deleteCopy(id: number): Promise<void> {
  const res = await fetch(`/api/collection/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`API ${res.status} deleting copy`);
}

/** Wipes the whole collection, or one acquired_source; the caller warns. */
export async function deleteCollection(source?: AcquiredSource): Promise<{ deleted: number }> {
  const suffix = source !== undefined ? `?source=${encodeURIComponent(source)}` : "";
  const res = await fetch(`/api/collection${suffix}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`API ${res.status} deleting collection`);
  return (await res.json()) as { deleted: number };
}

export async function updateCopy(id: number, input: UpdateCopyInput): Promise<void> {
  const res = await fetch(`/api/collection/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "updating copy");
}

/** Match-review: re-link a copy to the game it actually is; returns the item. */
export async function linkCopy(id: number, input: LinkCopyInput): Promise<OwnedCopyDto> {
  const res = await fetch(`/api/collection/${id}/link`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "re-linking copy");
  return (await res.json()) as OwnedCopyDto;
}

/** Match-review: mark the copy's current link verified; returns the updated item. */
export async function confirmLink(id: number): Promise<OwnedCopyDto> {
  const res = await fetch(`/api/collection/${id}/confirm-link`, { method: "POST" });
  if (!res.ok) throw await apiError(res, "confirming link");
  return (await res.json()) as OwnedCopyDto;
}

export function getFxRate(to: SupportedCurrency): Promise<FxRateResponse> {
  return getJson(`/api/fx?to=${to}`);
}

export function getFxSettings(): Promise<FxSettingsResponse> {
  return getJson("/api/settings/fx");
}

export async function updateFxSetting(
  currency: SupportedCurrency,
  input: UpdateFxSettingInput,
): Promise<FxSettingDto> {
  const res = await fetch(`/api/settings/fx/${currency}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "updating FX setting");
  return (await res.json()) as FxSettingDto;
}

/** Every source of every approved plugin; read by lib/sources.ts. */
export function getSources(): Promise<SourcesResponse> {
  return getJson("/api/sources");
}

/** Which markets this deployment queries (server-side, shared by the worker). */
export function getMarketSettings(): Promise<MarketSettingsResponse> {
  return getJson("/api/settings/markets");
}

export function getSignalSettings(): Promise<SignalConfigDto> {
  return getJson("/api/settings/signals");
}

async function sendSignalSettings(url: string, method: string, action: string, body?: SignalConfigDto) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res, action);
  return res.json();
}

/** Replaces the whole configuration; returns what the server stored. */
export function putSignalSettings(config: SignalConfigDto): Promise<SignalConfigDto> {
  return sendSignalSettings("/api/settings/signals", "PUT", "saving the Barks (Signals) settings", config);
}

export function resetSignalSettings(): Promise<SignalConfigDto> {
  return sendSignalSettings("/api/settings/signals/reset", "POST", "resetting the Barks (Signals) settings");
}

/** What a draft configuration would do to the watchlist; stores nothing. */
export function previewSignalSettings(config: SignalConfigDto): Promise<SignalPreviewResponse> {
  return sendSignalSettings("/api/settings/signals/preview", "POST", "previewing the Barks (Signals) settings", config);
}

/** Replaces the enabled list (never a delta); returns what the server stored. */
export async function updateMarketSettings(
  enabled: SourceId[],
): Promise<MarketSettingsResponse> {
  const input: UpdateMarketsInput = { enabled };
  const res = await fetch("/api/settings/markets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "updating markets");
  return (await res.json()) as MarketSettingsResponse;
}

export async function importPricecharting(input: PcImportRequest): Promise<PcImportResponse> {
  const res = await fetch("/api/collection/import/pricecharting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    // surface the server's error code (invalid URL, fetch_failed, ...) when present
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `: ${body.error}`;
    } catch {
      // non-JSON error body: fall back to the generic message
    }
    throw new Error(`API ${res.status} importing from PriceCharting${detail}`);
  }
  return (await res.json()) as PcImportResponse;
}

/** Structured failure of a CSV import POST, carrying row-level errors. */
export class CsvImportError extends Error {
  readonly code: string | undefined;
  /** invalid_rows: every row-level problem, all-or-nothing (nothing imported) */
  readonly rowErrors: CsvRowError[] | undefined;

  constructor(message: string, code?: string, rowErrors?: CsvRowError[]) {
    super(message);
    this.name = "CsvImportError";
    this.code = code;
    this.rowErrors = rowErrors;
  }
}

async function postCsvImport<T>(url: string, input: CsvImportRequest): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let body: { error?: string; code?: string; rowErrors?: CsvRowError[] } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON error body: fall back to the generic message
    }
    const detail = body.error ? `: ${body.error}` : "";
    throw new CsvImportError(`API ${res.status} importing CSV${detail}`, body.code, body.rowErrors);
  }
  return (await res.json()) as T;
}

export function importCollectionCsv(input: CsvImportRequest): Promise<CsvCollectionImportResponse> {
  return postCsvImport("/api/collection/import/csv", input);
}

export function importWatchlistCsv(input: CsvImportRequest): Promise<CsvWatchlistImportResponse> {
  return postCsvImport("/api/watchlist/import/csv", input);
}

export function getWatchlist(): Promise<WatchlistResponse> {
  return getJson("/api/watchlist");
}

export async function addWatch(input: AddWatchInput): Promise<{ id: number }> {
  const res = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`API ${res.status} adding watch`);
  return (await res.json()) as { id: number };
}

/** 409 when the narrowed watch collides with another; the message says so */
export async function updateWatch(id: number, input: UpdateWatchInput): Promise<void> {
  const res = await fetch(`/api/watchlist/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "updating watch");
}

export async function deleteWatch(id: number): Promise<void> {
  const res = await fetch(`/api/watchlist/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`API ${res.status} removing watch`);
}

/** Clears the whole watchlist; the caller carries the confirm dialog. */
export async function deleteWatchlist(): Promise<{ deleted: number }> {
  const res = await fetch("/api/watchlist", { method: "DELETE" });
  if (!res.ok) throw new Error(`API ${res.status} clearing watchlist`);
  return (await res.json()) as { deleted: number };
}

export function getInsights(): Promise<InsightsResponse> {
  return getJson("/api/insights");
}

export function getSuggestedThresholds(): Promise<SuggestedThresholdsResponse> {
  return getJson("/api/settings/signals/suggested");
}

export function getWatchlistHistory(window: { from: string; to: string }): Promise<WatchlistHistoryResponse> {
  return getJson(`/api/watchlist/history?${new URLSearchParams(window)}`);
}

/** the reliability table for one period: the barks (signals) first seen inside it */
export function getReliability(window: { from: string; to: string }): Promise<{ from: string; to: string; reliability: InsightsResponse["reliability"] }> {
  return getJson(`/api/insights/reliability?${new URLSearchParams(window)}`);
}

export function getWatchlistSparklines(): Promise<SparklinesResponse> {
  return getJson("/api/watchlist/sparklines");
}

export function getCollectionSparklines(basis: ValuationBasis): Promise<SparklinesResponse> {
  return getJson(`/api/collection/sparklines?valuation=${basis}`);
}
