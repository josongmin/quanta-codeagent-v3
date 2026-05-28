/** `/status` slash command — show provider/auth/token state (ADR-0094 Slice C).
 *
 *  Renders a rounded status panel with three sections:
 *   - Active provider (resolved from QUANTA_PROVIDER + key env state).
 *   - BYOK env vars (anthropic/openai key presence).
 *   - ChatGPT-OAuth token state (plan / account / expires / file path).
 *
 *  Read-only: never refreshes / mutates the token store. Reads tolerate
 *  permission / shape errors gracefully (surfaces them in the box so the
 *  user knows why, instead of failing silently).
 */

import {
  type ChatgptTokenSource,
  isExpired,
  readResolvedToken,
  resolveChatgptTokenCandidates,
  type TokenRecord,
} from "@/auth/chatgpt-oauth"
import { pickProvider } from "@/llm"
import {
  bold,
  cyan,
  dim,
  expiryColor,
  gray,
  green,
  humanRel,
  kvLine,
  red,
  renderBox,
  yellow,
} from "./auth-ui"
import type { SlashCommand, SlashContext } from "./slash-commands"

export interface StatusDeps {
  readonly env?: Record<string, string | undefined>
  readonly nowMs?: () => number
}

/** Human-readable auth-mode badge — identical to the runtime
 *  `llm_request` line so the user sees the SAME phrase in `/status` and at
 *  every model call. Single source of truth → keep these strings in lockstep
 *  with the adapters' `authMode` property. */
const AUTH_MODE_LABEL: Record<string, string> = {
  "chatgpt-oauth": "ChatGPT subscription",
  openai: "OpenAI BYOK",
  anthropic: "Anthropic BYOK",
}

const authBadge = (provider: string): string => {
  const label = AUTH_MODE_LABEL[provider]
  return label !== undefined ? ` ${dim("·")} ${cyan(label)}` : ""
}

const resolveActiveProvider = (
  env: Record<string, string | undefined>,
  hasToken: boolean,
): { name: string; styled: string } => {
  const provider = pickProvider(env)
  if (provider === "chatgpt-oauth") {
    if (!hasToken) {
      return {
        name: provider,
        styled: `${cyan(provider)} ${red("(no token — run /login)")}`,
      }
    }
    return {
      name: provider,
      styled:
        env.QUANTA_PROVIDER === "chatgpt-oauth"
          ? `${cyan(provider)}${authBadge(provider)}`
          : `${cyan(provider)}${authBadge(provider)} ${dim("(auto — token on disk)")}`,
    }
  }
  if (provider === "anthropic" && env.QUANTA_PROVIDER === undefined && !hasToken) {
    return {
      name: provider,
      styled: `${cyan(provider)}${authBadge(provider)} ${dim("(default, no key configured)")}`,
    }
  }
  return { name: provider, styled: `${cyan(provider)}${authBadge(provider)}` }
}

const renderTokenSection = (
  rec: TokenRecord | null,
  err: string | null,
  tokenPath: string,
  tokenSource: ChatgptTokenSource | null,
  nowMs: number,
): string[] => {
  const out: string[] = [bold("ChatGPT-OAuth")]
  if (err !== null) {
    out.push(`  ${red("✗")} ${err}`)
    return out
  }
  if (rec === null) {
    out.push(`  ${gray("○")} ${dim("not signed in")} ${dim("— run ")}${cyan("/login --chatgpt")}`)
    return out
  }
  const expired = isExpired(rec, nowMs, 0)
  const expSoon = !expired && isExpired(rec, nowMs, 5 * 60 * 1000)
  const head = expired
    ? `${red("✗")} ${red("expired")}`
    : expSoon
      ? `${yellow("●")} ${yellow("expiring soon")}`
      : `${green("✓")} ${green("active")}`
  out.push(`  ${head}`)
  const plan = rec.plan_type ?? "unknown"
  const planStyled =
    plan === "free"
      ? red("free (no API access)")
      : plan === "unknown"
        ? gray("unknown")
        : cyan(plan)
  out.push(`    ${kvLine("plan", planStyled, 11)}`)
  if (rec.account_id !== undefined) {
    out.push(`    ${kvLine("account_id", gray(rec.account_id), 11)}`)
  }
  // expires: colour by proximity (red ≤5m / yellow ≤1h / green otherwise).
  const expStyle = expiryColor(rec.expires_at, nowMs)
  out.push(
    `    ${kvLine("expires", `${expStyle(rec.expires_at)} ${dim(`(${humanRel(rec.expires_at, nowMs)})`)}`, 11)}`,
  )
  if (rec.last_refresh !== undefined) {
    // refreshed is semantically past — `agoOnly: true` collapses any
    // accidental future stamp ("in 3h") into "just now".
    out.push(
      `    ${kvLine("refreshed", `${gray(rec.last_refresh)} ${dim(`(${humanRel(rec.last_refresh, nowMs, { agoOnly: true })})`)}`, 11)}`,
    )
  }
  if (tokenSource !== null) {
    out.push(`    ${kvLine("source", gray(tokenSource === "quanta" ? "quanta prefs" : "codex login"), 11)}`)
  }
  out.push(`    ${kvLine("path", gray(tokenPath), 11)}`)
  return out
}

const renderByokSection = (env: Record<string, string | undefined>): string[] => {
  const fmt = (name: string, present: boolean): string =>
    present ? `  ${green("●")} ${name} ${dim("set")}` : `  ${gray("○")} ${name} ${dim("not set")}`
  return [
    bold("BYOK env vars"),
    fmt("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY !== undefined),
    fmt("OPENAI_API_KEY   ", env.OPENAI_API_KEY !== undefined),
  ]
}

export const buildStatusCmd = (deps: StatusDeps = {}): SlashCommand => ({
  name: "/status",
  describe: "Show login state, active provider, token info",
  category: "session",
  async run(_args, ctx: SlashContext) {
    const env = deps.env ?? process.env
    const nowMs = deps.nowMs?.() ?? (ctx.now ? ctx.now() : Date.now())
    const tokenEnv = {
      ...env,
      ...(ctx.prefsHome !== undefined ? { QUANTA_PREFS_HOME: ctx.prefsHome } : {}),
    }
    const tokenPath = resolveChatgptTokenCandidates(tokenEnv)[0]?.path ?? ""

    let token: TokenRecord | null = null
    let tokenErr: string | null = null
    let tokenPathUsed = tokenPath
    let tokenSource: ChatgptTokenSource | null = null
    try {
      const resolved = await readResolvedToken(tokenEnv)
      token = resolved?.record ?? null
      tokenPathUsed = resolved?.path ?? tokenPath
      tokenSource = resolved?.source ?? null
    } catch (e) {
      tokenErr = (e as Error).message
    }

    const active = resolveActiveProvider(tokenEnv, token !== null && tokenErr === null)

    const lines: string[] = [
      `${bold("Active provider")}  ${active.styled}`,
      "",
      ...renderByokSection(env),
      "",
      ...renderTokenSection(token, tokenErr, tokenPathUsed, tokenSource, nowMs),
    ]
    ctx.out(
      `${renderBox(lines, {
        title: "quanta status",
        titleStyle: cyan,
        footer: "ADR-0094 · chatgpt-oauth Phase 1",
      })}\n`,
    )
    return 0
  },
})

export const statusCmd = buildStatusCmd()
