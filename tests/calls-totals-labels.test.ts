import { describe, expect, spyOn, test } from "bun:test";
import type { CallRecord } from "../src/call-log.js";
import { printTotals } from "../src/calls-totals.js";
import { BASE_RECORD } from "./helpers/call-log.js";

function headings(values: Array<string | null>, by = "wf"): string[] {
  const records: CallRecord[] = values.map((value) => ({
    ...BASE_RECORD, labels: value === null ? null : { [by]: value },
  }));
  const lines: string[] = [];
  const output = spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
  try {
    printTotals(records, by);
    return lines.map((line) => line.split(" over ")[0]!);
  } finally {
    output.mockRestore();
  }
}

describe("label totals rendering", () => {
  // One escaper for every human-readable string (escapeForTerminal's
  // \xNN form, audit round 2, B14); --json keeps its own \uXXXX forms.
  test("every C0, DEL, and C1 character uses a visible lowercase \\xNN escape", () => {
    const codes = [...Array.from({ length: 32 }, (_, i) => i),
      ...Array.from({ length: 33 }, (_, i) => i + 0x7f)];
    const values = codes.map((code) => `a${String.fromCharCode(code)}b`);
    expect(headings(values)).toEqual(codes.map((code) =>
      `Totals for wf=a\\x${code.toString(16).padStart(2, "0")}b`));
  });

  test("ANSI bodies and carriage returns are escaped without deleting text", () => {
    expect(headings(["safe\rFORGED\u001b[2K"])).toEqual([
      "Totals for wf=safe\\x0dFORGED\\x1b[2K",
    ]);
  });

  test("controls print in the shared \\xNN form; literal escape text stays as typed", () => {
    // The heading no longer doubles backslashes, so the rendered control
    // (`a\x1bb`) and a literal "\x1b" typed into a label differ only the
    // way any two strings do; disambiguating them is --json's job, which
    // keeps the \uXXXX spellings.
    const rendered = headings(["ab", "a\u001bb", "a\\x1bb", "a\\u001bb"]);
    expect(rendered).toEqual([
      "Totals for wf=ab", "Totals for wf=a\\x1bb", "Totals for wf=a\\x1bb",
      "Totals for wf=a\\u001bb",
    ]);
  });

  test("keys are escaped in both labeled and missing-label headings", () => {
    // Built with fromCharCode: the equivalent single literal (a U+009B
    // beside a U+001B) trips a Bun 1.4.4 transpiler offset bug that
    // fails the parse of this line; the rendering is under test, not
    // the spelling.
    const key = `w${String.fromCharCode(0x9b)}f${String.fromCharCode(0x1b)}[2K`;
    expect(headings(["value", null], key)).toEqual([
      "Totals for w\\x9bf\\x1b[2K=value",
      "Totals for records without label w\\x9bf\\x1b[2K",
    ]);
  });

  test("printable Unicode, spaces, punctuation, and empty values stay intact", () => {
    expect(headings(["中文 😀, a=b", "", "(none)", null])).toEqual([
      "Totals for wf=中文 😀, a=b", "Totals for wf=", "Totals for wf=(none)",
      "Totals for records without label wf",
    ]);
  });
});
