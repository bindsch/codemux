/**
 * The hermetic-home wiring arms the launcher tests cannot reach
 * (turn-driver-homes.ts): the pi state-root redirect passthrough, the
 * hermetic turn context's getters, the agents that answer no home, and
 * every populate fallback (missing logins, non-file logins, the pi
 * override's models.json, gemini's override skip) plus the two
 * fail-closed refusals.
 */

import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openTurnAgentPrivateHome,
  turnAgentStateRoot,
  turnAgentHermeticTurnContext,
} from "../src/session/turn-driver-homes.js";
import { piProviderModelsJson, piProviderBareModel } from "../src/pi-provider.js";

const OVERRIDE = { baseUrl: "https://synthetic.invalid", apiKey: "synthetic-key" };

const withHome = (run: (home: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "codemux-turn-homes-"));
  const home = join(root, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    run(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
};

describe("the plain state root", () => {
  test("pi honors a passed-through absolute PI_CODING_AGENT_DIR only", () => {
    withHome((home) => {
      expect(turnAgentStateRoot("pi", [])).toBe(join(home, ".pi", "agent"));
      const previous = process.env.PI_CODING_AGENT_DIR;
      try {
        // Set but not passed through: isolation owns the variable.
        process.env.PI_CODING_AGENT_DIR = "/tmp/pi-redirect";
        expect(turnAgentStateRoot("pi", [])).toBe(join(home, ".pi", "agent"));
        expect(turnAgentStateRoot("pi", ["PI_CODING_AGENT_DIR"])).toBe("/tmp/pi-redirect");
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    });
  });
});

describe("the hermetic turn context getters", () => {
  test("every agent's context reads through the home and finalizes cleanly", () => {
    const home = {
      dir: "/tmp/session-home",
      resumed: false,
      settled: true,
      settle: (): void => {},
      remove: (): boolean => true,
      blockedPaths: [],
    };
    const droid = turnAgentHermeticTurnContext("droid", home);
    expect(droid.droidHermeticHome?.home).toBe("/tmp/session-home");
    expect(droid.droidHermeticHome?.brandHome).toBe("/tmp/session-home/.factory");
    expect(() => droid.droidHermeticHome?.finalize()).not.toThrow();

    const pi = turnAgentHermeticTurnContext("pi", home);
    expect(pi.piProviderAgentDir?.path).toBe("/tmp/session-home");
    expect(() => pi.piProviderAgentDir?.finalize()).not.toThrow();

    const gemini = turnAgentHermeticTurnContext("gemini", home);
    expect(gemini.geminiHermeticHome?.home).toBe("/tmp/session-home");
    expect(gemini.geminiHermeticHome?.geminiDir).toBe("/tmp/session-home/.gemini");
    expect(() => gemini.geminiHermeticHome?.finalize()).not.toThrow();

    const copilot = turnAgentHermeticTurnContext("copilot", home);
    expect(copilot.copilotHermeticHome?.home).toBe("/tmp/session-home");
    expect(() => copilot.copilotHermeticHome?.finalize()).not.toThrow();

    const goose = turnAgentHermeticTurnContext("goose", home);
    expect(goose.gooseHermeticHome?.home).toBe("/tmp/session-home");
    expect(goose.gooseHermeticHome?.envAssignments).toContain("GOOSE_PATH_ROOT=/tmp/session-home");
    expect(() => goose.gooseHermeticHome?.finalize()).not.toThrow();

    expect(turnAgentHermeticTurnContext("cursor", home)).toEqual({});
    expect(turnAgentHermeticTurnContext("qwen", home)).toEqual({});
  });
});

describe("the agents that keep no session home", () => {
  test("cursor and qwen answer null even when asked hermetically", () => {
    withHome(() => {
      for (const agent of ["cursor", "qwen"] as const) {
        expect(
          openTurnAgentPrivateHome({
            agent,
            hermetic: true,
            resumeSessionId: null,
            sessionId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            passthroughEnv: [],
            override: null,
            model: undefined,
          })
        ).toBeNull();
      }
    });
  });
});

describe("the populate fallbacks", () => {
  // One fresh session id per open: a second home under the same id is
  // the reuse refusal, which is not what these tests pin.
  let idCounter = 0;
  const open = (agent: "droid" | "pi" | "gemini" | "copilot" | "goose", extra = {}) => {
    idCounter += 1;
    return openTurnAgentPrivateHome({
      agent,
      hermetic: true,
      resumeSessionId: null,
      sessionId: `1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c${String(idCounter).padStart(2, "0")}`,
      passthroughEnv: [],
      override: null,
      model: undefined,
      ...extra,
    });
  };

  test("droid without a file login links nothing; a non-file login refuses", () => {
    withHome((home) => {
      const missing = open("droid");
      expect(missing).not.toBeNull();
      expect(readdirSync(join(missing!.dir, ".factory"))).toEqual([]);
      // A directory where the login should be is a refusal, not a skip.
      fs.mkdirSync(join(home, ".factory", "auth.json"));
      expect(() => open("droid")).toThrow("need a file login");
    });
  });

  test("pi without an override writes auth.json only when a file login exists", () => {
    withHome((home) => {
      const missing = open("pi");
      expect(readdirSync(missing!.dir)).toEqual([]);
      fs.mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(join(home, ".pi", "agent", "auth.json"));
      expect(() => open("pi")).toThrow("need a file login");
    });
  });

  test("pi under an override with a model writes the routing models.json", () => {
    withHome(() => {
      const home = open("pi", { override: OVERRIDE, model: "openai/gpt-5.2" });
      const written = JSON.parse(readFileSync(join(home!.dir, "models.json"), "utf8"));
      expect(written).toEqual(
        JSON.parse(piProviderModelsJson(OVERRIDE, piProviderBareModel("openai/gpt-5.2")))
      );
      expect(statSync(join(home!.dir, "models.json")).mode & 0o777).toBe(0o600);
    });
  });

  test("pi under an override without a model refuses before any home", () => {
    withHome(() => {
      expect(() => open("pi", { override: OVERRIDE, model: undefined })).toThrow(
        "pi needs a model for the provider override"
      );
    });
  });

  test("gemini under an override links nothing; without one it links the logins", () => {
    withHome((home) => {
      fs.mkdirSync(join(home, ".gemini"), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}", { mode: 0o600 });
      writeFileSync(join(home, ".gemini", "google_accounts.json"), "{}", { mode: 0o600 });
      const overridden = open("gemini", { override: OVERRIDE });
      expect(readdirSync(join(overridden!.dir, ".gemini"))).toEqual([]);
      const plain = open("gemini");
      expect(readdirSync(join(plain!.dir, ".gemini")).sort()).toEqual([
        "google_accounts.json",
        "oauth_creds.json",
      ]);
    });
  });

  test("copilot without a config.json creates an empty home", () => {
    withHome(() => {
      const home = open("copilot");
      expect(readdirSync(home!.dir)).toEqual([]);
    });
  });

  test("goose without the override refuses before any home", () => {
    withHome(() => {
      expect(() => open("goose", { override: null })).toThrow("goose --hermetic requires the provider override");
    });
  });

  test("a filesystem without hard links takes a symlink for the login", () => {
    withHome((home) => {
      fs.mkdirSync(join(home, ".factory"), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, ".factory", "auth.json"), "{}", { mode: 0o600 });
      const link = spyOn(fs, "linkSync").mockImplementation(() => {
        throw Object.assign(new Error("synthetic cross-device link"), { code: "EXDEV" });
      });
      try {
        const opened = open("droid");
        const linked = readdirSync(join(opened!.dir, ".factory"));
        expect(linked).toEqual(["auth.json"]);
        expect(lstatSync(join(opened!.dir, ".factory", "auth.json")).isSymbolicLink()).toBe(true);
      } finally {
        link.mockRestore();
      }
    });
  });
});
