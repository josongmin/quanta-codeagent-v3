/** OAuth configuration constants for ChatGPT-subscription auth.
 *
 *  Values are byte-identical to those used by Codex CLI (codex-rs/login)
 *  EXCEPT for `client_id`, which is intentionally left as a placeholder so a
 *  quanta-specific OAuth client can be plugged in via env (see ADR-0094
 *  follow-up). Codex's `ServerOptions` likewise takes client_id as a
 *  parameter rather than baking one in.
 */

export const DEFAULT_ISSUER = "https://auth.openai.com"
export const ISSUER_ENV = "QUANTA_OAUTH_ISSUER"

export const DEFAULT_API_BASE = "https://chatgpt.com/backend-api"
export const API_BASE_ENV = "QUANTA_CHATGPT_API_BASE"

/** OAuth scopes (verbatim from codex-rs/login/src/server.rs). */
export const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
] as const

export const SCOPE_STRING = SCOPES.join(" ")

/** Local callback ports — Codex uses 1455 with 1457 fallback. */
export const CALLBACK_PORTS = [1455, 1457] as const
export const CALLBACK_PATH = "/auth/callback"
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** OAuth client id — Codex CLI's public OAuth app id, verbatim from the OSS
 *  `openai/codex` repo (`codex-rs/login/src/auth/manager.rs`). Re-using it
 *  keeps Phase 1 wire-compatible with the OpenAI backend's existing client
 *  routing — end users do NOT need to register their own OAuth app for the
 *  ChatGPT-subscription path to work; `/login` just opens the browser to
 *  the standard OpenAI sign-in. The env override lets operators plug a
 *  quanta-specific OAuth app in once Phase 2 registers one. */
export const CLIENT_ID_ENV = "QUANTA_OAUTH_CLIENT_ID"
export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

/** Product-SKU header. `CODEX` is byte-identical with the Codex CLI request
 *  — the OpenAI backend uses this header to route the token to the ChatGPT
 *  subscription billing line, so the value matters semantically. */
export const SKU_ENV = "QUANTA_OAUTH_SKU"
export const DEFAULT_SKU = "CODEX"

/** Originator header — identifies the calling client. Default `codex_cli`
 *  mirrors the OSS Codex CLI so this `client_id + originator` pair is the
 *  one the OpenAI backend already accepts. Operators wanting a distinct
 *  telemetry tag override via env. */
export const ORIGINATOR_ENV = "QUANTA_OAUTH_ORIGINATOR"
export const DEFAULT_ORIGINATOR = "codex_cli"

export interface OAuthConfig {
  readonly issuer: string
  readonly clientId: string
  readonly apiBase: string
  readonly sku: string
  readonly originator: string
}

export const resolveOAuthConfig = (env: Record<string, string | undefined>): OAuthConfig => ({
  issuer: env[ISSUER_ENV] ?? DEFAULT_ISSUER,
  clientId: env[CLIENT_ID_ENV] ?? DEFAULT_CLIENT_ID,
  apiBase: env[API_BASE_ENV] ?? DEFAULT_API_BASE,
  sku: env[SKU_ENV] ?? DEFAULT_SKU,
  originator: env[ORIGINATOR_ENV] ?? DEFAULT_ORIGINATOR,
})

/** Refuse only when the operator has explicitly *cleared* the client id
 *  (`QUANTA_OAUTH_CLIENT_ID=""`). The default (Codex's public OAuth app id)
 *  always passes — `/login` works out of the box. */
export const isClientIdConfigured = (cfg: OAuthConfig): boolean => cfg.clientId.length > 0
