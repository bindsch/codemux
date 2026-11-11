/** A native session identity is one path component, never a path. Apply
 * this boundary to every harness grammar, including permissive native IDs. */
export const SAFE_SESSION_ID_PATTERN = /^(?!\.{1,2}$)[^\s/\\\0]+$/;

export function sessionIdPattern(native: RegExp): RegExp {
  return new RegExp(`(?=${SAFE_SESSION_ID_PATTERN.source})(?:${native.source})`, native.flags);
}

export function assertSafeSessionId(id: string): void {
  if (!SAFE_SESSION_ID_PATTERN.test(id)) throw new Error("a session id must be a single safe path component");
}
