import {
  getScodeCompatibilityStatus,
} from "../src/cli-runtime.js";

const scode = await getScodeCompatibilityStatus();
if (!scode.available) {
  console.log("scode is not installed; sandbox contract skipped");
  process.exit(0);
}

if (scode.issue) {
  console.error(scode.issue);
  process.exit(1);
}

console.log("scode sandbox contract passed");
