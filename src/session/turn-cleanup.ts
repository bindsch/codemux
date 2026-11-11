/** One turn owns its resources even when another session finishes first.
 * Cleanup failures leave the resource's exit hook available for retry. */
export function turnCleanup() {
  const callbacks: (() => void)[] = [];
  return {
    register(cleanup: () => void): void { callbacks.push(cleanup); },
    finalize(): void {
      for (const cleanup of callbacks.splice(0)) {
        try { cleanup(); }
        catch (error) { console.error(`codemux: ${error instanceof Error ? error.message : String(error)}`); }
      }
    },
  };
}
