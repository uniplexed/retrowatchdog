import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards against a half-done package rename: the
// package manifest must carry the new scope, not just the import statements.
describe("package identity", () => {
  it("api package is named @retrowatchdog/api", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    expect(pkg.name).toBe("@retrowatchdog/api");
  });
});
