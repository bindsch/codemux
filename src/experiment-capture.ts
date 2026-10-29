/** Keep complete UTF-8 characters within the runner's remaining byte budget. */
export function capturePrefix(chunk: string, remaining: number): string {
  if (Buffer.byteLength(chunk) <= remaining) return chunk;
  return new TextDecoder().decode(Buffer.from(chunk).subarray(0, Math.max(0, remaining)), { stream: true });
}
