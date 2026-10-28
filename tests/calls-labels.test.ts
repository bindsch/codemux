import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CALL_LOG_ENV } from "../src/call-log.js";
import { runCli } from "./helpers/cli.js";

interface RecordSpec {
  model: string;
  labels?: Record<string, string> | null;
  kind?: "run" | "session_turn" | "session";
  sessionId?: string;
  input?: number | null;
  cost?: number | null;
}

function record(spec: RecordSpec): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    kind: spec.kind ?? "run",
    agent: "claude",
    model: spec.model,
    model_effective: null,
    provider: "default",
    session_id: spec.sessionId ?? null,
    turn_id: null,
    autonomy: "read-only",
    hermetic: false,
    sandboxed: false,
    exit_code: 0,
    finish: null,
    duration_ms: 10,
    cwd: "/repo",
    ...(spec.labels === undefined ? {} : { labels: spec.labels }),
    usage: {
      input_tokens: spec.input ?? null,
      cached_input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cost_usd: spec.cost ?? null,
    },
  });
}

async function callsWith(
  specs: Array<RecordSpec | string>,
  args: string[],
  environment: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scratch = join(import.meta.dir, "..", "scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "calls-labels-"));
  try {
    const path = join(dir, "calls.jsonl");
    writeFileSync(path, `${specs.map((spec) => typeof spec === "string" ? spec : record(spec)).join("\n")}\n`);
    return await runCli(["calls", ...args], {
      CODEMUX_LABELS: "",
      ...environment,
      [CALL_LOG_ENV]: path,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonRecords(stdout: string): Array<{ model: string }> {
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("codemux calls labels", () => {
  test("repeated label filters use AND before the record limit", async () => {
    const result = await callsWith([
      { model: "old-match", labels: { project: "alpha", task: "build" } },
      { model: "wrong-task", labels: { project: "alpha", task: "review" } },
      { model: "new-match", labels: { project: "alpha", task: "build" } },
      { model: "wrong-project", labels: { project: "beta", task: "build" } },
    ], ["--label", "project=alpha", "--label", "task=build", "-n", "1", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(jsonRecords(result.stdout).map((entry) => entry.model)).toEqual(["new-match"]);
  });

  test("duplicate filter keys fail with usage exit code 64", async () => {
    const result = await callsWith([
      { model: "alpha", labels: { project: "alpha" } },
      { model: "beta", labels: { project: "beta" } },
    ], ["--label", "project=alpha", "--label", "project=beta", "--json"]);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error:");
  });

  test("records with null or missing labels never match a label filter", async () => {
    const result = await callsWith([
      { model: "legacy" },
      { model: "null-labels", labels: null },
      { model: "missing-key", labels: { task: "build" } },
      { model: "match", labels: { project: "alpha" } },
    ], ["--label", "project=alpha", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(jsonRecords(result.stdout).map((entry) => entry.model)).toEqual(["match"]);
  });

  test("label values preserve equal signs", async () => {
    const result = await callsWith([
      { model: "exact", labels: { task: "build=fast" } },
      { model: "other", labels: { task: "fast" } },
    ], ["--label", "task=build=fast", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(jsonRecords(result.stdout).map((entry) => entry.model)).toEqual(["exact"]);
  });

  test("calls ignores CODEMUX_LABELS when no filter is supplied", async () => {
    const result = await callsWith([
      { model: "unlabeled" },
      { model: "labeled", labels: { project: "alpha" } },
    ], ["--json"], { CODEMUX_LABELS: "invalid environment labels" });
    expect(result.exitCode).toBe(0);
    expect(jsonRecords(result.stdout).map((entry) => entry.model)).toEqual(["labeled", "unlabeled"]);
  });

  test("explicit filters ignore CODEMUX_LABELS defaults", async () => {
    const result = await callsWith([
      { model: "match", labels: { project: "alpha" } },
    ], ["--label", "project=alpha", "--json"], { CODEMUX_LABELS: "task=review" });
    expect(result.exitCode).toBe(0);
    expect(jsonRecords(result.stdout).map((entry) => entry.model)).toEqual(["match"]);
  });

  test("invalid label filters fail with usage exit code 64", async () => {
    for (const label of ["project", "Project=alpha", "project=bad\nvalue"]) {
      const result = await callsWith([{ model: "record" }], ["--label", label]);
      expect(result.exitCode).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Error:");
    }
  });

  test("empty label values match only explicitly stored empty values", async () => {
    const result = await callsWith([
      { model: "legacy" },
      { model: "null-labels", labels: null },
      { model: "missing-key", labels: { task: "build" } },
      { model: "empty", labels: { project: "" } },
    ], ["--label", "project=", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(jsonRecords(result.stdout).map((entry) => entry.model)).toEqual(["empty"]);
  });

  test("--sum --by groups totals by label and identifies records without the label", async () => {
    const result = await callsWith([
      { model: "alpha-one", labels: { project: "alpha" }, input: 10, cost: 0.1 },
      { model: "beta", labels: { project: "beta" }, input: 20, cost: 0.2 },
      { model: "alpha-two", labels: { project: "alpha" }, input: 5 },
      { model: "null-labels", labels: null, input: 3 },
      { model: "legacy", input: 4 },
      { model: "other-label", labels: { task: "build" }, input: 2 },
    ], ["--sum", "--by", "project"]);
    expect(result.exitCode).toBe(0);
    const totals = result.stdout.split("\n").filter((line) => line.startsWith("Totals"));
    expect(totals).toHaveLength(3);
    expect(totals.find((line) => line.includes("project=alpha"))).toContain("over 2 record(s): input=15");
    expect(totals.find((line) => line.includes("project=alpha"))).toContain("cost=$0.1000");
    expect(totals.find((line) => line.includes("project=beta"))).toContain("over 1 record(s): input=20");
    expect(totals.find((line) => line.startsWith("Totals for records without label project ")))
      .toContain("over 3 record(s): input=9");
  });

  for (const json of [false, true]) {
    const format = json ? "JSON" : "table";

    test(`${format} totals distinguish a missing label from the literal value (none)`, async () => {
      const result = await callsWith([
        { model: "literal", labels: { wf: "(none)" }, input: 10, cost: 0.1 },
        { model: "missing", input: 20, cost: 0.2 },
      ], ["--sum", "--by", "wf", ...(json ? ["--json"] : [])]);
      expect(result.exitCode).toBe(0);
      const totals = result.stdout.split("\n").filter((line) => line.startsWith("Totals"));
      expect(totals.map((line) => line.split(" over ")[0])).toEqual([
        "Totals for records without label wf",
        "Totals for wf=(none)",
      ]);
      expect(totals[0]).toContain("over 1 record(s): input=20");
      expect(totals[0]).toContain("cost=$0.2000");
      expect(totals[1]).toContain("over 1 record(s): input=10");
      expect(totals[1]).toContain("cost=$0.1000");
    });

    test(`${format} totals retain records with invalid labels in the missing-label group`, async () => {
      const value = "build\u0085fast";
      const result = await callsWith([
        { model: "plain", labels: { wf: "buildfast" }, input: 20 },
        { model: "c1", labels: { wf: value }, input: 7 },
      ], ["--sum", "--by", "wf", ...(json ? ["--json"] : [])]);
      expect(result.exitCode).toBe(0);
      const totals = result.stdout.split("\n").filter((line) => line.startsWith("Totals"));
      expect(totals.map((line) => line.split(" over ")[0])).toEqual([
        "Totals for records without label wf",
        "Totals for wf=buildfast",
      ]);
      expect(totals[0]).toContain("over 1 record(s): input=7");
      expect(totals[1]).toContain("over 1 record(s): input=20");
      expect(totals.join("\n")).not.toMatch(/[\x7f-\x9f]/);
    });
  }

  test("a foreign control-bearing label map cannot match even its valid label", async () => {
    const result = await callsWith([
      { model: "foreign", labels: { wf: "safe\rFORGED\u001b[2K", task: "build" } },
      { model: "valid", labels: { task: "build" } },
    ], ["--label", "task=build", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(jsonRecords(result.stdout).map((entry) => entry.model)).toEqual(["valid"]);
    expect(result.stderr).toContain("invalid label");
  });

  test("foreign label controls remain JSON-encoded and round-trip without terminal controls", async () => {
    const labels = { wf: "safe\rFORGED\u001b[2K\u007f\u009b2K\u009dtitle", "w\u009bf": "value" };
    const result = await callsWith([{ model: "foreign", labels }], ["--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).labels).toEqual(labels);
    expect(result.stdout.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(result.stdout).toContain("\\u001b[2K");
    expect(result.stdout).toContain("\\u009b2K");
  });

  test("JSON output removes structural CR and TAB while preserving escaped label values", async () => {
    const labels = { wf: "safe\r\t\u001b[2K" };
    const stored = record({ model: "foreign", labels }).replace(',"labels":', ',\r\t"labels":');
    const result = await callsWith([stored], ["--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).labels).toEqual(labels);
    expect(result.stdout.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(result.stdout).toContain("\\r\\t\\u001b[2K");
  });

  test("JSON output preserves stored number spelling and key order around a raw tab", async () => {
    const labels = { wf: "safe\u009b2K" };
    const body = record({ model: "foreign", labels }).slice(1);
    const stored = `{"2":1e400,\t"1":-0,${body}`;
    const result = await callsWith([stored], ["--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`{"2":1e400, "1":-0,${body.replace("\u009b", "\\u009b")}\n`);
    const parsed = JSON.parse(result.stdout);
    expect(parsed["2"]).toBe(Infinity);
    expect(Object.is(parsed["1"], -0)).toBe(true);
    expect(parsed.labels).toEqual(labels);
    expect(result.stdout.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  test("group totals retain session folding and missing usage accounting", async () => {
    const labels = { project: "alpha" };
    const result = await callsWith([
      { model: "turn", labels, kind: "session_turn", sessionId: "session", input: 10 },
      { model: "summary", labels, kind: "session", sessionId: "session", input: 10, cost: 0.5 },
      { model: "unknown", labels: { project: "beta" } },
    ], ["--sum", "--by", "project"]);
    expect(result.exitCode).toBe(0);
    const alpha = result.stdout.split("\n").find((line) => line.startsWith("Totals") && line.includes("project=alpha"));
    const beta = result.stdout.split("\n").find((line) => line.startsWith("Totals") && line.includes("project=beta"));
    expect(alpha).toContain("input=10");
    expect(alpha).toContain("cost=$0.5000");
    expect(alpha).toContain("1 session summary folded");
    expect(beta).toContain("input=unknown");
    expect(beta).toContain("unreported");
  });

  test("grouping applies after filters and limit", async () => {
    const result = await callsWith([
      { model: "old", labels: { project: "alpha", task: "build" }, input: 100 },
      { model: "selected", labels: { project: "beta", task: "build" }, input: 7 },
      { model: "excluded", labels: { project: "alpha", task: "review" }, input: 200 },
    ], ["--label", "task=build", "-n", "1", "--sum", "--by", "project"]);
    expect(result.exitCode).toBe(0);
    const totals = result.stdout.split("\n").filter((line) => line.startsWith("Totals"));
    expect(totals).toHaveLength(1);
    expect(totals[0]).toContain("project=beta");
    expect(totals[0]).toContain("input=7");
  });

  test("--by requires --sum and a valid label key", async () => {
    const noSum = await callsWith([{ model: "record" }], ["--by", "project"]);
    expect(noSum.exitCode).toBe(64);
    expect(noSum.stdout).toBe("");
    expect(noSum.stderr).toContain("--by requires --sum");
    const invalidKey = await callsWith([{ model: "record" }], ["--sum", "--by", "Project"]);
    expect(invalidKey.exitCode).toBe(64);
    expect(invalidKey.stdout).toBe("");
    expect(invalidKey.stderr).toContain("Error:");
  });
});
