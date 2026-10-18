import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeControl } from "../src/ui/ThemeControl.js";
import { resetThemeForTests } from "../src/lib/theme.js";
import { stubMatchMedia } from "./helpers/matchMedia.js";

afterEach(() => {
  cleanup();
  resetThemeForTests();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeControl", () => {
  it("offers Light, Auto, Dark and marks the current one pressed", async () => {
    stubMatchMedia({ dark: false });
    render(<ThemeControl />);
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
