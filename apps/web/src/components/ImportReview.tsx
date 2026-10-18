import type { GameSummary, PcImportCandidate, Platform } from "@retrowatchdog/shared";
import { PLATFORMS } from "@retrowatchdog/shared";
import { GamePicker } from "./GamePicker.js";

/** A review row's decision in an import preview; undefined = "Don't import" (the default). */
export type ReviewChoice =
  | { kind: "candidate"; gameId: number }
  | { kind: "other"; game: GameSummary | null; searchOpen: boolean };

/** The gameId a choice resolves to; null while "Other…" has no pick yet. */
export function chosenGameId(choice: ReviewChoice | undefined): number | null {
  if (choice === undefined) return null;
  if (choice.kind === "candidate") return choice.gameId;
  return choice.game?.id ?? null;
}

/**
 * The candidates radio group for one review row, plus "Other…" and "Don't
 * import". Percentages are floored: a 0.999 near-miss must never claim 100%.
 */
export function CandidatePicker({
  rowKey,
  platform,
  candidates,
  choice,
  onChoice,
}: {
  /** unique radio-group key for this row (offerId, csv-<rowIndex>, ...) */
  rowKey: string;
  /** the row's detected platform — the picker's default console filter */
  platform: Platform | null;
  candidates: PcImportCandidate[];
  choice: ReviewChoice | undefined;
  onChoice: (choice: ReviewChoice | undefined) => void;
}) {
  return (
    <>
      {candidates.map((c) => (
        <div key={c.game.id}>
          <label className="source-note">
            <input
              type="radio"
              name={`pick-${rowKey}`}
              checked={choice?.kind === "candidate" && choice.gameId === c.game.id}
              onChange={() => onChoice({ kind: "candidate", gameId: c.game.id })}
            />{" "}
            {c.game.title} ({Math.floor(c.score * 100)}%
            {c.numeralMismatch ? ", number mismatch" : ""})
          </label>
        </div>
      ))}
      <div>
        <label className="source-note">
          <input
            type="radio"
            name={`pick-${rowKey}`}
            checked={choice?.kind === "other"}
            onChange={() => onChoice({ kind: "other", game: null, searchOpen: true })}
            onClick={() => {
              // re-clicking reopens the collapsed search
              if (choice?.kind === "other" && !choice.searchOpen) {
                onChoice({ ...choice, searchOpen: true });
              }
            }}
          />{" "}
          Other…
          {choice?.kind === "other" && choice.game !== null && (
            <span className="meta">
              {" "}
              → {choice.game.title} ({PLATFORMS[choice.game.platform].label})
            </span>
          )}
        </label>
      </div>
      {choice?.kind === "other" && choice.searchOpen && (
        <GamePicker
          defaultPlatform={platform}
          onPick={(g) => onChoice({ kind: "other", game: g, searchOpen: false })}
        />
      )}
      <div>
        <label className="source-note">
          <input
            type="radio"
            name={`pick-${rowKey}`}
            checked={choice === undefined}
            onChange={() => onChoice(undefined)}
          />{" "}
          Don't import
        </label>
      </div>
    </>
  );
}
