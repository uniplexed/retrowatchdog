import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { allowedHost, guardRequests, inDeniedSubnet, crossSiteWrite } from "../../src/security/requestGuard.js";

describe("allowedHost", () => {
  const publicHosts = ["retro.example.com", "myhost"];
  it("accepts IP literals, names without a dot, localhost and the configured names", () => {
    for (const host of ["192.168.1.20", "192.168.1.20:443", "[::1]", "[fe80::1]:80", "localhost", "localhost:5173", "api:3001", "retro.example.com", "RETRO.example.com:443", "myhost"]) {
      expect(allowedHost(host, publicHosts), host).toBe(true);
    }
  });

  it("refuses any other dotted name: a rebinding attacker's own domain", () => {
    for (const host of ["evil.example.net", "retro.example.com.evil.net", "", "192.168.1.20.nip.io"]) {
      expect(allowedHost(host, publicHosts), host).toBe(false);
    }
  });
});

describe("inDeniedSubnet", () => {
  it("matches IPv4 and IPv4-mapped IPv6 addresses inside a denied subnet", () => {
    expect(inDeniedSubnet("172.31.250.7", ["172.31.250.0/24"])).toBe(true);
    expect(inDeniedSubnet("::ffff:172.31.250.7", ["172.31.250.0/24"])).toBe(true);
    expect(inDeniedSubnet("172.31.251.7", ["172.31.250.0/24"])).toBe(false);
    expect(inDeniedSubnet("127.0.0.1", [])).toBe(false);
  });
});

describe("crossSiteWrite", () => {
  it("only a write from another site is cross-site", () => {
    // a cross-site GET is refused too: `?refresh=true` makes the API call every plugin
    expect(crossSiteWrite("GET", { "sec-fetch-site": "cross-site" })).toBe(true);
    expect(crossSiteWrite("GET", { "sec-fetch-site": "same-origin" })).toBe(false);
    expect(crossSiteWrite("GET", {})).toBe(false);
    expect(crossSiteWrite("POST", { "sec-fetch-site": "cross-site" })).toBe(true);
    expect(crossSiteWrite("DELETE", { "sec-fetch-site": "same-site" })).toBe(true);
    expect(crossSiteWrite("POST", { "sec-fetch-site": "same-origin" })).toBe(false);
    expect(crossSiteWrite("POST", { "sec-fetch-site": "none" })).toBe(false);
    expect(crossSiteWrite("POST", { origin: "https://evil.example.net", host: "localhost" })).toBe(true);
    expect(crossSiteWrite("POST", { origin: "https://localhost", host: "localhost" })).toBe(false);
    // the worker and scripts send neither header
    expect(crossSiteWrite("POST", { host: "api:3001" })).toBe(false);
  });
});

describe("guardRequests on a server", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());
  const build = async () => {
    app = Fastify();
    guardRequests(app, { publicHosts: ["retro.example.com"], deniedSubnets: ["172.31.250.0/24"] });
    app.get("/api/x", async () => ({ ok: true }));
    app.delete("/api/x", async () => ({ ok: true }));
    await app.ready();
    return app;
  };

  it("a plugin on the sidecar network gets 403", async () => {
    const res = await (await build()).inject({ method: "GET", url: "/api/x", remoteAddress: "172.31.250.9", headers: { host: "api:3001" } });
    expect(res.statusCode).toBe(403);
  });

  it("a rebinding domain gets 421, the app's own name passes", async () => {
    const s = await build();
    expect((await s.inject({ method: "GET", url: "/api/x", headers: { host: "evil.example.net" } })).statusCode).toBe(421);
    expect((await s.inject({ method: "GET", url: "/api/x", headers: { host: "retro.example.com" } })).statusCode).toBe(200);
  });

  it("a cross-site write gets 403, a same-origin one passes", async () => {
    const s = await build();
    const cross = await s.inject({ method: "DELETE", url: "/api/x", headers: { host: "localhost", "sec-fetch-site": "cross-site" } });
    const same = await s.inject({ method: "DELETE", url: "/api/x", headers: { host: "localhost", "sec-fetch-site": "same-origin" } });
    expect(cross.statusCode).toBe(403);
    expect(same.statusCode).toBe(200);
  });
});
