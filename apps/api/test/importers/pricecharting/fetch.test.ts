import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { fetch as undiciFetch } from "undici";
import { createPageFetcher, PcFetchError } from "../../../src/importers/pricecharting/fetch.js";
import {
  fetchCollection,
  resetPcFetchCacheForTests,
  type PageFetcher,
} from "../../../src/importers/pricecharting/index.js";

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

const response = (
  status: number,
  body = "<html></html>",
  headers: Record<string, string> = {},
): FetchResponse =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: new Headers(headers),
  }) as unknown as FetchResponse;

const COLLECTION_URL = "https://www.pricecharting.com/offers?seller=abc&status=collection";

describe("createPageFetcher", () => {
  it("GETs page 1 with the identifying User-Agent and no body", async () => {
    const fetchImpl = vi.fn(async () => response(200, "page-one"));
    const fetchPage = createPageFetcher({ fetchImpl: fetchImpl as unknown as typeof undiciFetch, minIntervalMs: 0 });
    await expect(fetchPage(COLLECTION_URL, null)).resolves.toBe("page-one");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(COLLECTION_URL);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RetroWatchdog/1.0 personal collection import",
    );
  });

  it("POSTs later pages to the SAME url with a form-urlencoded cursor", async () => {
    const fetchImpl = vi.fn(async () => response(200, "page-two"));
    const fetchPage = createPageFetcher({ fetchImpl: fetchImpl as unknown as typeof undiciFetch, minIntervalMs: 0 });
    await fetchPage(COLLECTION_URL, "tok/en=");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(COLLECTION_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(init.body).toBe("cursor=tok%2Fen%3D");
  });

  it("retries with exponential backoff: 503, 503, then 200 succeeds on the third attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, "recovered"));
    const sleep = vi.fn(async () => {});
    const fetchPage = createPageFetcher({
      fetchImpl: fetchImpl as unknown as typeof undiciFetch,
      minIntervalMs: 0,
      sleep,
    });
    await expect(fetchPage(COLLECTION_URL, null)).resolves.toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 30_000);
  });

  it("honors a numeric Retry-After header instead of the default delay", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(503, "<html></html>", { "retry-after": "45" }))
      .mockResolvedValueOnce(response(200, "recovered"));
    const sleep = vi.fn(async () => {});
    const fetchPage = createPageFetcher({
      fetchImpl: fetchImpl as unknown as typeof undiciFetch,
      minIntervalMs: 0,
      sleep,
    });
    await expect(fetchPage(COLLECTION_URL, null)).resolves.toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(45_000);
  });

  it("caps a Retry-After header above 120s", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(503, "<html></html>", { "retry-after": "999" }))
      .mockResolvedValueOnce(response(200, "recovered"));
    const sleep = vi.fn(async () => {});
    const fetchPage = createPageFetcher({
      fetchImpl: fetchImpl as unknown as typeof undiciFetch,
      minIntervalMs: 0,
      sleep,
    });
    await expect(fetchPage(COLLECTION_URL, null)).resolves.toBe("recovered");
    expect(sleep).toHaveBeenCalledWith(120_000);
  });

  it("gives up with PcFetchError after 4 consecutive 503s (3 retries exhausted)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503));
    const sleep = vi.fn(async () => {});
    const fetchPage = createPageFetcher({
      fetchImpl: fetchImpl as unknown as typeof undiciFetch,
      minIntervalMs: 0,
      sleep,
    });
    const err = await fetchPage(COLLECTION_URL, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PcFetchError);
    expect((err as PcFetchError).code).toBe("fetch_failed");
    expect((err as PcFetchError).attempts).toBe(4);
    expect((err as PcFetchError).statuses).toEqual([503, 503, 503, 503]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-rate-limit errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404));
    const fetchPage = createPageFetcher({
      fetchImpl: fetchImpl as unknown as typeof undiciFetch,
      minIntervalMs: 0,
    });
    await expect(fetchPage(COLLECTION_URL, null)).rejects.toBeInstanceOf(PcFetchError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("wraps network failures in PcFetchError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const fetchPage = createPageFetcher({
      fetchImpl: fetchImpl as unknown as typeof undiciFetch,
      minIntervalMs: 0,
    });
    await expect(fetchPage(COLLECTION_URL, null)).rejects.toBeInstanceOf(PcFetchError);
  });
});

describe("fetchCollection", () => {
  const page1 = readFileSync(
    new URL("../../../src/importers/pricecharting/fixtures/collection-page1.html", import.meta.url),
    "utf8",
  );
  const page2 = readFileSync(
    new URL("../../../src/importers/pricecharting/fixtures/collection-page2.html", import.meta.url),
    "utf8",
  );
  const PAGE1_CURSOR =
    "ClAKEwoGU3RhcnRzEgkIxqrA4PGSlAMSNWoLc352Z3BjLWJvdHNyJgsSBm9mZmVycyIac2k0YzZjNDVwaW9hcXRqZ3gydjJzcHB2dTQMGAAgAQ";

  // every test in this block reuses COLLECTION_URL: without a reset, caching
  // from one test would silently starve the fetcher in the next
  beforeEach(() => {
    resetPcFetchCacheForTests();
  });

  it("follows the cursor chain across pages and stops on a page without one", async () => {
    const calls: Array<string | null> = [];
    const fetcher: PageFetcher = async (_url, cursor) => {
      calls.push(cursor);
      if (cursor === null) return page1;
      if (cursor === PAGE1_CURSOR) return page2;
      return "<html><body>last page, no offers</body></html>";
    };
    const { items, totalCount } = await fetchCollection(COLLECTION_URL, fetcher);
    expect(items).toHaveLength(60);
    // page 1's summary table says 67 items: 60 rows < 67 is real truncation
    // the route must be able to report, not a synthetic case
    expect(totalCount).toBe(67);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBeNull();
    expect(calls[1]).toBe(PAGE1_CURSOR);
    expect(items[0].offerId).toBe("u7x5vryx3fnhulbjzihj4y2xou");
    expect(items[30].offerId).toBe("a446hcx7vgnnxkruu2ougcbsim");
  });

  it("caps pagination at 20 pages even if a cursor never ends", async () => {
    const fetcher: PageFetcher = vi.fn(async () => page1); // always offers a next cursor
    const { items, totalCount } = await fetchCollection(COLLECTION_URL, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(20);
    expect(items).toHaveLength(30); // same 30 offers deduped by offerId
    expect(totalCount).toBe(67); // still the first page's summary count
  });

  it("reports a null totalCount when no page carries a summary table", async () => {
    const fetcher: PageFetcher = async () => "<html><body>no offers, no summary</body></html>";
    const { items, totalCount } = await fetchCollection(COLLECTION_URL, fetcher);
    expect(items).toHaveLength(0);
    expect(totalCount).toBeNull();
  });

  const pagingFetcher = (): { fetcher: PageFetcher; calls: () => number } => {
    let calls = 0;
    const fetcher: PageFetcher = async (_url, cursor) => {
      calls++;
      if (cursor === null) return page1;
      if (cursor === PAGE1_CURSOR) return page2;
      return "<html><body>no more offers</body></html>";
    };
    return { fetcher, calls: () => calls };
  };

  it("caches the parsed collection: a second call within the TTL makes no fetcher calls", async () => {
    const { fetcher, calls } = pagingFetcher();
    const first = await fetchCollection(COLLECTION_URL, fetcher);
    expect(calls()).toBe(3);
    const second = await fetchCollection(COLLECTION_URL, fetcher);
    expect(calls()).toBe(3); // served from cache: no new fetcher calls
    expect(second).toEqual(first);
  });

  it("refetches once the 10-minute TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const { fetcher, calls } = pagingFetcher();
      await fetchCollection(COLLECTION_URL, fetcher);
      expect(calls()).toBe(3);
      vi.advanceTimersByTime(10 * 60_000 + 1);
      await fetchCollection(COLLECTION_URL, fetcher);
      expect(calls()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetPcFetchCacheForTests clears cached collections", async () => {
    const { fetcher, calls } = pagingFetcher();
    await fetchCollection(COLLECTION_URL, fetcher);
    expect(calls()).toBe(3);
    resetPcFetchCacheForTests();
    await fetchCollection(COLLECTION_URL, fetcher);
    expect(calls()).toBe(6);
  });
});
