/**
 * A session child that survives its stop request: SIGTERM is held for
 * FAKE_HOLD_MS (default 400) and the process then exits 0 — the shape of
 * a harness inside its shutdown grace window. One line, "READY", is
 * written to stdout once the handler is installed, so a test can attach
 * only after the child can actually survive the signal (a SIGTERM that
 * lands during the child's own boot kills it before any handler runs).
 * Nothing else is written: the driver under test never handshakes.
 */
process.on("SIGTERM", () => {
  const holdMs = Number(process.env.FAKE_HOLD_MS ?? "400");
  setTimeout(() => process.exit(0), holdMs);
});
process.stdout.write("READY\n");
setInterval(() => {}, 1 << 30);
