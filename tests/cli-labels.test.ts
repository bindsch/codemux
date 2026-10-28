import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createFakeBinaryEnv, minimalPath, runCli } from "./helpers/cli.js";

describe("CLI run labels", () => {
  test("run help includes the repeatable label option", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--label <KEY=VALUE>");
  });

  test.each(["run", "calls"])("%s rejects a label flag with no argument", async (command) => {
    const result = await runCli([command, "--label"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("--label");
  });

  test("calls rejects --by with no key as a usage error", async () => {
    const result = await runCli(["calls", "--by"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("--by");
  });

  const invalidFlagSets: string[][] = [
    ["--label", "broken"],
    ["--label", "=value"],
    ["--label", "Bad=value"],
    ["--label", "wf=a", "--label", "wf=b"],
    ["--label", "key=a\nb"],
    ["--label", `key=${"é".repeat(129)}`],
  ];
  test.each(invalidFlagSets.map((flags) => [flags] as const))(
    "bad label flags %j exit 64 before launch", async (flags) => {
    const result = await runCli(["run", ...flags, "-p", "test"], { PATH: minimalPath() });
    expect(result.exitCode).toBe(64);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("label");
    expect(result.stderr).toContain(JSON.stringify(flags.at(-1)));
    }
  );

  test("malformed environment exits 64 before launch", async () => {
    const result = await runCli(["run", "-p", "test"], {
      PATH: minimalPath(), CODEMUX_LABELS: "wf=ok,broken",
    });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('"broken"');
  });

  test("C1 label values and keys exit 64 with escaped diagnostics", async () => {
    for (const command of ["run", "calls"]) {
      for (const label of ["wf=safe\u009b2K", "wf=safe\u009dtitle", "w\u009bf=safe"]) {
        const result = await runCli([
          command, "--label", label, ...(command === "run" ? ["-p", "test"] : []),
        ], { PATH: minimalPath() });
        expect(result.exitCode).toBe(64);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("invalid label");
        expect(result.stderr).toMatch(/\\u009[bd]/);
        expect(result.stderr.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      }
    }
  });

  test("flags replace malformed environment labels in the result and ledger", async () => {
    const fake = createFakeBinaryEnv({
      claude: 'if [ "$1" = --version ]; then printf "2.1.280\\n"; exit 0; fi\n' +
        'cat >/dev/null; printf \'%s\\n\' \'{"type":"result","result":"OK"}\'',
    });
    const ledger = join(fake.env.PATH!.split(":")[0]!, "calls.jsonl");
    try {
      const result = await runCli([
        "run", "-a", "claude", "--no-sandbox", "--auto", "high", "--result-json",
        "--label", "wf=review", "--label", "step=scan", "-p", "test",
      ], { ...fake.env, CODEMUX_CALL_LOG: ledger, CODEMUX_LABELS: "malformed" });
      expect(result.exitCode).toBe(0);
      const labels = { wf: "review", step: "scan" };
      expect(JSON.parse(result.stdout).codemux.labels).toEqual(labels);
      expect(JSON.parse(await Bun.file(ledger).text()).labels).toEqual(labels);
    } finally {
      fake.cleanup();
    }
  });

  test("environment fallback reaches an ordinary run record", async () => {
    const fake = createFakeBinaryEnv({ goose: "printf 'OK\\n'" });
    const ledger = join(fake.env.PATH!.split(":")[0]!, "calls.jsonl");
    try {
      const result = await runCli([
        "run", "-a", "goose", "--no-sandbox", "--auto", "high", "-p", "test",
      ], { ...fake.env, CODEMUX_CALL_LOG: ledger, CODEMUX_LABELS: "wf=review,step=scan" });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(await Bun.file(ledger).text()).labels).toEqual({ wf: "review", step: "scan" });
    } finally {
      fake.cleanup();
    }
  });
});
