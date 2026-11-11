/** Round 11: exercise actual Bun fetch in fresh broker processes. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearProxyEnvironment, resolveUpstream } from "../src/complete/provider.js";
import { ledgerScratch } from "./helpers/complete-fakes.js";
import { proxyCertificate, proxyFakes } from "./helpers/complete-proxy-fakes.js";

const PROXY_VARS = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"];
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
let certificate: ReturnType<typeof proxyCertificate>;
beforeAll(() => { certificate = proxyCertificate(); });
afterAll(() => certificate?.cleanup());
const request = { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] };
const source = `
  import { Command } from "commander";
  import { defaultDeps, registerCompleteCommand } from ${JSON.stringify(new URL("../src/complete/command.ts", import.meta.url).href)};
  const deps = defaultDeps();
  const output = deps.stdout;
  deps.stdout = (line) => {
    console.error("PROXY_ENV=" + JSON.stringify(${JSON.stringify(PROXY_VARS)}.filter(name => name in process.env)));
    output(line);
  };
  const program = new Command();
  registerCompleteCommand(program, () => deps);
  await program.parseAsync(["bun", "codemux", "complete", ...JSON.parse(process.env.TEST_ARGS)]);
`;

async function run(mode: "serve" | "once", baseUrl: string, env: NodeJS.ProcessEnv, proxy?: string) {
  const scratch = ledgerScratch();
  cleanups.push(scratch.cleanup);
  const file = join(scratch.dir, "request.json");
  writeFileSync(file, JSON.stringify(request));
  const args = [mode, "--provider", "openai-compatible", "--base-url", baseUrl, "--key-env", "TEST_KEY", "--timeout", "3",
    ...(mode === "serve" ? ["--budget-usd", "1", "--max-requests", "1"] : ["-f", file]),
    ...(proxy === undefined ? [] : ["--proxy", proxy])];
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH, TEST_KEY: "synthetic-key", CODEMUX_CALL_LOG: "off",
      NODE_EXTRA_CA_CERTS: certificate.ca, TEST_ARGS: JSON.stringify(args), ...env },
  });
  cleanups.push(() => child.kill());
  const err = new Response(child.stderr).text();
  let output = "";
  if (mode === "serve") {
    const reader = child.stdout.getReader();
    while (!output.includes("\n")) {
      const next = await reader.read();
      if (next.done) break;
      output += new TextDecoder().decode(next.value);
    }
    if (output) {
      const ready = JSON.parse(output.split("\n")[0]!) as { base_url: string; token: string };
      const response = await fetch(`${ready.base_url}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${ready.token}` }, body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty("id", "chatcmpl-1");
    }
    reader.releaseLock();
  } else {
    output = await new Response(child.stdout).text();
  }
  return { code: await child.exited, output, err: await err };
}

type EnvCase = [string, (proxy: string) => NodeJS.ProcessEnv];
const cases: EnvCase[] = [
  ...PROXY_VARS.map((name): EnvCase => [name, (proxy) => ({ [name]: name.toLowerCase() === "no_proxy" ? "unrelated.invalid" : proxy })]),
  ["all eight", (proxy) => Object.fromEntries(PROXY_VARS.map((name) => [name, name.toLowerCase() === "no_proxy" ? "unrelated.invalid" : proxy]))],
  ...["0.0.1", "1", "127.0.0.1:1", "127.0.0.1", "*"].map((value): EnvCase =>
    [`NO_PROXY=${value}`, (proxy) => ({ HTTP_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: value })]),
  ["conflicting case and empty values", (proxy) => ({ HTTP_PROXY: "", http_proxy: proxy, HTTPS_PROXY: proxy,
    all_proxy: proxy, no_proxy: "unrelated.invalid", NO_PROXY: "127.0.0.1" })],
];

describe("upstream connections ignore inherited proxies", () => {
  for (const mode of ["serve", "once"] as const) {
    for (const secure of [false, true]) {
      for (const [label, environment] of cases) {
        test(`${mode} ${secure ? "HTTPS" : "HTTP"}: ${label} connects directly`, async () => {
          const fake = await proxyFakes(secure ? certificate.tls : undefined);
          cleanups.push(fake.stop);
          const result = await run(mode, fake.baseUrl, environment(fake.proxyUrl));
          expect(result.err).toContain("PROXY_ENV=[]");
          expect(result.code).toBe(0);
          expect(fake.credentials).toEqual(["Bearer synthetic-key"]);
          expect(fake.requests()).toBe(0);
          if (mode === "once") expect(JSON.parse(result.output)).toHaveProperty("id", "chatcmpl-1");
        });
      }
    }
  }
});

describe("explicit proxy", () => {
  for (const mode of ["serve", "once"] as const) {
    test(`${mode} --proxy tunnels HTTPS even with environment exclusions`, async () => {
      const fake = await proxyFakes(certificate.tls);
      const ambient = await proxyFakes();
      cleanups.push(fake.stop, ambient.stop);
      const result = await run(mode, fake.baseUrl, {
        ...Object.fromEntries(PROXY_VARS.map((name) => [name, ambient.proxyUrl])), no_proxy: "*", NO_PROXY: "127.0.0.1",
      }, fake.proxyUrl);
      expect(result.code).toBe(0);
      expect(result.err).toContain("PROXY_ENV=[]");
      expect(fake.credentials).toEqual(["Bearer synthetic-key"]);
      expect(fake.targets).toEqual([new URL(fake.baseUrl).host]);
      expect(fake.requests()).toBe(1);
      expect(ambient.requests()).toBe(0);
    });
    test(`${mode} refuses cleartext plus --proxy before any request`, async () => {
      const fake = await proxyFakes();
      cleanups.push(fake.stop);
      const result = await run(mode, fake.baseUrl, { NO_PROXY: "*" }, fake.proxyUrl);
      expect(result.code).toBe(64);
      expect(result.err).toContain("--proxy is refused for a plain-http upstream");
      expect(result.output).toBe("");
      expect(fake.credentials).toEqual([]);
      expect(fake.requests()).toBe(0);
    });
  }
  test.each(["", "not-a-url", "socks5://localhost:1234", "http://localhost/path", "http://localhost/?x=1", "http://localhost/#x"])
  ("invalid proxy %j is refused without quoting credentials", (proxy) => {
    expect(() => resolveUpstream("openai", undefined, "KEY", { KEY: "synthetic-key" }, proxy)).toThrow("--proxy must be");
  });
  test("HTTPS proxies are also refused for cleartext upstreams", () => {
    expect(() => resolveUpstream("openai-compatible", "http://localhost/v1", "KEY", { KEY: "synthetic-key" }, "https://localhost:3128"))
      .toThrow("cleartext");
  });
  test("the scrub removes only proxy environment settings", () => {
    const env = { ...Object.fromEntries(PROXY_VARS.map((name) => [name, "value"])), KEY: "synthetic-key", PATH: "/bin" };
    clearProxyEnvironment(env);
    expect(env).toEqual({ KEY: "synthetic-key", PATH: "/bin" });
  });
});
