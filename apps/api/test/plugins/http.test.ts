import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { PLUGIN_PROTOCOL_VERSION } from "@retrowatchdog/shared";
import {
  getJsonBounded,
  getTextBounded,
  postJsonBounded,
  PluginHttpError,
  PluginProtocolError,
} from "../../src/plugins/http.js";

/**
 * The one request every call to a plugin goes through. What is tested here is
 * not "fetch works" but the four rules the app imposes on the least-trusted
 * process in the stack: a failing status is a failure, a body is bounded in
 * bytes, a request is bounded in time INCLUDING its body, and a redirect is
 * refused rather than followed.
 *
 * A MockAgent shows most of that, and the mocked block below is where those
 * tests live — including the byte cap's THROW. What it cannot show is
 * anything about the wire: it replies in one piece, it does not compress, and
 * it has no socket to close. So the deadline covering an in-flight body, the
 * gzip expansion, and the two tests that check the app actually HANGS UP on a
 * body it has given up on bring up a throwaway `http` server on 127.0.0.1 and
 * close it again.
 */

const ORIGIN = "http://plug:8000";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * A plugin that answers `status` and then keeps sending, for as long as the
 * app is still listening. It reports what the app cannot see for itself: how
 * many bytes it managed to push AFTER the app gave up, and whether its socket
 * was ever closed. That is the only vantage point from which "the app stopped
 * reading" is an observation rather than an assumption — from inside the
 * process, an abandoned body and a cancelled one look identical.
 */
function talkativePlugin(status: number, chunk = "x".repeat(1024)) {
  const state = { gaveUp: false, bytesAfterGiveUp: 0, socketClosed: false };
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    const timer = setInterval(() => {
      if (state.socketClosed) return;
      res.write(chunk);
      if (state.gaveUp) state.bytesAfterGiveUp += chunk.length;
    }, 10);
    res.on("close", () => {
      state.socketClosed = true;
      clearInterval(timer);
    });
  });
  return { server, state };
}

describe("the bounded request, against a mocked plugin", () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  const intercept = (path: string, method: "GET" | "POST" = "GET") =>
    agent.get(ORIGIN).intercept({ path, method });

  it("asks for JSON and returns what was parsed", async () => {
    let seenAccept = "";
    intercept("/manifest").reply(200, (opts) => {
      seenAccept = String((opts.headers as Record<string, string>).accept ?? "");
      return { protocol: 2 };
    });

    await expect(getJsonBounded(`${ORIGIN}/manifest`, req("GET /manifest"))).resolves.toEqual({ protocol: 2 });
    expect(seenAccept).toContain("application/json");
  });

  it("says who is asking and which protocol it expects back", async () => {
    // An identification, never a credential: nothing is authorised by it, and a
    // plugin that ignores both headers works exactly as before. It exists so a
    // plugin author reading their own access log can tell this app from
    // anything else on the network, and can tell a deployment still speaking an
    // older protocol from one that is not.
    let headers: Record<string, string> = {};
    intercept("/health").reply(200, (opts) => {
      headers = opts.headers as Record<string, string>;
      return { status: "ok" };
    });

    await getJsonBounded(`${ORIGIN}/health`, req("GET /health"));
    expect(headers["user-agent"]).toContain("RetroWatchdog/");
    expect(headers["x-retrowatchdog-protocol"]).toBe(String(PLUGIN_PROTOCOL_VERSION));
  });

  it("posts a JSON body and reads the answer", async () => {
    let seenBody = "";
    let seenType = "";
    intercept("/catalog/refresh", "POST").reply(200, (opts) => {
      seenBody = String(opts.body ?? "");
      seenType = String((opts.headers as Record<string, string>)["content-type"] ?? "");
      return { rows: [] };
    });

    await expect(
      postJsonBounded(`${ORIGIN}/catalog/refresh`, { ids: ["a1"] }, req("POST /catalog/refresh")),
    ).resolves.toEqual({ rows: [] });
    expect(JSON.parse(seenBody)).toEqual({ ids: ["a1"] });
    expect(seenType).toBe("application/json");
  });

  it("treats a failing status as a failure, and says which", async () => {
    intercept("/health").reply(503, "");
    const failure = await getTextBounded(`${ORIGIN}/health`, req("GET /health")).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PluginHttpError);
    expect((failure as PluginHttpError).status).toBe(503);
    expect((failure as Error).message).toBe("GET /health answered HTTP 503");
  });

  it("names the plugin's fault when the body is not JSON, and hands the text back untouched to a caller that parses its own", async () => {
    intercept("/health").reply(200, "<html>login required</html>", { headers: { "content-type": "text/html" } });
    await expect(getJsonBounded(`${ORIGIN}/health`, req("GET /health"))).rejects.toThrow(
      "GET /health broke the protocol: did not answer JSON",
    );

    // getTextBounded is the primitive SidecarAdapter uses precisely so its own
    // JSON.parse failure keeps reading the way it always has.
    intercept("/search").reply(200, "<html>login required</html>", { headers: { "content-type": "text/html" } });
    await expect(getTextBounded(`${ORIGIN}/search`, req("GET /search"))).resolves.toBe("<html>login required</html>");
  });

  it("refuses a body past the byte cap, and says what the cap was", async () => {
    // The deadline bounds how LONG a body may take; nothing but this counter
    // bounds how MUCH of it the app holds. What a mock can show is the
    // refusal; that the body then stops ARRIVING is the socket test below.
    intercept("/manifest").reply(200, { filler: "x".repeat(4096) });
    const failure = await getTextBounded(`${ORIGIN}/manifest`, req("GET /manifest", { maxBytes: 512 })).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(PluginProtocolError);
    expect((failure as Error).message).toBe("GET /manifest broke the protocol: answered more than 512 bytes");
  });

  /**
   * Following a redirect would let the least-trusted process in the stack pick
   * a URL for the api container to fetch — any service on its network, or
   * anywhere at all.
   *
   * The redirect TARGET is intercepted too, and that is the whole point of
   * this test: with only the 302 mocked, the call rejects whether the app
   * refuses redirects or follows them (a MockAgent with net connect disabled
   * has nothing to follow to), so the assertion would hold with the rule
   * deleted. With the target mocked, following it SUCCEEDS — measured — so
   * this rejection is evidence about the rule and not about the fixture. The
   * untouched interceptor is the second half of that evidence: the app never
   * went there.
   */
  it("refuses a redirect instead of following the plugin somewhere else", async () => {
    intercept("/health").reply(302, "", { headers: { location: `${ORIGIN}/elsewhere` } });
    intercept("/elsewhere").reply(200, { status: "ok", protocol: 2, configured: true });

    await expect(getJsonBounded(`${ORIGIN}/health`, req("GET /health"))).rejects.toBeTruthy();

    const untouched = agent.pendingInterceptors();
    expect(untouched).toHaveLength(1);
    expect(untouched[0].path).toBe("/elsewhere");
  });
});

describe("the bounded request, against a real plugin socket", () => {
  /**
   * A body that arrives, and arrives, and never ends. The comment on the byte
   * counter rests on the claim that the request timeout bounds how LONG a body
   * takes — so it is worth owning that the claim was measured rather than
   * assumed: `AbortSignal.timeout` is an absolute deadline from the moment the
   * request starts, and it aborts an in-flight body read, not merely the wait
   * for headers. A plugin dripping one byte at a time cannot hold an api
   * request open past its budget.
   */
  it("aborts a body that is still dripping when the deadline passes", async () => {
    let written = 0;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const timer = setInterval(() => {
        written += 1;
        res.write(" ");
      }, 30);
      res.on("close", () => clearInterval(timer));
    });
    const base = await listen(server);
    const started = Date.now();

    // maxBytes is huge on purpose: the byte counter must not be what ends this
    await expect(
      getTextBounded(`${base}/search`, { label: "GET /search", timeoutMs: 400, maxBytes: 8 * 1024 * 1024 }),
    ).rejects.toThrow(/abort|timeout/i);

    const elapsed = Date.now() - started;
    // Close to the 400 ms budget, not merely finite: a generous ceiling would
    // pass even if the deadline only stopped the wait for headers and let the
    // body drip on. 2 s is slack for a loaded CI box, not another budget.
    expect(elapsed).toBeLessThan(2000);
    // and it really was mid-body: the server got to write before the abort
    expect(written).toBeGreaterThan(0);
    await shutdown(server);
  }, 15_000);

  /**
   * undici applies content-encoding before the app sees a chunk, so the
   * counter counts EXPANDED bytes. That is the number worth bounding: the
   * expanded body is what this process would hold. A counter reading
   * compressed sizes would let a 250-byte answer become 200 KB — or a 100 KB
   * one become 100 MB — with nothing complaining.
   */
  it("counts a gzip body at its expanded size, not its compressed one", async () => {
    const payload = JSON.stringify({ filler: "x".repeat(200_000) });
    const gz = gzipSync(Buffer.from(payload));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gz);
    });
    const base = await listen(server);

    // a cap comfortably ABOVE what arrived on the wire and far BELOW what it
    // expands to: only a counter on the decoded bytes can trip on this
    expect(gz.byteLength).toBeLessThan(4096);
    await expect(
      getTextBounded(`${base}/manifest`, { label: "GET /manifest", timeoutMs: 5000, maxBytes: 4096 }),
    ).rejects.toThrow("GET /manifest broke the protocol: answered more than 4096 bytes");

    await shutdown(server);
  }, 15_000);

  /**
   * The byte cap has two halves, and only one of them is visible from inside
   * this process. That an oversized body THROWS is shown against the mock
   * above; that it STOPS ARRIVING can only be seen from the other end of the
   * socket, and it is the half the deployment actually depends on — a cap that
   * throws while the body keeps streaming in bounds the error message, not the
   * memory.
   *
   * So the assertion is the plugin's: it wrote nothing more once the app was
   * done, and it saw its socket close. Turning the reader's `cancel()` into a
   * `releaseLock()` leaves the throw intact and this test red.
   */
  it("stops the oversized body arriving, not merely the reading of it", async () => {
    const { server, state } = talkativePlugin(200);
    const base = await listen(server);

    // the deadline is long on purpose: if the socket closes, the cap closed it
    await expect(
      getTextBounded(`${base}/manifest`, { label: "GET /manifest", timeoutMs: 5000, maxBytes: 2048 }),
    ).rejects.toThrow("GET /manifest broke the protocol: answered more than 2048 bytes");
    state.gaveUp = true;

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.socketClosed).toBe(true);
    expect(state.bytesAfterGiveUp).toBe(0);

    await shutdown(server);
  }, 15_000);

  /**
   * The same half of the bound, on the path that abandons a response instead
   * of reading it. A plugin that answers 503 and keeps talking used to be left
   * attached: measured before the fix, the app threw after 37 ms and the
   * plugin pushed 99 KB more over the next 1.5 s with the socket still open,
   * because nothing but the AbortSignal deadline — ADAPTER_TIMEOUT_MS later,
   * per call — ever tore it down. Deleting the `discard(res)` before the throw
   * puts those bytes back and turns this red.
   */
  it("hangs up on a plugin whose answer it has already rejected", async () => {
    const { server, state } = talkativePlugin(503);
    const base = await listen(server);

    const failure = await getTextBounded(`${base}/search`, {
      label: "GET /search",
      timeoutMs: 5000,
      maxBytes: 8 * 1024 * 1024,
    }).catch((err: unknown) => err);
    state.gaveUp = true;
    expect(failure).toBeInstanceOf(PluginHttpError);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.socketClosed).toBe(true);
    expect(state.bytesAfterGiveUp).toBe(0);

    await shutdown(server);
  }, 15_000);
});

function req(label: string, overrides: { timeoutMs?: number; maxBytes?: number } = {}) {
  return { label, timeoutMs: 500, maxBytes: 1024 * 1024, ...overrides };
}
