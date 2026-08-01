import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

export interface BoundedFileOptions {
  maxBytes: number;
  label: string;
  noFollow?: boolean;
  validate?: (stat: Stats) => void;
}

/** Opens once, validates the descriptor, and never reads beyond maxBytes + 1. */
export function readUtf8FileBounded(
  path: string,
  options: BoundedFileOptions
): string {
  let fd: number;
  try {
    const noFollowFlag =
      options.noFollow && process.platform !== "win32"
        ? constants.O_NOFOLLOW
        : 0;
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag
    );
  } catch (error) {
    if (
      options.noFollow &&
      (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      throw new Error(`${options.label} must not be a symbolic link`);
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${options.label} is not a regular file`);
    }
    if (stat.size > options.maxBytes) {
      throw new Error(`${options.label} exceeds ${options.maxBytes} bytes`);
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
        throw new Error(`${options.label} exceeds ${options.maxBytes} bytes`);
      }
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, totalBytes)
      );
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`${options.label} must contain valid UTF-8`);
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}
