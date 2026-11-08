/** The account-store activation query behind the hermetic gate's
 * organization check (round 372, item 13): the carrier rows are selected
 * by shape — any state row whose account exists and whose organization is
 * set — never by the singleton id opencode 1.18.18 happens to write, and
 * a schema the query cannot read fails closed. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { opencodeRemoteConfigCarrier } from "../src/opencode-remote-config.js";

describe("the opencode account-store query", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A store with the audited 1.18.18 shape, its state row at the given id. */
  const store = (stateId: number): string => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-opencode-schema-"));
    dirs.push(dir);
    const db = new Database(join(dir, "opencode.db"));
    db.exec("CREATE TABLE account (id TEXT PRIMARY KEY, url TEXT NOT NULL)");
    db.exec("CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT)");
    db.exec("INSERT INTO account VALUES ('acct', 'https://console.example')");
    db.exec(`INSERT INTO account_state VALUES (${stateId}, 'acct', 'org-1')`);
    db.close();
    return dir;
  };

  test("selects the carrier row by shape, whatever id the schema keys it under (round 372, item 13)", () => {
    // The pinned 1.18.18 writes the singleton at id 1; a schema revision
    // that keys the row differently matched nothing under `state.id = 1`
    // and the check silently answered "no carrier" — fail-open on the
    // gate that refuses --hermetic and --tools none.
    expect(opencodeRemoteConfigCarrier(store(1))).toContain("an OpenCode account (https://console.example)");
    expect(opencodeRemoteConfigCarrier(store(7))).toContain("an OpenCode account (https://console.example)");
  });

  test("a schema the query cannot read fails closed, never as absent", () => {
    // The state table gone (renamed, reworked) is a store whose content
    // cannot be ruled out: the refusal names the file.
    const dir = mkdtempSync(join(tmpdir(), "codemux-opencode-schema-"));
    dirs.push(dir);
    const db = new Database(join(dir, "opencode.db"));
    db.exec("CREATE TABLE account (id TEXT PRIMARY KEY, url TEXT NOT NULL)");
    db.close();
    const verdict = opencodeRemoteConfigCarrier(dir);
    expect(verdict).toContain("the account store");
    expect(verdict).toContain("could not be read");
  });
});
