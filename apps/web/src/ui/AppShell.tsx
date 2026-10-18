import type { ReactNode } from "react";
import type { HelpTopic } from "../lib/help.js";
import { InfoTip } from "./InfoTip.js";
import { CurrencySelector } from "../components/CurrencySelector.js";
import { useViewport } from "../lib/viewport.js";
import { StatusBand, type Notice } from "./StatusBand.js";
import { ThemeControl } from "./ThemeControl.js";

export type ShellTab = "dashboard" | "insights" | "search" | "watchlist" | "collection" | "settings";

/** sidebar labels on desktop, shorter tab labels on the phone */
const SECTIONS: Array<{ tab: ShellTab; label: string; short: string; desktopOnly?: boolean }> = [
  { tab: "dashboard", label: "Dashboard", short: "Dashboard", desktopOnly: true },
  { tab: "insights", label: "Insights", short: "Insights", desktopOnly: true },
  { tab: "search", label: "Search", short: "Search" },
  { tab: "watchlist", label: "Watchlist", short: "Watch" },
  { tab: "collection", label: "Collection", short: "Collection" },
  { tab: "settings", label: "Settings", short: "Settings" },
];

/**
 * The frame around every screen. Desktop: a sidebar with the sections and a
 * footer line, a top bar with the currency and theme controls. Phone: the same
 * top bar and a bottom tab bar. The status band sits under the top bar.
 */
export function AppShell({
  title,
  info,
  active,
  onNavigate,
  notices,
  footer,
  search,
  children,
}: {
  /** the page's name, shown at the left of the top bar */
  title: string;
  /** an ⓘ explaining the page */
  info?: HelpTopic;
  active: ShellTab;
  onNavigate: (tab: ShellTab) => void;
  notices: Notice[];
  footer?: ReactNode;
  /** the global search box, shown in the desktop top bar */
  search?: ReactNode;
  children: ReactNode;
}) {
  const desktop = useViewport() === "desktop";
  // One tree for both widths: the sidebar and the tab bar are conditional
  // siblings around a <main> that keeps its position, so crossing the
  // breakpoint never remounts the screen (and never loses its state).
  return (
    <div className={desktop ? "shell shell-desktop" : "shell shell-mobile"}>
      {desktop && (
        <aside className="shell-side">
          <div className="shell-brand">
            <img className="app-logo" src="/dog-logo.png" alt="" />
            <span>RetroWatchdog</span>
          </div>
          <nav aria-label="Sections">
            {SECTIONS.map((s) => (
              <button
                key={s.tab}
                type="button"
                aria-current={active === s.tab ? "page" : undefined}
                className={active === s.tab ? "active" : ""}
                onClick={() => onNavigate(s.tab)}
              >
                {s.label}
              </button>
            ))}
          </nav>
          {footer !== undefined && <div className="shell-foot">{footer}</div>}
        </aside>
      )}
      <div className="shell-main">
        <header className="shell-top">
          <h1 className="shell-title">{title}</h1>
          {info !== undefined && <InfoTip topic={info} />}
          <div className="shell-controls">
            {desktop && search}
            <CurrencySelector />
            <ThemeControl />
          </div>
        </header>
        <StatusBand notices={notices} />
        <main className={desktop ? "shell-content" : "container"}>{children}</main>
      </div>
      {!desktop && (
        <nav className="tabbar" aria-label="Sections">
          {SECTIONS.filter((s) => !s.desktopOnly).map((s) => (
            <button
              key={s.tab}
              type="button"
              className={active === s.tab ? "active" : ""}
              onClick={() => onNavigate(s.tab)}
            >
              {s.short}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
