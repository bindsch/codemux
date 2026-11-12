/** Cursor's endpoint selects its account backend, not an isolated provider. */
export const CURSOR_PROVIDER_REFUSAL =
  "cursor provider override is unsupported: its dashboard can send the saved account credential to the override endpoint";

export const CURSOR_PROVIDER_REASON =
  "Cursor 2026.11.05 routes DashboardService/GetMe to the override endpoint with the saved account token. " +
  "A memory credential store prevents saved-token reads, but API-key login still requires Cursor's token exchange and native ConnectRPC model protocol. " +
  "Direct provider transport and authless mode require the separate agent-cli-local runtime.";

export const CURSOR_PROVIDER_EVIDENCE =
  "2026-11-12: live gate H2 recorded a foreign credential on POST /aiserver.v1.DashboardService/GetMe. " +
  "Cursor 2026.11.05-86047df index.js: api-key-auth.ts, auth-info-sync.ts, cursor-config/dist/dashboard.js " +
  "(getAccessToken before API-key refresh), credential-manager.ts (memory store), auth/login.js " +
  "(/auth/exchange_user_api_key with an empty JSON body), agent-client.ts (modelDetails/requestedModel), and preAction/local-agent-provider-config.ts " +
  "(--authless and --base-url require agent-cli-local).";
