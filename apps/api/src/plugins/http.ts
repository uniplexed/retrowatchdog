// undici's fetch, not Node's builtin — only this one is MockAgent-interceptable
import { fetch, type Response } from "undici";
import { PLUGIN_PROTOCOL_VERSION } from "@retrowatchdog/shared";

/**
 * Every call this app makes to a plugin goes through here. A plugin is the
 * least trusted process in the stack, so the bounds on what it can make this
 * deployment do sit on the app's side of the wire, in one place.
 */

/** The plugin answered with a status the protocol treats as a failure. */
export class PluginHttpError extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
  ) {
    super(`${label} answered HTTP ${status}`);
    this.name = "PluginHttpError";
  }
}

/**
 * The plugin answered, but not with something this protocol allows.
 * `detail` continues `label` as one sentence, so callers can re-form the message.
 */
export class PluginProtocolError extends Error {
  constructor(
    readonly label: string,
    readonly detail: string,
  ) {
    super(`${label} broke the protocol: ${detail}`);
    this.name = "PluginProtocolError";
  }
}

export interface BoundedRequest {
  /** what to call this call in an error message, e.g. "GET /search" */
  label: string;
  /** the whole request's budget, including the time the body takes to arrive */
  timeoutMs: number;
  /** how many bytes of body the app agrees to hold */
  maxBytes: number;
}

/** Only the parts of a request this app ever varies; the rest are fixed below. */
interface BoundedInit {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/** The response body as text, bounded in bytes, for callers that keep their own parse errors. */
export async function getTextBounded(url: string, opts: BoundedRequest): Promise<string> {
  return requestBounded(url, { method: "GET" }, opts);
}

export async function getJsonBounded(url: string, opts: BoundedRequest): Promise<unknown> {
  return parseJson(await requestBounded(url, { method: "GET" }, opts), opts);
}

/** A POST with a JSON body, under the same bounds as the GETs. */
export async function postJsonBounded(url: string, body: unknown, opts: BoundedRequest): Promise<unknown> {
  const text = await requestBounded(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    opts,
  );
  return parseJson(text, opts);
}

function parseJson(text: string, opts: BoundedRequest): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PluginProtocolError(opts.label, "did not answer JSON");
  }
}

async function requestBounded(url: string, init: BoundedInit, opts: BoundedRequest): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      // Identification for the plugin's access log, never a credential.
      "user-agent": `RetroWatchdog/${PLUGIN_PROTOCOL_VERSION} (+source plugin client)`,
      "x-retrowatchdog-protocol": String(PLUGIN_PROTOCOL_VERSION),
      ...init.headers,
    },
    // Bounds the whole request INCLUDING the body (measured: undici aborts an
    // in-flight `read()` on a stalled body), so the byte counter is about memory alone.
    signal: AbortSignal.timeout(opts.timeoutMs),
    // Following a redirect would let the least-trusted process pick a URL for
    // the api container to fetch, and would hide a non-2xx.
    redirect: "error",
  });
  if (!res.ok) {
    await discard(res);
    throw new PluginHttpError(opts.label, res.status);
  }
  return readBounded(res, opts);
}

/**
 * Let go of a body this app has decided not to read. Without it the socket
 * stays open until the timeout (measured: a 503 server wrote 99 KB more over
 * 1.5 s after the throw).
 */
async function discard(res: Response): Promise<void> {
  if (res.body === null) return;
  await res.body.cancel().catch(() => undefined);
}

/**
 * The response body, read through a byte counter instead of buffered whole:
 * the timeout bounds how long, not how much. Content-Length is not trusted.
 * The counter sees DECODED bytes, so a gzip bomb trips at its expanded size.
 */
async function readBounded(res: Response, opts: BoundedRequest): Promise<string> {
  if (res.body === null) return "";
  // undici types the body as ReadableStream<any>; the chunks are bytes
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > opts.maxBytes) {
        throw new PluginProtocolError(opts.label, `answered more than ${opts.maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // cancel, not just release: an oversized body must stop arriving
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}
