/** Observe the fake native process after the launcher's environment prefixes. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const state = process.env.FAKE_STATE_DIR!;
const data = join(process.env.XDG_DATA_HOME!, "opencode");
mkdirSync(data, { recursive: true, mode: 0o700 });
const database = join(data, "opencode.db");
const previous = existsSync(database);
const db = new Database(database, { create: true });
db.exec("CREATE TABLE IF NOT EXISTS account (id TEXT, url TEXT); " +
  "CREATE TABLE IF NOT EXISTS account_state (active_account_id TEXT, active_org_id TEXT)");
db.close();
appendFileSync(join(state, "observations.jsonl"), JSON.stringify({
  home: process.env.HOME,
  configHome: process.env.XDG_CONFIG_HOME,
  dataHome: process.env.XDG_DATA_HOME,
  stateHome: process.env.XDG_STATE_HOME,
  config: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null,
  permission: process.env.OPENCODE_PERMISSION ?? null,
  providerConfig: process.env.OPENCODE_CONFIG ?? null,
  provider: process.env.OPENCODE_CONFIG ? JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, "utf8")) : null,
  database,
  previous,
  mode: statSync(data).mode & 0o777,
}) + "\n");
