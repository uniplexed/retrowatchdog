import { Button } from "./Button.js";

export interface Notice {
  id: string;
  text: string;
  action?: { label: string; onClick: () => void };
}

/** The one strip under the top bar for app-wide notices; nothing when there are none. */
export function StatusBand({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="ui-band" role="status">
      {notices.map((n) => (
        <p key={n.id}>
          <span>{n.text}</span>
          {n.action !== undefined && (
            <Button size="sm" onClick={n.action.onClick}>
              {n.action.label}
            </Button>
          )}
        </p>
      ))}
    </div>
  );
}
