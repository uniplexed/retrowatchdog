import { useEffect, useRef, useState } from "react";
import { PLATFORMS, type GameSummary } from "@retrowatchdog/shared";
import { useGameSearch } from "../lib/gameSearch.js";
import { Row } from "../ui/index.js";
import { modalOpen } from "../ui/modal.js";

/** a key typed into a field belongs to the field */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** The desktop top bar's search: results drop down under it; `/` focuses it from anywhere. */
export function GlobalSearch({ onSelect }: { onSelect: (game: GameSummary) => void }) {
  const [query, setQuery] = useState("");
  const { results, error } = useGameSearch(query);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // a click elsewhere puts the results away; typing brings them back
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent | PointerEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setDismissed(true);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // a sheet or dialog over the page owns the keyboard
      if (e.key !== "/" || isTyping(e.target) || modalOpen()) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const open = !dismissed && query.trim().length >= 2 && (results.length > 0 || error !== null);
  const choose = (game: GameSummary): void => {
    setQuery("");
    onSelect(game);
  };
  return (
    <div
      className="global-search"
      ref={box}
      // ↓ and ↑ walk input → results; ↑ from the first result returns to the input
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const stops = [input.current, ...(box.current?.querySelectorAll<HTMLElement>(".ui-row-body") ?? [])].filter(
          (x): x is HTMLElement => x !== null,
        );
        const at = stops.indexOf(document.activeElement as HTMLElement);
        if (at === -1 || stops.length < 2) return;
        e.preventDefault();
        stops[Math.max(0, Math.min(stops.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))].focus();
      }}
    >
      <input
        ref={input}
        aria-label="Search games"
        placeholder="Search a game…  /"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setDismissed(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
        }}
      />
      {open && (
        <div className="global-search-results" role="listbox" aria-label="Search results">
          {error !== null && <p className="source-note">{error}</p>}
          {results.map((game) => (
            <Row
              key={game.id}
              cover={game.coverUrl}
              title={game.title}
              meta={`${PLATFORMS[game.platform].label}${game.year ? ` · ${game.year}` : ""}`}
              onClick={() => choose(game)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
