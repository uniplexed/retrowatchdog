import { BlockList, isIP } from "node:net";
import type { FastifyInstance } from "fastify";

/**
 * Three checks in front of every route, because the app has no accounts:
 * - a request from the plugins' network is refused: a plugin is untrusted
 *   code that shares a network with the api, and must not drive it;
 * - a Host the app does not answer to is refused: a DNS-rebinding page under
 *   an attacker's own domain could otherwise reach the api from a browser;
 * - a write sent from another site is refused (CSRF): a page elsewhere must
 *   not delete a collection with a form or a no-cors fetch.
 */

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** the Host header's name, without the port and the IPv6 brackets */
function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  return h.replace(/:\d+$/, "");
}

/**
 * IP literals, names without a dot (service names, a bare host name),
 * localhost and the configured public names. A rebinding attack needs a
 * dotted domain of its own, which is none of these.
 */
export function allowedHost(host: string | undefined, publicHosts: readonly string[]): boolean {
  if (!host) return false;
  const name = hostName(host);
  if (name === "") return false;
  if (isIP(name) !== 0) return true;
  if (name === "localhost" || !name.includes(".")) return true;
  return publicHosts.some((p) => hostName(p) === name);
}

export function inDeniedSubnet(address: string | undefined, subnets: readonly string[]): boolean {
  if (!address || subnets.length === 0) return false;
  const list = new BlockList();
  for (const cidr of subnets) {
    const [net, bits] = cidr.split("/");
    if (isIP(net) === 4) list.addSubnet(net, Number(bits), "ipv4");
    else if (isIP(net) === 6) list.addSubnet(net, Number(bits), "ipv6");
  }
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  const family = isIP(mapped) === 6 ? "ipv6" : "ipv4";
  return isIP(mapped) !== 0 && list.check(mapped, family);
}

/**
 * A request whose browser says it came from another site, or whose Origin is
 * not this host. Every method: a cross-site GET can still make this API work
 * (`?refresh=true` queries every plugin), and nothing legitimate is cross-site
 * because the API is same-origin only. Non-browser clients send neither header.
 */
export function crossSiteWrite(method: string, headers: Record<string, string | string[] | undefined>): boolean {
  void method;
  const site = headers["sec-fetch-site"];
  if (typeof site === "string") return site !== "same-origin" && site !== "none";
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "null") return typeof origin === "string";
  try {
    return hostName(new URL(origin).host) !== hostName(String(headers.host ?? ""));
  } catch {
    return true;
  }
}

export function guardRequests(app: FastifyInstance, opts: { publicHosts: readonly string[]; deniedSubnets: readonly string[] }): void {
  app.addHook("onRequest", async (req, reply) => {
    if (inDeniedSubnet(req.socket.remoteAddress ?? req.ip, opts.deniedSubnets)) {
      return reply.code(403).send({ error: "requests from the plugins' network are refused" });
    }
    if (!allowedHost(req.headers.host, opts.publicHosts)) {
      return reply.code(421).send({ error: "this host name is not one the app answers to; add it to PUBLIC_HOST" });
    }
    if (crossSiteWrite(req.method, req.headers)) {
      return reply.code(403).send({ error: "a change sent from another site is refused" });
    }
  });
}

/** "a.example, b.example" -> ["a.example", "b.example"] */
export const listOf = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
