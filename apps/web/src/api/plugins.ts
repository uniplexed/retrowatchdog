import type {
  ApprovePluginInput,
  PluginResponse,
  PluginsResponse,
} from "@retrowatchdog/shared";

/**
 * The plugin endpoints. Kept out of client.ts for the error shape: a plugin
 * refusal is a sentence the user must act on, printed verbatim without the
 * "API 400 <action>:" prefix.
 */
async function pluginError(res: Response, action: string): Promise<Error> {
  let reason = "";
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") reason = body.error;
  } catch {
    // a non-JSON error body (a proxy's HTML, an empty 502): fall back below
  }
  return new Error(reason !== "" ? reason : `API ${res.status} ${action}`);
}

/**
 * `fetch` that says whose fetch failed: a raw "Failed to fetch" here reads as
 * "your plugin is unreachable" when it is the app's own API.
 */
async function apiFetch(url: string, action: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the app's API (${url}) while ${action}: ${detail}`);
  }
}

export async function getPlugins(): Promise<PluginsResponse> {
  const res = await apiFetch("/api/plugins", "loading plugins");
  if (!res.ok) throw await pluginError(res, "loading plugins");
  return (await res.json()) as PluginsResponse;
}

/** Import by URL. The plugin is stored PENDING; approving is a separate act. */
export async function addPlugin(baseUrl: string): Promise<PluginResponse> {
  const res = await apiFetch("/api/plugins", "adding a plugin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl }),
  });
  if (!res.ok) throw await pluginError(res, "adding plugin");
  return (await res.json()) as PluginResponse;
}

/**
 * Grant the kinds the user checked. `reviewedFingerprint` is evidence: it must
 * come from the response that was rendered, never computed or cached here.
 */
export async function approvePlugin(id: number, input: ApprovePluginInput): Promise<PluginResponse> {
  const res = await apiFetch(`/api/plugins/${id}/approve`, "approving a plugin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await pluginError(res, "approving plugin");
  return (await res.json()) as PluginResponse;
}

/** Probe this plugin now instead of on the worker's tick. Grants nothing. */
export async function recheckPlugin(id: number): Promise<PluginResponse> {
  const res = await apiFetch(`/api/plugins/${id}/recheck`, "checking a plugin", {
    method: "POST",
  });
  if (!res.ok) throw await pluginError(res, "checking plugin");
  return (await res.json()) as PluginResponse;
}

/** Set how fast the app may call this plugin, or `null` for the default. */
export async function savePluginPace(id: number, rateLimitMs: number | null): Promise<PluginResponse> {
  const res = await apiFetch(`/api/plugins/${id}/pace`, "saving a plugin's pace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rateLimitMs }),
  });
  if (!res.ok) throw await pluginError(res, "saving pace");
  return (await res.json()) as PluginResponse;
}

/**
 * Move a plugin to a new address, keeping what it was granted. A different
 * manifest there comes back as drift to review, not inherited consent.
 */
export async function savePluginAddress(id: number, baseUrl: string): Promise<PluginResponse> {
  const res = await apiFetch(`/api/plugins/${id}/address`, "moving a plugin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl }),
  });
  if (!res.ok) throw await pluginError(res, "moving plugin");
  return (await res.json()) as PluginResponse;
}

/**
 * Replace the enabled-markets list — the complete list, never a delta. Same
 * endpoint as `updateMarketSettings`, duplicated only for the error shape.
 */
export async function saveEnabledMarkets(enabled: string[]): Promise<void> {
  const res = await apiFetch("/api/settings/markets", "switching a market", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw await pluginError(res, "switching a market");
}

export async function disablePlugin(id: number): Promise<void> {
  const res = await apiFetch(`/api/plugins/${id}/disable`, "disabling a plugin", {
    method: "POST",
  });
  if (!res.ok) throw await pluginError(res, "disabling plugin");
}

export async function removePlugin(id: number): Promise<void> {
  const res = await apiFetch(`/api/plugins/${id}`, "removing a plugin", { method: "DELETE" });
  if (!res.ok) throw await pluginError(res, "removing plugin");
}
