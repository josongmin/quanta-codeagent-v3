/** `/logout` slash command — destroy the on-disk ChatGPT-OAuth token
 *  (ADR-0094 §Follow-up "logout"). Idempotent: if there was no token to
 *  begin with the box still renders cleanly with a "not signed in" line.
 *  Does NOT call any remote `/revoke` endpoint — Codex itself doesn't
 *  (verified in `codex-rs/login/src/auth/revoke.rs` is auth-mode-specific
 *  and not wired for the ChatGPT subscription path). We simply unlink the
 *  bundle so subsequent calls 401 cleanly.
 *
 *  Test-seam: `buildLogoutCmd({ env, nowMs })` mirrors the other auth-cmd
 *  builders so the command can be driven against a tmp prefs home.
 */

import {
  deleteToken,
  readResolvedToken,
  resolveChatgptTokenCandidates,
  type TokenRecord,
} from "@/auth/chatgpt-oauth"
import { bold, cyan, dim, gray, green, kvLine, red, renderBox, yellow } from "./auth-ui"
import type { SlashCommand, SlashContext } from "./slash-commands"

export interface LogoutDeps {
  readonly env?: Record<string, string | undefined>
  readonly nowMs?: () => number
}

const renderLoggedOut = (path: string, prior: TokenRecord | null): string => {
  const lines: string[] = [
    `${green("✓")} ${bold("Signed out of ChatGPT")}`,
    "",
    kvLine("token", `${gray("deleted")}`, 11),
    kvLine("path", gray(path), 11),
  ]
  if (prior !== null && prior.plan_type !== undefined) {
    lines.push(kvLine("was plan", gray(prior.plan_type), 11))
  }
  if (prior !== null && prior.account_id !== undefined) {
    lines.push(kvLine("was account", gray(prior.account_id), 11))
  }
  lines.push(
    "",
    `${dim("Sign in again any time with ")}${cyan("/login --chatgpt")}${dim(".")}`,
  )
  return `${renderBox(lines, {
    title: "ChatGPT Sign-Out",
    titleStyle: cyan,
    footer: "ADR-0094 · chatgpt-oauth Phase 2",
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
      footer: "ADR-0094 · chatgpt-oauth Phase 2",
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
      footer: "ADR-0094 · chatgpt-oauth Phase 2",
    },
  )}\n`

const renderError = (path: string, detail: string): string =>
  `${renderBox(
    [`${red("✗")} ${bold("Logout failed")}`, "", dim(detail), kvLine("path", gray(path), 11)],
    {
      title: "ChatGPT Sign-Out",
      titleStyle: cyan,
      footer: "ADR-0094 · chatgpt-oauth Phase 2",
    },
  )}\n`

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

    try {
      await deleteToken(pathUsed)
    } catch (e) {
      ctx.err(renderError(pathUsed, (e as Error).message))
      return 1
    }
    ctx.out(renderLoggedOut(pathUsed, prior))
    return 0
  },
})

export const logoutCmd = buildLogoutCmd()
