/**
 * spyOn for a method a prototype inherits. Bun's mockRestore on such a spy
 * leaves an own property on the subclass prototype holding the base
 * function, so a later spy on the base class no longer reaches that
 * subclass. That leak made the parity suite's BaseAdapter.isAvailable spy
 * miss KimiAdapter on Linux, where check-kimi-control-preflight.test.ts ran
 * first (CI run 42681779732: "kimi is not installed"). This wrapper's
 * mockRestore also deletes the own property when the prototype did not
 * own the method before, so the inheritance chain is exactly as it was.
 */
import { spyOn } from "bun:test";

export function spyOnInherited<T extends object, K extends keyof T & string>(
  prototype: T,
  name: K
): ReturnType<typeof spyOn<T, K>> {
  type Spy = ReturnType<typeof spyOn<T, K>>;
  const owned = Object.prototype.hasOwnProperty.call(prototype, name);
  const spy = spyOn(prototype, name);
  // Bun's mock properties are read-only, so the restore is wrapped through
  // a proxy; chained calls (mockReturnValue and friends) return the proxy,
  // never the bare spy whose restore would leak again.
  const proxy: Spy = new Proxy(spy, {
    get(target, property, receiver) {
      if (property === "mockRestore") {
        return () => {
          target.mockRestore();
          if (!owned) delete (prototype as Record<string, unknown>)[name];
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}
