import { defineConfig } from "vitest/config";

export default defineConfig({
  // fileParallelism MUST stay off: integration tests share one retrowatchdog_test
  // database and TRUNCATE in beforeEach — parallel files corrupt each other.
  test: {
    environment: "node",
    globals: false,
    fileParallelism: false,
    // USD base: live snapshots convert GBP->USD, so the whole suite gets a
    // rate-1 Frankfurter stub (see the file's comment for the rationale)
    setupFiles: ["./test/setup/globalFxMock.ts"],
    // The suite asserts behaviour at the code's own DEFAULTS, so a number this
    // deployment tunes in the gitignored root `.env` must not decide whether it
    // passes. `SIGNAL_MIN_SAMPLE` is the one that already did: the deployment
    // lowered it to 3 on 2026-09-17, and two collection-valuation tests assert
    // which source a copy's value came from under the default 5 — they failed
    // on a clean main with nothing wrong with the code. `config.ts` loads the
    // root `.env` through process.loadEnvFile, which never overrides a variable that is
    // already set, so this wins over it.
    // The worker's tracked refresh also calls the api next door (watchlist
    // alerts, the collection value snapshot) and ntfy: with the deployment's
    // `.env` a test run would read the LIVE api and notify the real topic.
    // Port 9 (discard) refuses fast; an empty topic turns alerts off.
    env: { SIGNAL_MIN_SAMPLE: "5", NTFY_TOPIC: "", API_INTERNAL_URL: "http://127.0.0.1:9" },
  },
});
