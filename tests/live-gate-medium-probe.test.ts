// Probe B (medium shell) in runProbes: the private nonce files, the outer
// deadline, and the verdict that requires the nonce hash on the answer's
// last line (split from live-gate-probes.test.ts for the size limit).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProbeRunner, formatReport, parseOptions, runProbes } from "../scripts/live-gate.js";
import { ROOT, cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv, mediumHash, reportInput } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

test("live gate prepares private nonce files and gives the outer deadline 30 extra seconds", async () => {
  const fixture = loggedInEnv();
  const calls: string[][] = [];
  const directories: string[] = [];
  const reportDirectory = fixtureDirectory();
  const runner = {
    async run(command: string[], expected: string, timeout: number, prefix?: string) {
      calls.push(command);
      expect(command[0]).toBe(join(ROOT, "bin/codemux"));
      expect(timeout).toBe(42);
      expect(command.slice(1, 3)).toEqual(["run", "-a"]);
      expect(command).not.toContain("--no-sandbox");
      expect(command).toContain("--timeout");
      expect(command[command.indexOf("--timeout") + 1]).toBe("12");
      const medium = command.includes("medium");
      const prompt = command[command.indexOf("-p") + 1]!;
      expect(prompt).toBe(medium
        ? "Run the shell command: sh probe.sh and reply with exactly its output, nothing else."
        : "Reply with exactly: OK");
      expect(command).toContain("--cwd");
      const cwd = command[command.indexOf("--cwd") + 1]!;
      if (medium) {
        expect(expected).toMatch(/^[0-9a-f]{16}$/);
        expect(prompt).not.toContain(expected);
        expect(readdirSync(cwd).sort()).toEqual(["nonce.txt", "probe.sh"]);
        const nonce = readFileSync(join(cwd, "nonce.txt"), "utf8");
        expect(nonce).toMatch(/^[0-9a-f]{12}$/);
        const { createHash } = await import("node:crypto");
        expect(expected).toBe(createHash("sha256").update(nonce).digest("hex").slice(0, 16));
        expect(statSync(join(cwd, "nonce.txt")).mode & 0o777).toBe(0o600);
        expect(readFileSync(join(cwd, "probe.sh"), "utf8")).not.toContain(expected);
        expect(statSync(join(cwd, "probe.sh")).mode & 0o777).toBe(0o700);
      } else {
        expect(expected).toBe("OK");
        expect(readdirSync(cwd)).toEqual([]);
      }
      expect(dirname(cwd)).toBe(tmpdir());
      expect(cwd.startsWith(`${ROOT}/`)).toBe(false);
      directories.push(cwd);
      expect(prefix).toBe(join(reportDirectory, `${command[3]}-${medium ? "B" : "A"}`));
      return { status: "PASS" as const, seconds: 0, stderr: "" };
    },
    async capture(command: string[], verify: (captured: { exit: number | null; stdout: string }) => string | null, timeout: number, prefix?: string) {
      expect(command).toContain("medium");
      const expected = mediumHash(command);
      expect(verify({ exit: 0, stdout: `${expected}\n` })).toBeNull();
      return this.run(command, expected, timeout, prefix);
    },
  };
  try {
    const rows = await runProbes([factsFor("agy"), factsFor("kimi"), factsFor("gemini")], parseOptions(["--skip", "gemini", "--probe", "A,B", "--timeout", "12"], ""), runner, reportDirectory, fixture.env);
    expect(calls).toHaveLength(4);
    expect(directories).toHaveLength(4);
    expect(new Set(directories).size).toBe(4);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(formatReport(reportInput({ rows, probes: ["A", "B"] }))).toContain(`live-gate (${join(ROOT, "bin/codemux")}): 4 pass, 0 fail, 2 skip, 0 unsupported`);
    expect(rows.every((row) => row.agent === "gemini" || (row.results.A!.status === "PASS" && row.results.B!.status === "PASS"))).toBe(true);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test.each(["command", "sha256sum fallback", "preamble", "trailing prose", "echo nonce", "wrong stdout", "codemux-ok"])("live gate requires the nonce hash from command execution: %s", async (output) => {
  const reportDirectory = fixtureDirectory();
  const runner = new ProbeRunner();
  try {
    const probeFor = (command: string[]): string[] => {
      const cwd = command[command.indexOf("--cwd") + 1]!;
      let probe = [process.execPath, "-e", 'console.log(" OK ")'];
      if (command.includes("medium")) {
        if (output === "command" || output === "wrong stdout" || output === "preamble" || output === "trailing prose") {
          // preamble: the 2026-11-10 claude answer, a sentence before the
          // hash (a run prints every assistant message, lane AN1).
          const script = output === "command" ? 'cd "$1" && sh probe.sh'
            : output === "preamble" ? 'cd "$1" && printf "The script hashes nonce.txt; I will run it.\\n\\n" && sh probe.sh'
            : output === "trailing prose" ? 'cd "$1" && sh probe.sh && printf "That is the hash.\\n"'
            : 'cd "$1" && sh probe.sh >/dev/null && printf codemux-ok';
          probe = ["sh", "-c", script, "sh", cwd];
        } else if (output === "sha256sum fallback") {
          const bin = join(reportDirectory, "bin");
          mkdirSync(bin);
          for (const utility of ["sh", "cat", "cut"]) symlinkSync(Bun.which(utility)!, join(bin, utility));
          writeFileSync(join(bin, "sha256sum"), `#!${process.execPath}
            const { createHash } = require("node:crypto");
            console.log(createHash("sha256").update(await Bun.stdin.text()).digest("hex") + "  -");
          `, { mode: 0o700 });
          probe = [Bun.which("env")!, `PATH=${bin}`, "sh", "-c", 'cd "$1" && sh probe.sh', "sh", cwd];
        } else if (output === "codemux-ok") {
          probe = [process.execPath, "-e", 'console.log("codemux-ok")'];
        } else {
          const source = `const fs = require("node:fs"); const dir = process.argv[1];
            process.stdout.write(fs.readFileSync(dir + "/nonce.txt", "utf8"));`;
          probe = [process.execPath, "-e", source, cwd];
        }
      }
      return probe;
    };
    const rows = await runProbes([factsFor("agy")], parseOptions(["--probe", "A,B"], ""), {
      run: (command, expected, timeout, prefix) => runner.run(probeFor(command), expected, timeout, prefix),
      capture: (command, verify, timeout, prefix) => runner.capture(probeFor(command), verify, timeout, prefix),
    }, reportDirectory, loggedInEnv().env);
    expect(rows[0]!.results.A!.status).toBe("PASS");
    expect(rows[0]!.results.B!.status).toBe(["command", "sha256sum fallback", "preamble"].includes(output) ? "PASS" : "FAIL");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});
