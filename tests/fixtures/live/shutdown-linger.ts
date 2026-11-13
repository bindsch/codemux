/** Synthetic shutdown behavior shared by the persistent harness fixtures. */
export function lingerOnShutdown(): boolean {
  const mode = process.env.FAKE_SHUTDOWN_LINGER;
  if (!mode) return false;
  if (mode === "exit143" || mode === "exit42") process.exit(Number(mode.slice(4)));
  setInterval(() => {}, 1000);
  if (mode === "SIGKILL") process.on("SIGTERM", () => {});
  if (mode === "143") process.on("SIGTERM", () => process.exit(143));
  return true;
}
