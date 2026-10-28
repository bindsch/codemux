import { describe, expect, test } from "bun:test";
import { collectLabel, parseLabels, validateLabelKey } from "../src/labels.js";
import { UsageRefusalError } from "../src/validation.js";

describe("label parsing", () => {
  test("absent and empty environment labels produce null", () => {
    expect(parseLabels()).toBeNull();
    expect(parseLabels([], "")).toBeNull();
  });

  test("repeated flags preserve values, including empty values and equals signs", () => {
    const flags = collectLabel("wf=review", []);
    expect(parseLabels(collectLabel("step=a=b", flags))).toEqual({ wf: "review", step: "a=b" });
    expect(parseLabels(["key="])).toEqual({ key: "" });
  });

  test("environment fallback parses comma-separated pairs", () => {
    expect(parseLabels(undefined, "wf=review,step=a=b,key=")).toEqual({
      wf: "review", step: "a=b", key: "",
    });
    expect(parseLabels([], "wf=review")).toEqual({ wf: "review" });
  });

  test("any flag ignores the environment entirely", () => {
    expect(parseLabels(["step=scan"], "bad")).toEqual({ step: "scan" });
    expect(parseLabels(["wf=flag"], "wf=env,seat=judge")).toEqual({ wf: "flag" });
  });

  test("keys accept the specified characters and length boundary", () => {
    for (const key of ["a", "wf.step_1-2", "a".repeat(64), "constructor", "tostring"]) {
      expect(validateLabelKey(key)).toBe(key);
      expect(parseLabels([`${key}=ok`])).toEqual({ [key]: "ok" });
    }
  });

  test.each(["", "A", "1key", "_key", ".key", "-key", "a b", "a/b", "é", "a".repeat(65), "a\n"])(
    "rejects invalid key %j", (key) => {
      expect(() => parseLabels([`${key}=ok`])).toThrow(UsageRefusalError);
      expect(() => parseLabels([`${key}=ok`])).toThrow(JSON.stringify(`${key}=ok`));
    }
  );

  test("labels require an equals sign", () => {
    expect(() => parseLabels(["broken"])).toThrow('"broken"');
    expect(() => parseLabels(["broken"])).toThrow(UsageRefusalError);
  });

  test("duplicate keys fail even when values agree", () => {
    expect(() => parseLabels(["wf=a", "wf=b"])).toThrow('"wf=b"');
    expect(() => parseLabels(["wf=a", "wf=a"])).toThrow(UsageRefusalError);
  });

  test("values allow exactly 256 UTF-8 bytes", () => {
    expect(parseLabels([`key=${"x".repeat(256)}`])?.key).toHaveLength(256);
    expect(parseLabels([`key=${"é".repeat(128)}`])?.key).toHaveLength(128);
    expect(() => parseLabels([`key=${"x".repeat(257)}`])).toThrow(UsageRefusalError);
    expect(() => parseLabels([`key=${"é".repeat(129)}`])).toThrow(UsageRefusalError);
  });

  test("every C0 control and DEL is rejected with a one-line error", () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      const label = `key=a${String.fromCharCode(code)}b`;
      try {
        parseLabels([label]);
        throw new Error("accepted control character");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageRefusalError);
        expect((error as Error).message).toContain(JSON.stringify(label).replace(/\x7f/g, "\\u007f"));
        expect((error as Error).message).not.toMatch(/[\x00-\x1f\x7f]/);
      }
    }
  });

  test("every C1 control is rejected in values and by the existing KEY pattern", () => {
    for (let code = 0x80; code <= 0x9f; code++) {
      const control = String.fromCharCode(code);
      const escape = `\\u${code.toString(16).padStart(4, "0")}`;
      for (const label of [`wf=a${control}b`, `w${control}f=ok`]) {
        for (const parse of [() => parseLabels([label]), () => parseLabels(undefined, label)]) {
          expect(parse).toThrow(UsageRefusalError);
          expect(parse).toThrow(escape);
          try { parse(); } catch (error) {
            expect((error as Error).message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
          }
        }
      }
      expect(() => validateLabelKey(`w${control}f`)).toThrow("KEY must match");
    }
  });

  test("printable Unicode, spaces, commas, and equals signs remain intact", () => {
    expect(parseLabels(["key=中文 😀, a=b"])?.key).toBe("中文 😀, a=b");
  });

  test.each(["bad", "=value", "A=value", "wf=a,wf=b", "wf=a,", ",wf=a", "wf=a,,step=b", "key=a\nb"])(
    "malformed environment %j is a usage error", (environment) => {
      expect(() => parseLabels(undefined, environment)).toThrow(UsageRefusalError);
    }
  );
});
