/** `/logout` slash command — destroy the on-disk ChatGPT-OAuth token
 *  (ADR-0094 §Follow-up "logout"). Idempotent: if there was no token to
 *  begin with the box still renders cleanly with a "not signed in" line.
 *
 *  By default we simply unlink the bundle so subsequent calls 401 cleanly and
 *  do NOT call any remote `/revoke` endpoint (Codex parity — verified that
 *  `codex-rs/login/src/auth/revoke.rs` is auth-mode-specific and not wired for
 *  the ChatGPT subscription path). When `revokeOnLogout` is ON (knob
 *  `QUANTA_OAUTH_REVOKE_ON_LOGOUT`, jun-6 RFC), logout ALSO best-effort revokes
 *  the refresh token server-side (RFC 7009) BEFORE the local delete — NO-THROW:
 *  a failed revoke is logged + swallowed and the local delete proceeds
 *  unconditionally, so logout never gets worse than today.
 *
 *  Test-seam: `buildLogoutCmd({ env, nowMs, fetchPort, revokeOnLogout })`
 *  mirrors the other auth-cmd builders so the command can be driven against a
 *  tmp prefs home with an injected fetch.
 */

import {
  defaultRevocationEndpoint,
  deleteToken,
  type FetchPort,
  type RevokeLogger,
  readResolvedToken,
  resolveChatgptTokenCandidates,
  resolveOAuthConfig,
  revokeRefreshToken,
  type TokenRecord,
} from "@/auth/chatgpt-oauth"
import { errMessage } from "@/shared"
import { bold, cyan, dim, gray, green, kvLine, red, renderBox, yellow } from "./auth-ui"
import type { SlashCommand, SlashContext } from "./slash-commands"

export interface LogoutDeps {
  readonly env?: Record<string, string | undefined>
  readonly nowMs?: () => number
  /** jun-6 RFC knob (`QUANTA_OAUTH_REVOKE_ON_LOGOUT`), threaded as a param by
   *  the composition root. Default false ⇒ logout is byte-identical to today's
   *  local-delete-only path: no revoke endpoint constructed, no network call. */
  readonly revokeOnLogout?: boolean
  /** Injected fetch seam for the RFC 7009 revoke POST — same discipline as the
   *  OAuth refresh/token POST. Only consulted when `revokeOnLogout` is ON and a
   *  quanta-owned refresh token is present. */
  readonly fetchPort?: FetchPort
  /** Optional structured logger for revoke failures (reason + error.message,
   *  NEVER the token). Absent ⇒ failures are silently swallowed. */
  readonly logger?: RevokeLogger
}

const renderLoggedOut = (
  path: string,
  prior: TokenRecord | null,
  revokeNote: string | null,
): string => {
  const lines: string[] = [
    `${green("✓")} ${bold("Signed out of ChatGPT")}`,
    "",
    kvLine("token", `${gray("deleted")}`, 11),
    kvLine("path", gray(path), 11),
  ]
  if (revokeNote !== null) {
    lines.push(kvLine("revoke", gray(revokeNote), 11))
  }
  if (prior !== null && prior.plan_type !== undefined) {
    lines.push(kvLine("was plan", gray(prior.plan_type), 11))
  }
  if (prior !== null && prior.account_id !== undefined) {
    lines.push(kvLine("was account", gray(prior.account_id), 11))
  }
  lines.push("", `${dim("Sign in again any time with ")}${cyan("/login --chatgpt")}${dim(".")}`)
  return `${renderBox(lines, {
    title: "ChatGPT Sign-Out",
    titleStyle: cyan,
  })}\n`
}

const renderAlreadyOut = (path: string): string =>
  `${renderBox(
    [
      `${yellow("●")} ${bold("Not signed in")}`,
      "",
      kvLine("path", gray(path), 11),
      "",
      `${dim("Nothing to delete. Use ")}${cyan("/login --chatgpt")}${dim(" to sign in.")}`,
    ],
    {
      title: "ChatGPT Sign-Out",
      titleStyle: cyan,
    },
  )}\n`

const renderExternallyManaged = (path: string): string =>
  `${renderBox(
    [
      `${yellow("●")} ${bold("Managed by Codex")}`,
      "",
      kvLine("path", gray(path), 11),
      "",
      `${dim("This token comes from Codex. Sign out there to remove it.")}`,
    ],
    {
      title: "ChatGPT Sign-Out",
      titleStyle: cyan,
    },
  )}\n`

const renderError = (path: string, detail: string): string =>
  `${renderBox(
    [`${red("✗")} ${bold("Logout failed")}`, "", dim(detail), kvLine("path", gray(path), 11)],
    {
      title: "ChatGPT Sign-Out",
      titleStyle: cyan,
    },
  )}\n`

/** jun-6 RFC — best-effort server-side revoke of the resolved refresh token.
 *  Returns the UX note (or null when the knob is off / no token), NEVER throws,
 *  and NEVER gates the caller's unconditional local delete. Extracted so the
 *  command `run` stays flat. */
const maybeRevoke = async (
  deps: LogoutDeps,
  tokenEnv: Record<string, string | undefined>,
  refreshToken: string,
): Promise<string | null> => {
  if (deps.revokeOnLogout !== true || refreshToken.length === 0) return null
  const cfg = resolveOAuthConfig(tokenEnv)
  const fetchPort = deps.fetchPort ?? fetch
  const outcome = await revokeRefreshToken(
    { fetchPort, ...(deps.logger !== undefined ? { logger: deps.logger } : {}) },
    {
      revocationEndpoint: defaultRevocationEndpoint(cfg.issuer),
      clientId: cfg.clientId,
      refreshToken,
    },
  )
  return outcome.ok ? "server session revoked" : "local only (revoke unavailable)"
}

export const buildLogoutCmd = (deps: LogoutDeps = {}): SlashCommand => ({
  name: "/logout",
  describe: "Sign out and delete the ChatGPT-OAuth token from disk",
  category: "auth",
  async run(args, ctx: SlashContext) {
    if (args.length !== 0) {
      ctx.err("/logout: takes no arguments\n")
      return 1
    }
    const env = deps.env ?? process.env
    const tokenEnv = {
      ...env,
      ...(ctx.prefsHome !== undefined ? { QUANTA_PREFS_HOME: ctx.prefsHome } : {}),
    }
    const path = resolveChatgptTokenCandidates(tokenEnv)[0]?.path ?? ""

    let prior: TokenRecord | null = null
    let source: "quanta" | "codex" | null = null
    let pathUsed = path
    try {
      const resolved = await readResolvedToken(tokenEnv)
      prior = resolved?.record ?? null
      source = resolved?.source ?? null
      pathUsed = resolved?.path ?? path
    } catch {
      // Read errors (bad perms / shape) are non-fatal here — the user
      // explicitly asked to delete. Fall through to the delete attempt.
    }

    if (source === "codex") {
      ctx.out(renderExternallyManaged(pathUsed))
      return 2
    }

    if (prior === null) {
      ctx.out(renderAlreadyOut(pathUsed))
      return 0
    }

    // jun-6 RFC — best-effort server-side revoke BEFORE the local delete. The
    // outcome ONLY affects the rendered note; it NEVER gates the unconditional
    // `deleteToken` below. Default-OFF ⇒ revokeNote stays null and the box is
    // byte-identical to today. Codex-managed tokens never reach here (returned
    // at `source === "codex"` above) so we never revoke a credential we don't
    // own.
    const revokeNote = await maybeRevoke(deps, tokenEnv, prior.refresh_token)

    try {
      await deleteToken(pathUsed)
    } catch (e) {
      ctx.err(renderError(pathUsed, errMessage(e)))
      return 1
    }
    ctx.out(renderLoggedOut(pathUsed, prior, revokeNote))
    return 0
  },
})

export const logoutCmd = buildLogoutCmd()
