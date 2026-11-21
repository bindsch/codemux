import { BaseAdapter } from "./base.js";
import { claudeCredentialTarget } from "../credentials.js";

/** Claude owns its native login. Only non-macOS private homes copy an access token. */
export abstract class ClaudeCredentialAdapter extends BaseAdapter {
  protected credentialTarget: () => string = () => claudeCredentialTarget(this.environment.HOME);
}
