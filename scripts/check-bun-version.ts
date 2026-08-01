import packageJson from "../package.json";

const expected = packageJson.packageManager.match(/^bun@(.+)$/)?.[1];

if (!expected) {
  console.error("package.json packageManager must pin an exact Bun version");
  process.exit(1);
}

if (Bun.version !== expected) {
  console.error(`Bun ${expected} is required; current runtime is ${Bun.version}`);
  process.exit(1);
}

console.log(`Bun ${Bun.version} matches package.json`);
