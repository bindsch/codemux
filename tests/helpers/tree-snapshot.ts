import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Detect writes even when preparation removes its temporary files again. */
export function treeSnapshot(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  return { mtime: stat.mtimeMs, ctime: stat.ctimeMs, mode: stat.mode,
    contents: stat.isSymbolicLink() ? { link: readlinkSync(path) }
      : stat.isDirectory() ? readdirSync(path).sort().map((name) => [name, treeSnapshot(join(path, name))])
      : readFileSync(path).toString("hex") };
}
