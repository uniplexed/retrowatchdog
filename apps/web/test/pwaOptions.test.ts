import { describe, it, expect } from "vitest";
import { pwaOptions, servedByNavigationFallback } from "../src/pwaOptions.js";

/**
 * The service worker's navigation fallback serves index.html for every
 * navigation request unless the URL is denylisted. A click on
 * `<a href="/api/collection/export" download>` IS a navigation request, so
 * without the denylist an installed PWA hands the user the app shell (an
 * HTML file named like a CSV) instead of the API's CSV — measured by the
 * user on 2026-09-02. curl and a browser without the worker never see it.
 */
describe("pwaOptions navigation fallback", () => {
  it("never serves the app shell for API urls (CSV exports and every other /api/ path)", () => {
    expect(servedByNavigationFallback("/api/collection/export")).toBe(false);
    expect(servedByNavigationFallback("/api/watchlist/export")).toBe(false);
    expect(servedByNavigationFallback("/api/games/128/prices?refresh=true")).toBe(false);
  });

  it("still serves the app shell for app routes so deep links and reloads keep working offline", () => {
    expect(servedByNavigationFallback("/")).toBe(true);
    expect(servedByNavigationFallback("/collection")).toBe(true);
    expect(servedByNavigationFallback("/index.html")).toBe(true);
  });

  it("declares the denylist on the workbox options that generate the worker", () => {
    const denylist = pwaOptions.workbox?.navigateFallbackDenylist ?? [];
    expect(denylist.length).toBeGreaterThan(0);
    expect(denylist.some((re) => re.test("/api/collection/export"))).toBe(true);
  });
});
