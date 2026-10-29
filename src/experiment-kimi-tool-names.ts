/** Matches the component sanitizer in Kimi's mcpCore/tool-naming.ts. */
export function sanitizeKimiToolNamePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
}
