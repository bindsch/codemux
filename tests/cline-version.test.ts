import { expect, test } from "bun:test";
import { CLINE_HARNESS_CONTRACT } from "../src/cline-contract.js";
import { evaluateHarnessVersion, extractHarnessVersion } from "../src/harness-compatibility.js";
import { assertClineToolVersion } from "../src/cline-experiment-policy.js";

test("the proposed Cline contract parses only native version output and enforces its audited floor", () => {
  expect(extractHarnessVersion(CLINE_HARNESS_CONTRACT, "3.0.74\n")).toBe("3.0.74");
  expect(extractHarnessVersion(CLINE_HARNESS_CONTRACT, "3.0.74-beta.1\n")).toBe("3.0.74-beta.1");
  expect(extractHarnessVersion(CLINE_HARNESS_CONTRACT, "prefix 3.0.74")).toBeNull();
  expect(CLINE_HARNESS_CONTRACT.unknownVersion).toBe("refuse");
  expect(evaluateHarnessVersion("cline", CLINE_HARNESS_CONTRACT, "3.0.73").kind).toBe("refuse");
  expect(evaluateHarnessVersion("cline", CLINE_HARNESS_CONTRACT, "3.0.74-beta.1").kind).toBe("refuse");
  expect(evaluateHarnessVersion("cline", CLINE_HARNESS_CONTRACT, "3.0.74").kind).toBe("supported");
  expect(() => assertClineToolVersion("3.0.74")).not.toThrow();
  for (const version of [undefined, null, "3.0.75", "3.0.74-beta.1"]) expect(() => assertClineToolVersion(version)).toThrow("requires verified Cline");
});
