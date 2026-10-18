import { VERDICT_EMPTY_TITLE, type Verdict as VerdictData } from "@retrowatchdog/shared";
import { Button } from "./Button.js";

/**
 * The card a game leads with: its best high-confidence signal as one title,
 * one reason and one action. Null renders the honest empty state.
 */
export function Verdict({ verdict, onEditWatch }: { verdict: VerdictData | null; onEditWatch?: () => void }) {
  if (verdict === null) {
    return (
      <section className="ui-verdict" data-tone="neutral">
        <h3 className="ui-verdict-title">{VERDICT_EMPTY_TITLE}</h3>
      </section>
    );
  }
  const action = verdict.action;
  return (
    <section className="ui-verdict" data-tone={verdict.tone}>
      <span className="ui-verdict-kicker">{verdict.tone === "avoid" ? "Hold off" : "Best move today"}</span>
      <h3 className="ui-verdict-title">{verdict.title}</h3>
      <p className="ui-verdict-reason">{verdict.reason}</p>
      {action !== undefined && "url" in action && (
        <a className="ui-btn ui-btn-primary ui-btn-md" href={action.url} target="_blank" rel="noreferrer">
          {action.label}
        </a>
      )}
      {action !== undefined && "kind" in action && onEditWatch !== undefined && (
        <Button variant="primary" onClick={onEditWatch}>
          {action.label}
        </Button>
      )}
    </section>
  );
}
