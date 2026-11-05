import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createCodexHermeticHome } from "../src/hermetic-home.js";
import { createKimiHermeticHome } from "../src/kimi-hermetic.js";
import { createOpencodeHermeticHome } from "../src/opencode-hermetic.js";
import { writeOpencodeProviderConfig } from "../src/opencode-provider.js";
import { writeDroidProviderSettings } from "../src/droid-provider.js";
import { writePiProviderAgentDir } from "../src/pi-provider.js";
import { writeCodexProviderConfig } from "../src/codex-provider/config.js";
import { createProjectSettingsConfigDir } from "../src/claude-project-config.js";
import {
  recordTrustedParent,
  removeUnderTrustedParent,
  removeUnderTrustedParentOrThrow,
  reportingHook,
} from "../src/safe-remove.js";

// Review round 96, whole tree, finding 3: every finalizer that recursively
// removes a private per-run directory revalidates its parent first (the one
// shared rule, src/safe-remove.ts). A sandboxed child with write access to
// the grandparent could replace the parent with a symlink between creation
// and cleanup, and the recursive removal would then resolve that component
// into a directory codemux never chose — deleting the same-named child under
// it. Each row builds one real run directory, swaps its parent for a link to
// a victim holding a same-named child, and proves cleanup refuses and the
// victim survives.
//
// Review round 97: a direct finalize call throws on a refusal, so the
// adapter's cleanup reports the kept directory (the claude
// project-settings site documents a non-throwing finalize and prints);
// the refusal stays retryable; an exit hook reports instead of throwing;
// and a parent missing at its path is a refusal, since a rename moves the
// run directory with it.

const OVERRIDE = { baseUrl: "https://override.example/v1", apiKey: "lift-key" } as const;

interface Site {
  name: string;
  /** How a direct finalize call reports a refusal (default: it throws). */
  prints?: boolean;
  make: () => {
    parent: string;
    dir: string;
    finalize: () => void;
    cleanup: () => void;
  };
}

const SITES: Site[] = [
  {
    name: "the codex hermetic home",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      mkdirSync(join(root, ".codex"));
      const home = createCodexHermeticHome(join(root, ".codex"), true);
      return {
        parent: join(root, ".codex", ".codemux-hermetic"),
        dir: home.home,
        finalize: () => home.finalize(),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "the kimi hermetic home",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      const home = createKimiHermeticHome(root, false, true);
      return {
        parent: join(root, ".codemux-hermetic"),
        dir: home.home,
        finalize: () => home.finalize(),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "the opencode hermetic home",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      const home = createOpencodeHermeticHome(root);
      return {
        parent: join(root, ".codemux-hermetic"),
        dir: home.home,
        finalize: () => home.finalize(),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "the opencode provider config directory",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      const config = writeOpencodeProviderConfig(root, OVERRIDE, "test-model");
      return {
        parent: join(root, ".codemux"),
        dir: dirname(config.path),
        finalize: config.finalize,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "the droid provider settings directory",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      const settings = writeDroidProviderSettings(root, OVERRIDE, "test-model");
      return {
        parent: join(root, ".codemux"),
        dir: dirname(settings.path),
        finalize: settings.finalize,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "the pi agent directory",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      const agent = writePiProviderAgentDir(root, OVERRIDE, "test-model");
      return {
        parent: join(root, ".codemux"),
        dir: agent.path,
        finalize: agent.finalize,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "codex's provider-override home",
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      const home = writeCodexProviderConfig(root, { baseUrl: OVERRIDE.baseUrl }, "test-model", null);
      return {
        parent: join(root, ".codemux-provider"),
        dir: home.codexHome,
        finalize: home.finalize,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "the claude project-settings config directory",
    prints: true,
    make: () => {
      const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
      mkdirSync(join(root, "work"));
      const config = createProjectSettingsConfigDir(join(root, "work"), { HOME: root });
      return {
        parent: join(root, ".claude", ".codemux-hermetic"),
        dir: config.dir,
        finalize: config.finalize,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
];

describe("cleanup revalidates the parent before a recursive removal", () => {
  test.each(SITES)("a parent replaced by a symlink is refused: $name", (site) => {
    const { parent, dir, finalize, cleanup } = site.make();
    try {
      // The victim directory the swapped parent points at, holding a
      // same-named child a naive recursive removal would delete.
      const victim = join(dirname(parent), "victim");
      mkdirSync(victim);
      const victimChild = join(victim, basename(dir));
      mkdirSync(victimChild);
      writeFileSync(join(victimChild, "marker.txt"), "kept\n");
      // The sandboxed child moves the real parent away and links its own
      // directory in at the same name.
      const moved = `${parent}.moved`;
      renameSync(parent, moved);
      symlinkSync(victim, parent);
      const errors: string[] = [];
      const realError = console.error;
      console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
      let thrown: unknown;
      try {
        // Must not remove through the link. A direct call throws the
        // refusal; the claude site prints it.
        finalize();
      } catch (error) {
        thrown = error;
      } finally {
        console.error = realError;
      }
      if (site.prints === true) {
        expect(thrown).toBeUndefined();
        expect(errors.join("\n")).toContain("the directory was kept");
      } else {
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("the directory was kept");
      }
      expect(existsSync(victimChild)).toBe(true);
      expect(readFileSync(join(victimChild, "marker.txt"), "utf8")).toBe("kept\n");
      // A refused removal is retryable at every site, so the exit-hook
      // registration stays live for a real second attempt. Restore the
      // real parent and retry: the removal now succeeds and releases the
      // registration. Without this, a later suite's real signal would
      // run the leaked finalize and exit this shared test process
      // (src/private-dir-signals.ts). Unlinking the link first: rename
      // onto a symlink names ENOTDIR on this platform.
      rmSync(parent);
      renameSync(moved, parent);
      expect(existsSync(dir)).toBe(true);
      finalize();
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(victimChild)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a swapped ancestor link is caught by the recorded realpath (the codex hermetic home)", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
    try {
      mkdirSync(join(root, ".codex"));
      const home = createCodexHermeticHome(join(root, ".codex"), true);
      // The parent itself still lstats as a real directory; only the
      // GRANDPARENT was swapped, so the lstat half alone would pass and the
      // removal would resolve into the fake tree.
      const fake = join(root, "fake");
      const fakeGrandparent = join(fake, ".codex");
      const fakeParent = join(fakeGrandparent, ".codemux-hermetic");
      mkdirSync(fakeParent, { recursive: true });
      const victimChild = join(fakeParent, basename(home.home));
      mkdirSync(victimChild);
      writeFileSync(join(victimChild, "marker.txt"), "kept\n");
      const moved = `${root}/codex-moved`;
      renameSync(join(root, ".codex"), moved);
      symlinkSync(fakeGrandparent, join(root, ".codex"));
      expect(() => home.finalize()).toThrow(/is no longer the directory this run created.*the directory was kept/);
      expect(existsSync(victimChild)).toBe(true);
      expect(readFileSync(join(victimChild, "marker.txt"), "utf8")).toBe("kept\n");
      // Restore and retry, releasing the signal-tracked registration.
      rmSync(join(root, ".codex"));
      renameSync(moved, join(root, ".codex"));
      home.finalize();
      expect(existsSync(join(root, ".codex", ".codemux-hermetic", basename(home.home)))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a parent missing at its path is a refusal: a rename moved the run directory with it", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
    const errors: string[] = [];
    const realError = console.error;
    console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
    try {
      const parent = join(root, "parent");
      mkdirSync(parent);
      const record = recordTrustedParent(parent);
      const dir = join(parent, "run-1");
      mkdirSync(dir);
      writeFileSync(join(dir, "file.txt"), "x\n");
      renameSync(parent, join(root, "renamed"));
      expect(() => removeUnderTrustedParentOrThrow(dir, record, "the run directory")).toThrow(
        /could not remove the run directory \(.*no longer exists.*\); the directory was kept/
      );
      expect(removeUnderTrustedParent(dir, record, "the run directory")).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("codemux: could not remove the run directory");
      expect(readFileSync(join(root, "renamed", "run-1", "file.txt"), "utf8")).toBe("x\n");
      // Back at its path, the same record removes the directory.
      renameSync(join(root, "renamed"), parent);
      expect(removeUnderTrustedParent(dir, record, "the run directory")).toBe(true);
      expect(existsSync(dir)).toBe(false);
      expect(errors).toHaveLength(1);
    } finally {
      console.error = realError;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("another directory put at the recorded parent's path is refused by identity", () => {
    // Review round 98: the pathname and realpath match; only the device
    // and inode tell the replacement from the directory this run made.
    const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
    try {
      const home = createOpencodeHermeticHome(root, undefined);
      const parent = dirname(home.home);
      const moved = `${parent}.moved`;
      renameSync(parent, moved);
      mkdirSync(parent);
      const victimChild = join(parent, basename(home.home));
      mkdirSync(victimChild);
      writeFileSync(join(victimChild, "marker.txt"), "kept\n");
      expect(() => home.finalize()).toThrow(/is no longer the directory this run created.*the directory was kept/);
      expect(readFileSync(join(victimChild, "marker.txt"), "utf8")).toBe("kept\n");
      // Restore and retry, releasing the exit hook.
      rmSync(parent, { recursive: true, force: true });
      renameSync(moved, parent);
      home.finalize();
      expect(existsSync(home.home)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the exit hook of a refused finalizer reports instead of throwing, and stays registered", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-f3-"));
    const before = new Set(process.listeners("exit"));
    const home = createKimiHermeticHome(root, false, true);
    const hooks = process.listeners("exit").filter((listener) => !before.has(listener));
    const parent = join(root, ".codemux-hermetic");
    const errors: string[] = [];
    const realError = console.error;
    console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
    try {
      expect(hooks).toHaveLength(1);
      renameSync(parent, `${parent}.moved`);
      expect(() => home.finalize()).toThrow(/the directory was kept/);
      // The hook is still registered after the failed direct call, and
      // running it reports the refusal without throwing.
      expect(process.listeners("exit")).toContain(hooks[0]!);
      (hooks[0] as () => void)();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("codemux: could not remove the private kimi home");
      renameSync(`${parent}.moved`, parent);
      home.finalize();
      expect(existsSync(home.home)).toBe(false);
      expect(process.listeners("exit")).not.toContain(hooks[0]!);
    } finally {
      console.error = realError;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reportingHook prints a thrown failure once and passes a clean finalize through", () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
    try {
      let calls = 0;
      reportingHook(() => { calls += 1; })();
      reportingHook(() => { throw new Error("could not remove x (y); the directory was kept"); })();
      expect(calls).toBe(1);
      expect(errors).toEqual(["codemux: could not remove x (y); the directory was kept"]);
    } finally {
      console.error = realError;
    }
  });
});
