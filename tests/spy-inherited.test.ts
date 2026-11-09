import { expect, spyOn, test } from "bun:test";
import { spyOnInherited } from "./helpers/spy-inherited.js";

class Base { answer(): string { return "base"; } }
class Child extends Base {}
class Override extends Base { override answer(): string { return "override"; } }

test("restoring a spy on an inherited method leaves no own property behind", () => {
  const spy = spyOnInherited(Child.prototype, "answer").mockReturnValue("mock");
  expect(new Child().answer()).toBe("mock");
  spy.mockRestore();
  expect(Object.prototype.hasOwnProperty.call(Child.prototype, "answer")).toBe(false);
  // The point of the cleanup: a later spy on the base reaches the child.
  const base = spyOn(Base.prototype, "answer").mockReturnValue("base mock");
  try { expect(new Child().answer()).toBe("base mock"); } finally { base.mockRestore(); }
});

test("restoring a spy on an owned method keeps the class's own override", () => {
  const spy = spyOnInherited(Override.prototype, "answer").mockReturnValue("mock");
  spy.mockRestore();
  expect(Object.prototype.hasOwnProperty.call(Override.prototype, "answer")).toBe(true);
  expect(new Override().answer()).toBe("override");
});
