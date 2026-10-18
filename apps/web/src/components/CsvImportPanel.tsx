import { useState } from "react";
import type {
  CsvImportRequest,
  CsvImportResponse,
  CsvImportRowBase,
  CsvRowError,
} from "@retrowatchdog/shared";
import { CsvImportError } from "../api/client.js";
import { CandidatePicker, chosenGameId, type ReviewChoice } from "./ImportReview.js";

/**
 * Shared CSV import flow for collection and watchlist: dryRun preview, then
 * confirm with includeRowIndexes + overrides. Duplicates are selectable in the
 * collection (a restore may re-add a copy) and disabled in the watchlist (the
 * unique constraint skips them anyway).
 */
export function CsvImportPanel<Row extends CsvImportRowBase>({
  send,
  rowMeta,
  duplicatesSelectable,
  duplicateNote,
  resultMessage,
  previewNote,
  onImported,
}: {
  /** the import POST for this screen (collection or watchlist client fn) */
  send: (req: CsvImportRequest) => Promise<CsvImportResponse<Row>>;
  /** meta text after a row's title (platform · region · condition · money) */
  rowMeta: (row: Row) => string;
  duplicatesSelectable: boolean;
  /** per-row note on flagged duplicates */
  duplicateNote: string;
  /** outcome line after a successful confirm */
  resultMessage: (res: CsvImportResponse<Row>) => string;
  /** extra line under the preview totals (e.g. the watchlist skip estimate) */
  previewNote?: (res: CsvImportResponse<Row>) => string | null;
  onImported: () => void;
}) {
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<CsvRowError[] | null>(null);
  const [preview, setPreview] = useState<CsvImportResponse<Row> | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [choices, setChoices] = useState<Record<number, ReviewChoice>>({});
  const [result, setResult] = useState<string | null>(null);

  const fail = (err: unknown, fallback: string): void => {
    setError(err instanceof Error ? err.message : fallback);
    if (err instanceof CsvImportError && err.rowErrors !== undefined) {
      setRowErrors(err.rowErrors);
    }
  };

  const runPreview = async (csv: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setRowErrors(null);
    setResult(null);
    setPreview(null);
    setChoices({});
    try {
      const res = await send({ csv, dryRun: true });
      setPreview(res);
      // mirrors the server default: matched non-duplicates
      setChecked(
        new Set(
          res.rows.filter((r) => r.matchStatus === "matched" && !r.duplicate).map((r) => r.rowIndex),
        ),
      );
    } catch (err) {
      fail(err, "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    // allow re-selecting the same (fixed) file to re-run the preview
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setFileName(file.name);
    await runPreview(text);
  };

  const matchedRows = preview?.rows.filter((r) => r.matchStatus === "matched") ?? [];
  const reviewRows = preview?.rows.filter((r) => r.matchStatus === "review") ?? [];
  const unsupported = preview?.rows.filter((r) => r.matchStatus === "unsupported_platform") ?? [];
  const unmatched = preview?.rows.filter((r) => r.matchStatus === "unmatched") ?? [];
  const unsupportedValues = [...new Set(unsupported.map((r) => r.platformValue))];

  // rowIndex (decimal string) -> chosen gameId
  const overrides: Record<string, number> = {};
  for (const row of reviewRows) {
    const chosen = chosenGameId(choices[row.rowIndex]);
    if (chosen !== null) overrides[String(row.rowIndex)] = chosen;
  }
  const importCount = checked.size + Object.keys(overrides).length;

  const runImport = async (): Promise<void> => {
    if (csvText === null) return;
    setBusy(true);
    setError(null);
    setRowErrors(null);
    try {
      const res = await send({
        csv: csvText,
        dryRun: false,
        // explicit: an empty selection must not fall back to the server default
        includeRowIndexes: [...checked],
        overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
      setResult(resultMessage(res));
      setPreview(null);
      setChoices({});
      onImported();
    } catch (err) {
      fail(err, "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (rowIndex: number): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  const setChoice = (rowIndex: number, choice: ReviewChoice | undefined): void => {
    setChoices((prev) => {
      const next = { ...prev };
      if (choice === undefined) delete next[rowIndex];
      else next[rowIndex] = choice;
      return next;
    });
  };

  const extraNote = preview && previewNote ? previewNote(preview) : null;

  return (
    <div className="source-block">
      <label className="source-note">
        CSV file{" "}
        <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} />
      </label>
      {fileName && <p className="source-note">{fileName}</p>}
      {busy && <p className="source-note">Analyzing CSV…</p>}
      {error && <p className="source-note">{error}</p>}
      {rowErrors && rowErrors.length > 0 && (
        <>
          <p className="source-note">
            Nothing was imported — fix these rows and re-select the file (row 1 = first data row):
          </p>
          {rowErrors.map((e, i) => (
            <p className="source-note" key={i}>
              Row {e.rowIndex + 1}: {e.column} — {e.message}
            </p>
          ))}
        </>
      )}
      {result && <p className="source-note">{result}</p>}
      {preview && (
        <>
          <p className="source-note">
            {preview.totals.matched} matched · {preview.totals.review} need review ·{" "}
            {preview.totals.unmatched} unmatched · {preview.totals.unsupported} unsupported
          </p>
          {extraNote && <p className="source-note">{extraNote}</p>}
          {matchedRows.length > 0 && <h4>Matched</h4>}
          {matchedRows.map((row) => (
            <div key={row.rowIndex}>
              <label className="source-note">
                <input
                  type="checkbox"
                  checked={checked.has(row.rowIndex)}
                  disabled={row.duplicate && !duplicatesSelectable}
                  onChange={() => toggle(row.rowIndex)}
                />{" "}
                {row.title} <span className="meta">{rowMeta(row)}</span>
                {/* the linked catalog title, when it adds information */}
                {row.game && (row.matchedBy !== "game_id" || row.game.title !== row.title) && (
                  <span className="meta"> → {row.game.title}</span>
                )}
                {row.duplicate && <span className="meta"> · {duplicateNote}</span>}
              </label>
            </div>
          ))}
          {reviewRows.length > 0 && (
            <>
              <h4>Import candidates</h4>
              <p className="source-note">
                These didn't match the catalog 100%. Pick the right game for each, or leave
                "Don't import".
              </p>
            </>
          )}
          {reviewRows.map((row) => (
            <div key={row.rowIndex}>
              <p className="source-note">
                {row.title} <span className="meta">{rowMeta(row)}</span>
              </p>
              <CandidatePicker
                rowKey={`csv-${row.rowIndex}`}
                platform={row.platform}
                candidates={row.candidates}
                choice={choices[row.rowIndex]}
                onChoice={(c) => setChoice(row.rowIndex, c)}
              />
            </div>
          ))}
          {unsupported.length > 0 && (
            <p className="source-note">
              {unsupported.length} rows with unsupported platform values (
              {unsupportedValues.join(", ")}) — see packages/shared/src/platforms.ts for the
              supported ids.
            </p>
          )}
          {unmatched.length > 0 && (
            <>
              <p className="source-note">No catalog match found for:</p>
              {unmatched.map((row) => (
                <p className="source-note" key={row.rowIndex}>
                  {row.title} <span className="meta">({row.platformValue})</span>
                </p>
              ))}
            </>
          )}
          <button onClick={() => void runImport()} disabled={busy || importCount === 0}>
            Import {importCount} items
          </button>
        </>
      )}
    </div>
  );
}
