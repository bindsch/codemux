import { afterAll, beforeAll } from "bun:test";
import { scodeGatePlatform } from "../../src/cli-runtime/scode.js";

/**
 * For a test file about scode capabilities older than 0.6.11 (the version
 * gates for --allow-ro, --allow-staged, --no-login-store, --keep-env and the
 * like). A macOS launch refuses those versions outright, so on a macOS host
 * the file states that its in-process launches follow the Linux floors, where
 * such a scode still runs. It is also for a file whose in-process launches
 * mock the sandbox runner and put no scode on PATH: on macOS a missing scode
 * is refused before anything starts. The setting lives in this process
 * only: a codemux the test starts as a child process keeps the host's floors.
 */
export function useLinuxScodeFloors(): void {
  beforeAll(() => { scodeGatePlatform.value = "linux"; });
  afterAll(() => { scodeGatePlatform.value = process.platform; });
}
