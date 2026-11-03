import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Scans every recording and harness-log copy in a run's recording directory
 * for the relay's bearer prefix and the run's catalog nonce (audit finding
 * 3): the token is written only to the private home's MCP configuration, and
 * a harness that logged its MCP transport would copy it into these
 * persistent files. Reading as latin1 compares raw bytes, not decoded text.
 */
export function assertNoRelaySecretsInRecordings(recordingPath: string, catalogUrl?: string): void {
  const directory = dirname(recordingPath);
  const nonce = catalogUrl ? new URL(catalogUrl).pathname.split("/").pop() ?? "" : "";
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".jsonl")) continue;
    const bytes = readFileSync(join(directory, entry), "latin1");
    if (bytes.includes("Bearer ")) {
      throw new Error(`recording ${entry} contains a bearer token`);
    }
    if (nonce !== "" && bytes.includes(nonce)) {
      throw new Error(`recording ${entry} contains the catalog nonce`);
    }
  }
}
