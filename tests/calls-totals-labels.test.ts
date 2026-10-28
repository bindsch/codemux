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
  test("every C0, DEL, and C1 character uses a visible lowercase Unicode escape", () => {
    const codes = [...Array.from({ length: 32 }, (_, i) => i),
      ...Array.from({ length: 33 }, (_, i) => i + 0x7f)];
    const values = codes.map((code) => `a${String.fromCharCode(code)}b`);
    expect(headings(values)).toEqual(codes.map((code) =>
      `Totals for wf=a\\u${code.toString(16).padStart(4, "0")}b`));
  });

  test("ANSI bodies and carriage returns are escaped without deleting text", () => {
    expect(headings(["safe\rFORGED\u001b[2K"])).toEqual([
      "Totals for wf=safe\\u000dFORGED\\u001b[2K",
    ]);
  });

  test("controls, stripped values, and literal escape text print differently", () => {
    const rendered = headings(["ab", "a\u001bb", "a\\u001bb", "a\u009bb", "a\\u009bb"]);
    expect(rendered).toEqual([
      "Totals for wf=ab", "Totals for wf=a\\u001bb", "Totals for wf=a\\\\u001bb",
      "Totals for wf=a\\u009bb", "Totals for wf=a\\\\u009bb",
    ]);
    expect(new Set(rendered).size).toBe(5);
  });

  test("keys are escaped in both labeled and missing-label headings", () => {
    expect(headings(["value", null], "w\u009bf\u001b[2K")).toEqual([
      "Totals for w\\u009bf\\u001b[2K=value",
      "Totals for records without label w\\u009bf\\u001b[2K",
    ]);
  });

  test("printable Unicode, spaces, punctuation, and empty values stay intact", () => {
    expect(headings(["中文 😀, a=b", "", "(none)", null])).toEqual([
      "Totals for wf=中文 😀, a=b", "Totals for wf=", "Totals for wf=(none)",
      "Totals for records without label wf",
    ]);
  });
});
