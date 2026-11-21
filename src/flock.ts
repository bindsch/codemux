import { dlopen, read, type Pointer } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;
let native: ReturnType<typeof loadNative> | undefined;
function loadNative() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("advisory file locks require macOS or Linux flock");
  }
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["int", "int"], returns: "int" },
    [process.platform === "darwin" ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
  });
}

/** One non-blocking attempt at an exclusive flock on `fd`: true when this
 * descriptor now owns the lock, false when another open file description
 * holds it. Any other failure throws with its errno. The kernel drops the
 * lock when the last copy of the descriptor closes, so a crashed owner
 * never leaves a stale lock. */
export function tryExclusiveFlock(fd: number): boolean {
  const api = native ??= loadNative();
  if (api.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
  // EWOULDBLOCK differs across the supported kernels. Read errno immediately.
  const errno = read.i32(api.symbols[process.platform === "darwin" ? "__error" : "__errno_location"]!() as Pointer);
  if (errno !== (process.platform === "darwin" ? 35 : 11) && errno !== 4) {
    throw new Error(`flock failed (errno ${errno})`);
  }
  return false;
}
