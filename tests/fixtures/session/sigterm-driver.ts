// A minimal session-runner driver for the SIGTERM end-to-end test: it
// starts a SessionProcess whose harness spawns a long-lived grandchild,
// wires the session signal gate, and exits 143 once the shutdown path has
// run to completion. The grandchild's pid is printed as LINE:<pid> so the
// test can verify the tree kill reached it.

import {
  installSessionSignalHandlers,
  SESSION_SIGNAL_EXIT_CODE,
  SessionProcess,
} from "../../../src/session/process.js";

const proc = new SessionProcess({
  command: ["/bin/sh", "-c", "sleep 60 & printf '%s\\n' $!; sleep 30"],
  cwd: process.cwd(),
  env: { PATH: "/usr/bin:/bin" },
  onLine: (line) => {
    process.stdout.write(`LINE:${line}\n`);
  },
  onFatal: () => {
    process.stdout.write("FATAL\n");
  },
  graceMs: 500,
});

installSessionSignalHandlers(async () => {
  proc.requestStop();
  await proc.settled;
  // The contract in process.ts: never `process.exit` inside the handler —
  // set the exit code after the shutdown path completes and let the loop
  // drain, the way the session CLI's `process.exitCode = code` does.
  process.exitCode = SESSION_SIGNAL_EXIT_CODE;
});

await proc.settled;
