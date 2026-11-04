/**
 * A session child with the default signal dispositions that exits 0 once
 * its stdin reaches EOF: the shape of a harness given an orderly shutdown
 * (review round 69). One line, "READY", is written to stdout once the
 * stdin listener is installed; nothing else is written. A SIGTERM would
 * kill it with the default disposition, so a driver that signals first
 * turns this clean exit into a signal exit.
 */
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
process.stdout.write("READY\n");
setInterval(() => {}, 1 << 30);
