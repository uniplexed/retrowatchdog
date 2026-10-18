import { afterEach, describe, expect, it, vi } from "vitest";
import { loadThemePreference, resetThemeForTests, resolveTheme, setThemePreference } from "../src/lib/theme.js";
import { stubMatchMedia } from "./helpers/matchMedia.js";

const themeColor = (): string | null | undefined =>
  document.querySelector('meta[name="theme-color"]')?.getAttribute("content");

afterEach(() => {
  resetThemeForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("theme", () => {
  it("defaults to auto and resolves from the system", () => {
    stubMatchMedia({ dark: true });
    expect(loadThemePreference()).toBe("auto");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("persists a manual choice and sets the html attribute and theme-color", () => {
    stubMatchMedia({ dark: false });
    setThemePreference("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeColor()).toBe("#0b1220");
    setThemePreference("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(themeColor()).toBe("#f4f6f9");
  });

  it("auto follows a prefers-color-scheme change", () => {
    const { dark } = stubMatchMedia({ dark: false });
    setThemePreference("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
    dark.emit(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a manual choice ignores later system changes", () => {
    const { dark } = stubMatchMedia({ dark: false });
    setThemePreference("light");
    dark.emit(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores an unknown stored value", () => {
    stubMatchMedia({ dark: false });
    localStorage.setItem("theme", "sepia");
    expect(loadThemePreference()).toBe("auto");
  });

  it("survives a throwing localStorage", () => {
    stubMatchMedia({ dark: false });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadThemePreference()).toBe("auto");
    expect(() => setThemePreference("dark")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
