import type { GameSummary, Recommendation } from "@retrowatchdog/shared";
import { subjectGame } from "../lib/insights.js";
import { formatMoney, useMoney } from "../lib/money.js";
import { Button, Row } from "../ui/index.js";
import type { ShellTab } from "../ui/AppShell.js";

/** One recommendation as a list line: what to do, why, and what it is worth. */
export function RecommendationRow({
  rec,
  onOpenGame,
  onNavigate,
}: {
  rec: Recommendation;
  onOpenGame: (game: GameSummary) => void;
  onNavigate: (tab: ShellTab) => void;
}) {
  useMoney(); // re-render on a display-currency change
  const game = subjectGame(rec);
  const target = rec.action === "raise_target" || rec.action === "lower_target";
  return (
    <Row
      cover={game?.coverUrl}
      title={rec.title}
      meta={rec.reason}
      right={rec.gainUsd === null ? undefined : formatMoney(rec.gainUsd)}
      onClick={game === null ? undefined : () => onOpenGame(game)}
      actions={
        target ? (
          <Button variant="ghost" size="sm" onClick={() => onNavigate("watchlist")}>
            Edit target
          </Button>
        ) : undefined
      }
    />
  );
}
