import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { copyClaudeCredentialMirror } from "../src/claude-credential-mirror.js";
import { withTarget } from "./helpers/credentials.js";

test.each(["missing", "invalid", "refresh", "symlink"])("macOS ignores a %s plaintext source without touching private state", (kind) => {
  withTarget((source, root) => {
    const destination = join(root, "private");
    fs.mkdirSync(destination);
    const stale = join(destination, ".credentials.json");
    fs.writeFileSync(stale, "existing private bytes");
    if (kind === "invalid") fs.writeFileSync(source, "not JSON");
    if (kind === "symlink") {
      const linked = join(root, "linked");
      fs.renameSync(source, linked); fs.symlinkSync(linked, source);
    }
    const lstat = spyOn(fs, "lstatSync").mockImplementation(() => { throw new Error("unexpected source inspection"); });
    const open = spyOn(fs, "openSync").mockImplementation(() => { throw new Error("unexpected source read"); });
    const unlink = spyOn(fs, "unlinkSync").mockImplementation(() => { throw new Error("unexpected stale-copy removal"); });
    try {
      expect(() => copyClaudeCredentialMirror(destination, source, undefined, "darwin")).not.toThrow();
      expect(() => copyClaudeCredentialMirror(join(root, "absent-destination"), source, undefined, "darwin")).not.toThrow();
      for (const probe of [lstat, open, unlink]) expect(probe).not.toHaveBeenCalled();
    } finally { lstat.mockRestore(); open.mockRestore(); unlink.mockRestore(); }
    expect(fs.readFileSync(stale, "utf8")).toBe("existing private bytes");
    expect(fs.existsSync(join(root, "absent-destination"))).toBe(false);
  }, kind === "missing" ? "" : undefined);
});
