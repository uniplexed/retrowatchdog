import { validateManifest, echo, type PluginManifest } from "@retrowatchdog/shared";
import { config } from "../config.js";
import { getJsonBounded, PluginProtocolError } from "./http.js";
import type { PluginHealth } from "./repo.js";

/**
 * The app's calls to a plugin about itself (health, manifest), made by the
 * import route and the worker's health tick through the bounded request.
 */

/** Health and manifest are small: a plugin that needs 1 MB to say hello is broken. */
const DECLARATION_MAX_BYTES = 1024 * 1024;

/**
 * GET /health. Never calls the source: it reports only that the process is up
 * and holds what it needs. No circuit breaker; bounded in time, bytes and redirects.
 */
export async function fetchPluginHealth(
  baseUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<PluginHealth> {
  const label = `${baseUrl} GET /health`;
  const body = await getJsonBounded(`${baseUrl}/health`, {
    label,
    timeoutMs: opts.timeoutMs ?? config.ADAPTER_TIMEOUT_MS,
    maxBytes: DECLARATION_MAX_BYTES,
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PluginProtocolError(label, "did not answer a JSON object");
  }
  const health = body as Record<string, unknown>;
  if (health.status !== "ok") {
    // `echo`: the plugin chose this string, and the message is stored and displayed.
    throw new PluginProtocolError(label, `status ${echo(health.status)} is not "ok"`);
  }
  if (typeof health.protocol !== "number") {
    throw new PluginProtocolError(label, "protocol is missing or not a number");
  }
  // Silence about `configured` must read as no: the registry only lets a
  // plugin's sources be enabled when the last health reading says yes.
  return { status: "ok", protocol: health.protocol, configured: health.configured === true };
}

/**
 * GET /manifest, validated by the shared `validateManifest` so an import
 * preview and the app can never disagree about what is valid.
 */
export async function fetchPluginManifest(
  baseUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<PluginManifest> {
  const label = `${baseUrl} GET /manifest`;
  const body = await getJsonBounded(`${baseUrl}/manifest`, {
    label,
    timeoutMs: opts.timeoutMs ?? config.ADAPTER_TIMEOUT_MS,
    maxBytes: DECLARATION_MAX_BYTES,
  });
  const validation = validateManifest(body);
  if (!validation.ok) throw new PluginProtocolError(label, validation.reason);
  return validation.manifest;
}
