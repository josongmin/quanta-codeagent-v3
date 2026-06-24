import { isExpired } from "@/auth/chatgpt-oauth"

/**
 * What full-remote ships to the box for it to run patch-gen: the MINIMAL stripped
 * credential + the undeclared "phantom" deps a clean box's `bun install` misses.
 * Extracted from `box-session.ts`. PURE data-shaping (no IO).
 */

/**
 * Reduce a chatgpt.json to the MINIMUM the box needs: the short-lived
 * `access_token` + non-secret account fields. The long-lived `refresh_token`
 * and `id_token` are dropped so a box compromise can't mint fresh credentials.
 */
/** Placeholder for the long-lived secrets we refuse to ship. The token-store
 *  loader only requires `refresh_token`/`id_token` to be NON-EMPTY strings — it
 *  never uses them for a short run (access_token is valid + never refreshed). */
const REDACTED = "REDACTED-not-shipped-to-remote"
const REMOTE_AUTH_EXPIRY_SKEW_MS = 60_000

const parseRemoteAuthRecord = (authJson: string): Record<string, unknown> => {
  const parsed = JSON.parse(authJson) as Record<string, unknown>
  // Fail fast: a token file with no usable access_token would still ship (with
  // REDACTED placeholders) and the box would run 0 turns / empty patch after a
  // full provision cycle — an expensive silent waste. Catch it before launch.
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error(
      "[full-remote] auth json has no usable access_token — cannot run patch-gen on the box " +
        "(re-login locally: `quanta /login`).",
    )
  }
  // Same fail-fast for `expires_at`: the box-side token-store loader
  // (parseTokenRecordObject in token-store.ts) HARD-REQUIRES it as a non-empty
  // string — we ship REDACTED placeholders for refresh_token/id_token but there
  // is NO placeholder for expires_at, so a source token missing it would ship,
  // then throw "missing/invalid field: expires_at" on the box AFTER the full
  // provision cycle (the same expensive silent waste the access_token guard
  // above prevents). Catch it locally instead.
  if (typeof parsed.expires_at !== "string" || parsed.expires_at === "") {
    throw new Error(
      "[full-remote] auth json has no usable expires_at — the box token loader requires it " +
        "(re-login locally: `quanta /login`).",
    )
  }
  return parsed
}

export const assertRemoteAccessTokenFreshEnough = (authJson: string, nowMs = Date.now()): void => {
  const parsed = parseRemoteAuthRecord(authJson)
  if (isExpired({ expires_at: parsed.expires_at as string }, nowMs, REMOTE_AUTH_EXPIRY_SKEW_MS)) {
    throw new Error(
      "[full-remote] auth json access_token is expired or too close to expiry for box launch " +
        "(re-login locally: `quanta /login`).",
    )
  }
}

export const stripToAccessToken = (authJson: string): string => {
  const parsed = parseRemoteAuthRecord(authJson)
  // Whitelist of the non-secret fields the box ACTUALLY needs (verified jun-20
  // against token-store.ts + the chatgpt-oauth adapter):
  //   - access_token : the bearer the box runs patch-gen with (guarded above);
  //   - account_id   : sent as the `chatgpt-account-id` request header — without
  //                    it the box hits the wrong/default account;
  //   - expires_at   : loader-required (guarded above), drives the pre-refresh
  //                    skip so a short run never tries to refresh;
  //   - last_refresh / plan_type : UX/telemetry only, harmless to keep.
  // refresh_token / id_token are DELIBERATELY excluded (long-lived secrets) and
  // re-added below as REDACTED placeholders only to satisfy the loader's shape.
  const safe: Record<string, unknown> = {}
  for (const k of ["access_token", "account_id", "expires_at", "last_refresh", "plan_type"]) {
    if (parsed[k] !== undefined) safe[k] = parsed[k]
  }
  // The loader hard-requires non-empty refresh_token + id_token fields. Satisfy
  // the shape with REDACTED placeholders so the REAL long-lived secrets stay
  // home — for a short run the access_token never expires, so refresh (which
  // would need the real value) is never invoked.
  safe.refresh_token = REDACTED
  safe.id_token = REDACTED
  return JSON.stringify(safe)
}

/**
 * Packages `src/` imports that are NOT declared in package.json/bun.lock (they
 * survive locally only because they sit in a dev's node_modules). A clean
 * `bun install` on a fresh box misses them, so full-remote `bun add`s them.
 * All pure-JS (no native ABI) so they install cleanly on the linux box.
 * FIXME: these belong in the repo's package.json — a fresh clone breaks without
 * them. (Discovered 2026-06-16 via the full-remote clean-box run.)
 */
export const PHANTOM_DEPS = [
  "turndown",
  "@secretlint/core",
  "@secretlint/secretlint-rule-preset-recommend",
  "@secretlint/types",
  "write-file-atomic",
  "csv-parse",
] as const
