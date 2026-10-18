import type { ReactNode } from "react";

/**
 * cover · title and meta · right-hand slot: the one list line every screen
 * uses. `cover: null` keeps the cover's place empty; omitting it drops it.
 */
export function Row({
  cover,
  title,
  meta,
  right,
  onClick,
  actions,
}: {
  cover?: string | null;
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  actions?: ReactNode;
}) {
  const body = (
    <>
      {cover === undefined ? null : cover ? <img src={cover} alt="" /> : <span className="ui-row-cover" />}
      <span className="ui-row-text">
        <span className="ui-row-title">{title}</span>
        {meta !== undefined && <span className="ui-row-meta">{meta}</span>}
      </span>
      {right !== undefined && <span className="ui-row-right">{right}</span>}
    </>
  );
  return (
    <div className="ui-row">
      {onClick === undefined ? (
        <div className="ui-row-body">{body}</div>
      ) : (
        <button type="button" className="ui-row-body" onClick={onClick}>
          {body}
        </button>
      )}
      {actions !== undefined && <div className="ui-row-actions">{actions}</div>}
    </div>
  );
}
