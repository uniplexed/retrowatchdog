import { describe, it, expect } from "vitest";
import { CsvParseError, csvField, headerIndex, parseCsv, serializeCsv, validateHeader } from "../../src/lib/csv.js";

describe("parseCsv", () => {
  it("parses a plain header + rows with LF newlines", () => {
    const { header, rows } = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(header).toEqual(["a", "b", "c"]);
    expect(rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });

  it("parses CRLF newlines and a lone CR as record terminators", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([["1", "2"]]);
    expect(parseCsv("a,b\r1,2\r").rows).toEqual([["1", "2"]]);
  });

  it("strips a single leading BOM", () => {
    const { header } = parseCsv("﻿a,b\n1,2\n");
    expect(header).toEqual(["a", "b"]);
  });

  it("handles quoted fields with commas, escaped quotes and embedded newlines", () => {
    const { rows } = parseCsv('a,b\n"one, two","say ""hi""\nnext line"\n');
    expect(rows).toEqual([['one, two', 'say "hi"\nnext line']]);
  });

  it("keeps empty fields, including a trailing one", () => {
    const { rows } = parseCsv("a,b,c\n,,\nx,,\n");
    expect(rows).toEqual([["", "", ""], ["x", "", ""]]);
  });

  it("skips blank lines and works without a trailing newline", () => {
    const { rows } = parseCsv("a,b\n\n1,2\n\n3,4");
    expect(rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("counts embedded newlines when reporting a later error's line", () => {
    // the quoted field spans lines 2-3; the malformed quote is on line 4
    expect(() => parseCsv('a\n"x\ny"\n"z"tail\n')).toThrowError(/line 4/);
  });

  it("throws CsvParseError on an unterminated quote", () => {
    expect(() => parseCsv('a,b\n"unclosed,2\n')).toThrowError(CsvParseError);
  });

  it("throws CsvParseError on text after a closing quote", () => {
    expect(() => parseCsv('a\n"x"y\n')).toThrowError(CsvParseError);
  });

  it("throws CsvParseError on a quote inside an unquoted field", () => {
    expect(() => parseCsv('a\nab"cd\n')).toThrowError(CsvParseError);
  });

  it("returns an empty header for empty input", () => {
    expect(parseCsv("")).toEqual({ header: [], rows: [] });
  });
});

describe("csvField / serializeCsv", () => {
  it("quotes only when needed and doubles embedded quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(12.5)).toBe("12.5");
  });

  it("round-trips its own output through parseCsv (comma+quote+newline torture row)", () => {
    const header = ["id", "notes", "empty"];
    const rows = [
      ["1", 'has, comma and "quotes"\nand a newline', ""],
      ["2", "plain", null],
    ];
    const text = serializeCsv(header, rows);
    const parsed = parseCsv(text);
    expect(parsed.header).toEqual(header);
    expect(parsed.rows).toEqual([
      ["1", 'has, comma and "quotes"\nand a newline', ""],
      ["2", "plain", ""],
    ]);
  });
});

describe("validateHeader", () => {
  const expected = ["a", "b", "c"] as const;

  it("accepts the exact set in any order", () => {
    expect(validateHeader(["a", "b", "c"], expected)).toBeNull();
    expect(validateHeader(["c", "a", "b"], expected)).toBeNull();
  });

  it("reports missing and unknown columns", () => {
    expect(validateHeader(["a", "x"], expected)).toEqual({ missing: ["b", "c"], unknown: ["x"] });
  });

  it("reports a duplicated known column as unknown", () => {
    expect(validateHeader(["a", "b", "c", "b"], expected)).toEqual({ missing: [], unknown: ["b"] });
  });
});

describe("headerIndex", () => {
  it("maps names to positions", () => {
    const idx = headerIndex(["x", "y"]);
    expect(idx.get("x")).toBe(0);
    expect(idx.get("y")).toBe(1);
  });
});

describe("formula injection", () => {
  it("a text field that a spreadsheet would run is exported as text", () => {
    for (const v of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "	cmd"]) {
      expect(csvField(v).replace(/^"|"$/g, "").startsWith("'"), v).toBe(true);
    }
    expect(csvField(-5)).toBe("-5");
    expect(csvField("Zelda")).toBe("Zelda");
  });

  it("the app's own export reads back unchanged", () => {
    const out = serializeCsv(["notes"], [["=cheap one"], ["-mint"]]);
    expect(parseCsv(out).rows).toEqual([["=cheap one"], ["-mint"]]);
  });
});

