import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The sidecar's isolation, asserted against the file that grants it.
 *
 * docs/sidecar-protocol.md, README.md and the compose file's own comments all
 * promise a community sidecar "no database access and no app credentials".
 * Withholding the credentials achieves that only while the data is out of
 * reach WITHOUT them: the Postgres user and password are literals in this same
 * compose file and Redis has no password at all, so a sidecar sharing a
 * network with either could open its own socket and read or rewrite every
 * stored price. The promise therefore has to be a topology, not a comment —
 * and a topology is exactly the kind of thing that gets undone by a later
 * edit that "just adds a service", which is why it is pinned here.
 *
 * This is a text assertion rather than a `docker compose config` one on
 * purpose: the test suite must not need a Docker daemon, and what is being
 * pinned is the declaration in the repository, which is what a reviewer reads.
 */
const COMPOSE = readFileSync(fileURLToPath(new URL("../../../../docker-compose.yml", import.meta.url)), "utf8");

/** Each service's declared networks, read off the file by indentation. */
function networksByService(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let inServices = false;
  let service: string | null = null;
  let collecting = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith("services:");
      service = null;
      collecting = false;
      continue;
    }
    if (!inServices) continue;
    const named = /^ {2}([\w.-]+):\s*$/.exec(line);
    if (named) {
      service = named[1];
      out.set(service, []);
      collecting = false;
      continue;
    }
    if (service === null) continue;
    if (/^ {4}networks:\s*$/.test(line)) {
      collecting = true;
      continue;
    }
    if (collecting) {
      const item = /^ {6}- ([\w.-]+)\s*$/.exec(line);
      if (item) out.get(service)?.push(item[1]);
      else if (/^ {4}\S/.test(line)) collecting = false;
    }
  }
  return out;
}

/** One service's own lines, so a key can be asserted absent from it. */
function serviceBlock(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `service ${name} is declared`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {0,2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("the compose topology the sidecar's isolation rests on", () => {
  const networks = networksByService(COMPOSE);

  it("gives every service an explicit network, so nothing lands on a shared default", () => {
    // With no `networks:` key compose puts every service on ONE default
    // bridge: the sidecar could then resolve `postgres` and `redis` by name.
    // An explicit list per service is what makes the segmentation real, and a
    // service added later without one would silently re-create that bridge.
    for (const [service, joined] of networks) {
      expect(joined, `${service} declares its networks`).not.toEqual([]);
    }
  });

  it("keeps the sidecar off the network the database and the queue are on", () => {
    expect(networks.get("vinted-sidecar-plugin")).toEqual(["sidecars"]);
    expect(networks.get("wallapop-sidecar-plugin")).toEqual(["sidecars"]);
    for (const store of ["postgres", "redis"]) {
      expect(networks.get(store), `${store} is not on the sidecar network`).not.toContain("sidecars");
    }
  });

  it("puts the api and worker on both, since only they talk to a sidecar", () => {
    for (const caller of ["api", "worker"]) {
      expect(networks.get(caller), `${caller} reaches the data`).toContain("backend");
      expect(networks.get(caller), `${caller} reaches the sidecars`).toContain("sidecars");
    }
  });

  it("publishes no host port for the sidecar and hands it only its own env file", () => {
    // The other two halves of the same promise: nothing on the host or the LAN
    // can reach it, and it holds none of the app's keys.
    for (const [name, file] of [["vinted-sidecar-plugin", "vinted"], ["wallapop-sidecar-plugin", "wallapop"]]) {
      const block = serviceBlock(COMPOSE, name);
      expect(block, name).not.toMatch(/^ {4}ports:/m);
      expect(block, name).toMatch(new RegExp(`^ {6}- path: \\.env\\.${file}$`, "m"));
      expect(block, name).not.toMatch(/^ {6}- path: \.env$/m);
      expect(block, name).not.toMatch(/^ {4}volumes:/m);
    }
  });

  it("gives the eBay plugin its own env file and nothing of the app's", () => {
    // The existing env_file assertion above is scoped to the literal string
    // "vinted-sidecar-plugin", so a new service pointed at the ROOT .env — handing a
    // plugin the DATABASE_URL, the IGDB secret and everything else — passes
    // that test today. This is the assertion that refuses it. (The "explicit
    // network" test above already iterates every service including this one,
    // so a missing `networks:` key here is caught there, not duplicated.)
    const block = serviceBlock(COMPOSE, "ebay-plugin");
    expect(block).toMatch(/^ {6}- path: \.env\.ebay$/m);
    expect(block).not.toMatch(/^ {6}- path: \.env$/m);
    expect(block).not.toMatch(/^ {4}ports:/m);
    expect(block).not.toMatch(/^ {4}volumes:/m);
  });

  it("keeps the eBay plugin off the network the database and the queue are on", () => {
    expect(networks.get("ebay-plugin")).toEqual(["sidecars"]);
  });

  it("keeps app credentials and connection strings out of every sidecar/plugin's environment: block", () => {
    // Found by adversarial review: the two tests above assert the RIGHT
    // env_file path and the RIGHT networks list, but neither one — nor any
    // other test in this file — would catch a credential handed to a plugin
    // through a bare `environment:` block instead, which is a real,
    // separate leak (visible to anything with docker exec/inspect access to
    // that container) that the network topology alone does not prevent. A
    // non-secret config value in `environment:` is fine and already ships
    // today (vinted-sidecar-plugin's SIDECAR_SOURCE, VINTED_BASE_URL) — what must
    // never appear there, in EITHER service, is the app's own database/queue
    // connection string or a third-party credential name.
    for (const name of ["vinted-sidecar-plugin", "wallapop-sidecar-plugin", "ebay-plugin"]) {
      const block = serviceBlock(COMPOSE, name);
      expect(block, `${name} carries no DATABASE_URL`).not.toMatch(/DATABASE_URL/);
      expect(block, `${name} carries no REDIS_URL`).not.toMatch(/REDIS_URL/);
      expect(block, `${name} carries no app secret or key`).not.toMatch(/_SECRET|_CLIENT_ID|_KEY\b/);
    }
  });

  it("publishes no port for the stores or the api: only the web container is reachable", () => {
    // On Docker Desktop a published loopback port is reachable from any
    // container through the host gateway, which would hand a plugin the
    // database. Development publishes them through docker-compose.dev.yml.
    for (const service of ["postgres", "redis", "api", "worker"]) {
      expect(serviceBlock(COMPOSE, service), service).not.toMatch(/^ {4}ports:/m);
    }
    const dev = readFileSync(fileURLToPath(new URL("../../../../docker-compose.dev.yml", import.meta.url)), "utf8");
    for (const port of ["127.0.0.1:5432:5432", "127.0.0.1:6379:6379", "127.0.0.1:3001:3001"]) {
      expect(dev).toContain(port);
    }
  });

  it.skip("binds the data stores' published ports to loopback", () => {
    // They are published for host-side dev servers and the api test suite,
    // which all connect over 127.0.0.1. Published on every interface they are
    // reachable from the LAN with the credentials this file states in clear —
    // and, on a Docker Desktop host, from any container via the host gateway,
    // which would give a segmented sidecar its route back.
    for (const store of ["postgres", "redis"]) {
      const block = serviceBlock(COMPOSE, store);
      const published = [...block.matchAll(/^ {6}- "([^"]+)"\s*$/gm)].map((m) => m[1]);
      expect(published.length, `${store} publishes a port`).toBeGreaterThan(0);
      for (const mapping of published) {
        expect(mapping, `${store} publishes on loopback only`).toMatch(/^127\.0\.0\.1:/);
      }
    }
  });
});
