import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plantHarnessHomeCanary, seedHarnessHomeCanary } from "../src/hermetic-session-canary-home.js";
import { openCallerHarnessHome } from "../src/session/harness-home.js";
import { buildScodeCommand } from "../src/sandbox.js";
import { withTarget } from "./helpers/credentials.js";

test.skipIf(process.platform !== "darwin")("Claude caller-home canaries preserve native HOME and profile while isolating instructions", () => {
  withTarget((_login, home) => {
    const native = join(home, "Library/Keychains"); mkdirSync(native, { recursive: true });
    const store = join(native, "login.keychain-db"); writeFileSync(store, "native login bytes");
    const authenticated = join(home, "first-private-home"); mkdirSync(authenticated);
    writeFileSync(join(authenticated, ".credentials.json"), "must never be copied");
    for (const [profile, secure, expected] of [
      [undefined, undefined, ""], ["/synthetic/profile", undefined, "/synthetic/profile"],
      ["/synthetic/profile", "/synthetic/login", "/synthetic/login"], ["/synthetic/profile", "", ""],
    ] as const) {
      const environment = { HOME: home, CLAUDE_CONFIG_DIR: profile, CLAUDE_SECURESTORAGE_CONFIG_DIR: secure };
      const plant = plantHarnessHomeCanary("claude", authenticated, environment, home);
      try {
        expect(plant.env.HOME).toBe(home);
        expect(plant.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(expected);
        expect(plant.env.CLAUDE_CONFIG_DIR).toBe(join(plant.operatorHome, ".claude"));
        expect(readFileSync(join(plant.env.CLAUDE_CONFIG_DIR!, "CLAUDE.md"), "utf8")).toContain(plant.operatorMarker);
        seedHarnessHomeCanary("claude", plant, authenticated);
        expect(existsSync(join(plant.operatorHome, ".claude/.credentials.json"))).toBe(false);
        const caller = openCallerHarnessHome({ agent: "claude", dir: plant.home, cwd: plant.cwd,
          sourceHome: authenticated, sourceEnv: plant.env, blockedPaths: [], apiKeyAuth: false });
        expect(caller.environment.HOME).toBe(home);
        expect(caller.environment.CLAUDE_CONFIG_DIR).toBe(plant.home);
        expect(caller.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(expected);
        expect(existsSync(join(plant.home, ".credentials.json"))).toBe(false);
        const denied = buildScodeCommand(["/bin/echo", "synthetic"], plant.cwd, "low", { agentId: "claude" }, "scode", caller.environment);
        expect(denied).not.toContain(native);
        const command = buildScodeCommand(["/bin/echo", "synthetic"], plant.cwd, "low", { agentId: "claude", loginStore: true }, "scode", caller.environment, true);
        const allowed = command.filter((_, index) => command[index - 1] === "--allow");
        expect(allowed).toContain(native);
      } finally { plant.cleanup(); }
      expect(readFileSync(store, "utf8")).toBe("native login bytes");
    }
  });
});
