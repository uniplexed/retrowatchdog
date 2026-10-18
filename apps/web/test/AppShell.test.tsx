import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "../src/ui/AppShell.js";
import { resetThemeForTests } from "../src/lib/theme.js";
import { stubMatchMedia } from "./helpers/matchMedia.js";

afterEach(() => {
  cleanup();
  resetThemeForTests();
  vi.unstubAllGlobals();
});

const renderShell = (onNavigate = vi.fn(), notices: Parameters<typeof AppShell>[0]["notices"] = []) =>
  render(
    <AppShell title="Collection" active="collection" onNavigate={onNavigate} notices={notices} footer="refreshed 02:10">
      <p>page body</p>
    </AppShell>,
  );

describe("AppShell", () => {
  it("lists Dashboard in the sidebar, not in the tab bar", () => {
    stubMatchMedia({ desktop: true });
    renderShell();
    expect(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("button", { name: "Dashboard" })).toBeInTheDocument();
    cleanup();
    stubMatchMedia({ desktop: false });
    renderShell();
    const tabbar = document.querySelector(".tabbar") as HTMLElement;
    expect(within(tabbar).queryByRole("button", { name: "Dashboard" })).toBeNull();
  });

  it("the sidebar has Insights on desktop only", () => {
    stubMatchMedia({ desktop: true });
    renderShell();
    expect(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("button", { name: "Insights" })).toBeInTheDocument();
    cleanup();
    stubMatchMedia({ desktop: false });
    renderShell();
    expect(within(document.querySelector(".tabbar") as HTMLElement).queryByRole("button", { name: "Insights" })).toBeNull();
  });

  it("shows the page title in the top bar at both widths", () => {
    for (const desktop of [true, false]) {
      stubMatchMedia({ desktop });
      renderShell();
      const top = document.querySelector(".shell-top") as HTMLElement;
      expect(within(top).getByRole("heading", { level: 1, name: "Collection" })).toBeInTheDocument();
      cleanup();
    }
  });

  it("mounts a sidebar with the current section marked at desktop width", async () => {
    stubMatchMedia({ desktop: true });
    const onNavigate = vi.fn();
    renderShell(onNavigate);
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getByRole("button", { name: "Collection" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "Watchlist" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("refreshed 02:10")).toBeInTheDocument();
    expect(document.querySelector(".tabbar")).toBeNull();
    await userEvent.click(within(nav).getByRole("button", { name: "Watchlist" }));
    expect(onNavigate).toHaveBeenCalledWith("watchlist");
  });

  it("mounts a bottom tab bar below the breakpoint", () => {
    stubMatchMedia({ desktop: false });
    renderShell();
    const tabbar = document.querySelector(".tabbar") as HTMLElement;
    expect(within(tabbar).getByRole("button", { name: "Collection" })).toHaveClass("active");
    expect(within(tabbar).getByRole("button", { name: "Watch" })).not.toHaveClass("active");
    expect(document.querySelector(".shell-side")).toBeNull();
  });

  it("puts the currency and theme controls in the top bar at both widths", () => {
    for (const desktop of [true, false]) {
      stubMatchMedia({ desktop });
      renderShell();
      const top = document.querySelector(".shell-top") as HTMLElement;
      expect(within(top).getByRole("group", { name: "Theme" })).toBeInTheDocument();
      expect(within(top).getByRole("combobox")).toBeInTheDocument();
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("shows the status band under the top bar and the page body", () => {
    stubMatchMedia({ desktop: false });
    renderShell(vi.fn(), [{ id: "sources", text: "Source details unavailable" }]);
    expect(screen.getByRole("status")).toHaveTextContent("Source details unavailable");
    expect(screen.getByText("page body")).toBeInTheDocument();
  });
});
