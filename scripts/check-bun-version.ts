import { isVersionAtLeast, parseVersion } from "../src/cli-runtime.js";
import packageJson from "../package.json";

// `packageManager` pins the exact Bun that CI provisions, which is what makes
// release builds reproducible. Locally it is treated as a floor instead: a
// newer Bun is fine, and an older one is not. Requiring an exact match here
// broke the gate every time Homebrew moved ahead of the pin.
const pinned = packageJson.packageManager.match(/^bun@(.+)$/)?.[1];

if (!pinned) {
  console.error("package.json packageManager must pin an exact Bun version");
  process.exit(1);
}

const minimum = parseVersion(pinned);
if (!minimum) {
  console.error(`could not parse pinned Bun version '${pinned}'`);
  process.exit(1);
}

const actual = parseVersion(Bun.version);
if (!actual) {
  console.error(`could not parse current Bun version '${Bun.version}'`);
  process.exit(1);
}

if (!isVersionAtLeast(actual, minimum)) {
  console.error(`Bun ${pinned} or newer is required; current runtime is ${Bun.version}`);
  process.exit(1);
}

console.log(
  Bun.version === pinned
    ? `Bun ${Bun.version} matches the package.json pin`
    : `Bun ${Bun.version} satisfies the package.json floor of ${pinned}`
);
