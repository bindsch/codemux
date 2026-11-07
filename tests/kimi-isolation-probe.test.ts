// Review round 286: the isolation probe copied `region` and `device_id`
// with existsSync plus copyFileSync, so a FIFO at either path blocked the
// probe before its timeout started and a symlink copied data from an
// unintended target. The hermetic home's bounded no-follow reader (round
// 100) feeds the copy here too: the bytes are read, never copied by path.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plantKimiCanary } from "../src/kimi-isolation-probe.js";

function brandFixture(): { home: string; brand: string; cleanup: () => void } {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-canary-"));
  const brand = join(home, ".kimi-code");
  mkdirSync(join(brand, "credentials"), { recursive: true });
  return { home, brand, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("a symlink swapped in for region is refused and its target never reaches the planted home", () => {
  const f = brandFixture();
  try {
    const target = join(f.home, "operator-secret");
    writeFileSync(target, "symlinked-region");
    symlinkSync(target, join(f.brand, "region"));
    let refusal: unknown;
    try {
      plantKimiCanary({ HOME: f.home });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("region");
    expect((refusal as Error).message).toContain("symbolic link");
    // The probe failed, so its scratch root is removed: no partial plant
    // survives under the brand home.
    expect(readdirSync(join(f.brand, ".codemux-canary")).length).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("symlinked-region");
  } finally {
    f.cleanup();
  }
});

test("a FIFO swapped in for device_id is refused at once, not blocked on", () => {
  const f = brandFixture();
  try {
    writeFileSync(join(f.brand, "region"), "test-region");
    const fifo = join(f.brand, "device_id");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const started = Date.now();
    let refusal: unknown;
    try {
      plantKimiCanary({ HOME: f.home });
    } catch (error) {
      refusal = error;
    }
    // The bounded reader opens nonblocking and refuses the descriptor on
    // its fstat: no writer ever appears, so a regression to a plain copy
    // would block this test instead of refusing.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("device_id");
    expect((refusal as Error).message).toContain("not a regular file");
    expect(readdirSync(join(f.brand, ".codemux-canary")).length).toBe(0);
  } finally {
    f.cleanup();
  }
}, 10_000);
