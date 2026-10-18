/**
 * Minimal RFC-4180-style CSV parser + serializer: quoted fields, doubled-quote
 * escapes, CRLF/LF/CR newlines, optional leading BOM.
 */

export class CsvParseError extends Error {
  /** 1-based line number where parsing failed */
  readonly line: number;
  constructor(message: string, line: number) {
    super(`CSV parse error on line ${line}: ${message}`);
    this.name = "CsvParseError";
    this.line = line;
  }
}

export interface ParsedCsv {
  /** first record; [] for empty input */
  header: string[];
  /** data records, in file order (blank lines skipped) */
  rows: string[][];
}

/** Parses CSV text into header + data rows. Throws CsvParseError on malformed quoting. */
export function parseCsv(text: string): ParsedCsv {
  // strip a single UTF-8 BOM (Excel and PowerShell exports carry one)
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  /** true once the current record has any content (field text or a comma) */
  let recordStarted = false;
  let line = 1;

  const endField = (): void => {
    // the export's formula guard (csvField) comes back off
    record.push(FORMULA_GUARDED.test(field) ? field.slice(1) : field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    recordStarted = false;
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      if (field.length > 0) throw new CsvParseError("quote in the middle of an unquoted field", line);
      // quoted field: consume until the closing quote; "" is an escaped quote
      i++;
      recordStarted = true;
      for (;;) {
        if (i >= input.length) throw new CsvParseError("unterminated quoted field", line);
        const q = input[i];
        if (q === '"') {
          if (input[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break; // closing quote
          }
        } else {
          if (q === "\n") line++;
          field += q;
          i++;
        }
      }
      const next = input[i];
      if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") {
        throw new CsvParseError("unexpected text after a closing quote", line);
      }
      continue;
    }
    if (ch === ",") {
      endField();
      recordStarted = true;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // record terminator (CRLF counts once); a bare newline between records
      // (blank line, trailing newline) produces no record
      if (recordStarted || field.length > 0) endRecord();
      if (ch === "\r" && input[i + 1] === "\n") i++;
      line++;
      i++;
      continue;
    }
    field += ch;
    recordStarted = true;
    i++;
  }
  if (recordStarted || field.length > 0) endRecord();

  const [header = [], ...rows] = records;
  return { header, rows };
}

/** a text field a spreadsheet would run as a formula (CSV injection) */
const FORMULA_START = /^[=+\-@|\t\r]/;
/** the same field once csvField has guarded it with a leading apostrophe */
const FORMULA_GUARDED = /^'[=+\-@|\t\r]/;

/**
 * Quotes one field per RFC 4180: commas, quotes and newlines force quoting;
 * quotes double. Text a spreadsheet would run (=, +, -, @) gets a leading
 * apostrophe so it opens as text; parseCsv takes it back off.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" && FORMULA_START.test(value) ? `'${value}` : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/** Serializes header + rows with CRLF record separators (RFC 4180) and a trailing newline. */
export function serializeCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

export interface HeaderProblems {
  missing: string[];
  unknown: string[];
}

/**
 * Validates a parsed header against an expected column SET (any order).
 * Returns null when valid; otherwise the missing/unknown names — a duplicated
 * column reports as unknown (its second occurrence is not an expected name).
 * Names in `optional` may be absent; when present they are expected names.
 */
export function validateHeader(
  actual: readonly string[],
  expected: readonly string[],
  optional: readonly string[] = [],
): HeaderProblems | null {
  const expectedSet = new Set<string>(expected);
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const name of actual) {
    if (!expectedSet.has(name) || seen.has(name)) unknown.push(name);
    seen.add(name);
  }
  const missing = expected.filter((name) => !seen.has(name) && !optional.includes(name));
  if (missing.length === 0 && unknown.length === 0) return null;
  return { missing, unknown };
}

/** Column-name -> index map for a validated header. */
export function headerIndex(header: readonly string[]): Map<string, number> {
  return new Map(header.map((name, i) => [name, i]));
}
