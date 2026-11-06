import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

/** The file opened and is a regular file, but its bytes break a content
 * bound (size, UTF-8). Callers that distinguish a bad file from an
 * untrusted or unreadable one match on this class. */
export class FileContentError extends Error {}

/** The entry at the path is not a regular file this read may use: a
 * symbolic link, a non-regular file (a FIFO, a directory), or — where the
 * open has no no-follow flag — an entry that changed between the look
 * and the open. Callers that skip unusable entries rather than refuse
 * match on this class. */
export class FileShapeError extends Error {}

/** Whether a path has an entry, told apart from a path that cannot be
 * inspected. Only ENOENT (nothing there) and ENOTDIR (a parent is a
 * file) mean "no entry"; every other failure — a mode-000 parent
 * (EACCES), an I/O error — reaches `refuse`, which throws in the caller's
 * own error style. A caller that treated those as "absent" would silently
 * take its default for a security or quota setting (review round 169):
 * `existsSync` folds every error into false, exactly that defect. The
 * look does not follow a final symlink, so a link whose target is missing
 * is an entry too: a guard that refuses an existing path must not let a
 * later rename replace the link (review round 174). */
export function statEntryPresent(
  path: string,
  refuse: (code: string) => never
): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    refuse(code ?? "unknown error");
  }
}

export interface BoundedFileOptions {
  maxBytes: number;
  label: string;
  noFollow?: boolean;
  validate?: (stat: Stats) => void;
}

/** Opens once, validates the descriptor, and never reads beyond maxBytes + 1.
 * The bytes come back as read: nothing is decoded, so a caller that copies
 * a file (a credential) gets every byte, a leading byte-order mark and
 * bytes that are not UTF-8 included (review round 170). */
export function readFileBytesBounded(
  path: string,
  options: BoundedFileOptions
): Buffer {
  let fd: number;
  const noFollowOpen = options.noFollow === true && process.platform !== "win32";
  // Windows has no O_NOFOLLOW, so there the link is refused by a look at
  // the path before the open (review round 172: the flag used to be
  // dropped and the link followed), and the opened file must be the one
  // that look saw: a link swapped in between the two would otherwise be
  // followed (review round 174).
  const looked = options.noFollow && !noFollowOpen ? lstatSync(path) : null;
  if (looked?.isSymbolicLink()) {
    throw new FileShapeError(`${options.label} must not be a symbolic link`);
  }
  try {
    const noFollowFlag = noFollowOpen ? constants.O_NOFOLLOW : 0;
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag
    );
  } catch (error) {
    if (
      options.noFollow &&
      (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      throw new FileShapeError(`${options.label} must not be a symbolic link`);
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (looked !== null && (looked.dev !== stat.dev || looked.ino !== stat.ino)) {
      throw new FileShapeError(`${options.label} changed while it was opened`);
    }
    if (!stat.isFile()) {
      throw new FileShapeError(`${options.label} is not a regular file`);
    }
    if (stat.size > options.maxBytes) {
      throw new FileContentError(`${options.label} exceeds ${options.maxBytes} bytes`);
    }
    options.validate?.(stat);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = options.maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
      if (totalBytes > options.maxBytes) {
        throw new FileContentError(`${options.label} exceeds ${options.maxBytes} bytes`);
      }
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    closeSync(fd);
  }
}

/** The same bounded read, decoded as strict UTF-8 text. The decoder drops
 * a leading byte-order mark, which is right for text that is parsed and
 * wrong for a file that is copied: copies use readFileBytesBounded. */
export function readUtf8FileBounded(
  path: string,
  options: BoundedFileOptions
): string {
  const bytes = readFileBytesBounded(path, options);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new FileContentError(`${options.label} must contain valid UTF-8`);
    }
    throw error;
  }
}
