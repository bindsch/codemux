import { expect } from "bun:test";

/** Consumer assertions for codemux-live-session/1, independent of builders. */
export function assertSessionConformance(events: Record<string, any>[]): void {
  expect(events.length).toBeGreaterThan(0);
  let previous = 0;
  for (const event of events) {
    expect(Object.keys(event).slice(0, 5)).toEqual(["seq", "ts", "session_id", "type", "raw"]);
    expect(Number.isSafeInteger(event.seq)).toBe(true);
    expect(event.seq).toBeGreaterThan(previous); previous = event.seq;
    expect(new Date(event.ts).toISOString()).toBe(event.ts);
    expect(typeof event.session_id).toBe("string");
    expect(event.raw === null || typeof event.raw === "string").toBe(true);
    if (event.type === "tool_call" || event.type === "permission_request") {
      expect(event.input).not.toBeNull();
      expect(typeof event.input).toBe("object");
      expect(Array.isArray(event.input)).toBe(false);
      expect(() => Object.entries(event.input)).not.toThrow();
    }
    if (event.type === "session_started" || event.type === "turn_completed") {
      expect(Object.hasOwn(event, "model_served")).toBe(true);
      expect(Object.hasOwn(event, "model_served_source")).toBe(true);
      expect(Object.hasOwn(event, "model_alias")).toBe(true);
    }
  }
}
