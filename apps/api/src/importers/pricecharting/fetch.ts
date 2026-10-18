// undici's fetch, not Node's builtin — only this one is MockAgent-interceptable
import { fetch } from "undici";
import { RateLimiter } from "../../lib/rateLimiter.js";
import { config } from "../../config.js";

/**
 * Fetches one page of a public PriceCharting collection: page 1 is a GET, later
 * pages POST the previous page's opaque `cursor` to the same URL.
 */
export type PageFetcher = (url: string, cursor: string | null) => Promise<string>;

/** Clean abort signal the route maps to a fetch_failed response. */
export class PcFetchError extends Error {
  readonly code = "fetch_failed";
  /** Upstream HTTP statuses seen, in order, one per attempt that got a response. */
  readonly statuses: number[];
  /** Total number of requests attempted (initial + retries). */
  readonly attempts: number;
  constructor(message: string, info: { statuses?: number[]; attempts?: number } = {}) {
    super(message);
    this.name = "PcFetchError";
    this.statuses = info.statuses ?? [];
    this.attempts = info.attempts ?? this.statuses.length;
  }
}

// Browser-shaped but still identifies the tool: a bare bot UA gets blocked.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RetroWatchdog/1.0 personal collection import";

// A 2-request burst already drew a 503; failures are short-lived throttling,
// so pace 1 req/s and back off 429/503 over up to 3 retries.
const MIN_INTERVAL_MS = 1000;
/** a collection page is a few hundred KB; this bounds what one request may hold in memory */
const MAX_PAGE_CHARS = 4_000_000;
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];
const MAX_RETRY_AFTER_MS = 120_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

export interface PageFetcherOpts {
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  /** Backoff delays for retry 1, 2, 3 (ms); the last entry repeats past the array end. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A numeric Retry-After (seconds) from the response, capped; null if absent/non-numeric. */
function retryAfterMs(res: Awaited<ReturnType<typeof fetch>>): number | null {
  const header = res.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

export function createPageFetcher(opts: PageFetcherOpts = {}): PageFetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const limiter = new RateLimiter(opts.minIntervalMs ?? MIN_INTERVAL_MS);

  const requestOnce = async (
    url: string,
    cursor: string | null,
  ): Promise<{ status: number; body: string | null; retryAfterMs: number | null }> => {
    const res = await fetchImpl(url, {
      method: cursor === null ? "GET" : "POST",
      headers: {
        "user-agent": USER_AGENT,
        ...(cursor === null
          ? {}
          : { "content-type": "application/x-www-form-urlencoded" }),
      },
      body: cursor === null ? undefined : new URLSearchParams({ cursor }).toString(),
      signal: AbortSignal.timeout(config.ADAPTER_TIMEOUT_MS),
      // a redirect would let the page pick where this process fetches from
      redirect: "error",
    });
    if (!res.ok) return { status: res.status, body: null, retryAfterMs: retryAfterMs(res) };
    const body = await res.text();
    if (body.length > MAX_PAGE_CHARS) throw new PcFetchError("page larger than the import accepts", { statuses: [res.status], attempts: 1 });
    return { status: res.status, body, retryAfterMs: null };
  };

  return async (url: string, cursor: string | null): Promise<string> =>
    limiter.schedule(async () => {
      const statuses: number[] = [];
      for (let attempt = 0; ; attempt++) {
        let result: { status: number; body: string | null; retryAfterMs: number | null };
        try {
          result = await requestOnce(url, cursor);
        } catch (err) {
          throw new PcFetchError(
            `PriceCharting request failed on attempt ${attempt + 1}: ${(err as Error).message}`,
            { statuses, attempts: attempt + 1 },
          );
        }
        if (result.body !== null) return result.body;
        statuses.push(result.status);
        if (!RETRYABLE_STATUSES.has(result.status)) {
          throw new PcFetchError(`PriceCharting responded HTTP ${result.status}`, {
            statuses,
            attempts: attempt + 1,
          });
        }
        if (attempt >= retryDelaysMs.length) {
          throw new PcFetchError(
            `PriceCharting still rate-limiting after ${attempt} retries (statuses: ${statuses.join(", ")})`,
            { statuses, attempts: attempt + 1 },
          );
        }
        const delay = result.retryAfterMs ?? retryDelaysMs[attempt];
        await sleep(delay);
      }
    });
}

/** Shared production fetcher: one limiter, so concurrent imports still pace 1 req/s. */
export const defaultFetchPage: PageFetcher = createPageFetcher();
