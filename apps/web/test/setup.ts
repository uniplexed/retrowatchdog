import { beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { setSourcesForTests } from "../src/lib/sources.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";

// Every screen reads the source registry from the store (src/lib/sources.ts),
// and App.tsx loads it once at boot. Seeding it here with SOURCES_FIXTURE keeps each test's fetch stub about
// the thing that test is testing — many of them throw on an unexpected URL —
// and a test that cares about an IMPORTED source calls setSourcesForTests
// itself with whatever registry it wants. Registered before any test file's
// own hooks, so a file that resets the store afterwards still wins.
beforeEach(() => {
  setSourcesForTests(SOURCES_FIXTURE);
});
