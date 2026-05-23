/** `/login` slash command — drives the ChatGPT OAuth flow (ADR-0094 Slice C).
 *
 *  Flow: validate args → resolve OAuth config from env → refuse if
 *  `QUANTA_OAUTH_CLIENT_ID` is unset → open browser → exchange code →
 *  persist token bundle at `~/.quanta/auth/chatgpt.json` (0600). Renders
 *  state through a rounded box so the user sees what's happening at every
 *  step.
 *
 *  Test-seam: `buildLoginCmd({ env, fetchImpl, opener, nowMs })` accepts
 *  the same shape used by the underlying auth modules so the command can be
 *  driven end-to-end without spawning a real browser or hitting the OpenAI
 *  issuer.
 */

import {
  BrowserFlowError,
  chatgptTokenPath,
  decodeJwtClaims,
  exchangeCode,
  type FetchLike,
  isClientIdConfigured,
  isFreePlan,
  type OAuthConfig,
  resolveOAuthConfig,
  resolveQuantaHome,
  runBrowserFlow,
  TokenExchangeError,
  type TokenRecord,
  writeToken,
} from "@/auth/chatgpt-oauth"
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

export interface LoginDeps {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: FetchLike
  readonly opener?: (url: string) => void
  readonly nowMs?: () => number
  /** When set, override the timeout that `runBrowserFlow` would otherwise
   *  use (10 min). Tests pin it to milliseconds to fail fast. */
  readonly timeoutMs?: number
}

const renderClientIdMissing = (): string =>
  `${renderBox(
    [
      `${red("✗")} ${bold("OAuth client_id is not configured")}`,
      "",
      `${dim("Set ")}${cyan("QUANTA_OAUTH_CLIENT_ID")}${dim(" to your registered")}`,
      `${dim("OAuth client id, then run ")}${cyan("/login")}${dim(" again.")}`,
      "",
      `${dim("See ADR-0094 §Follow-up for how this id is obtained.")}`,
    ],
    { title: "ChatGPT Sign-In", titleStyle: cyan },
  )}\n`

const renderFlowStart = (cfg: OAuthConfig): string =>
  `${renderBox(
    [
      `${dim("Issuer       ")}${cyan(cfg.issuer)}`,
      `${dim("Client       ")}${gray(`${cfg.clientId.slice(0, 12)}…`)}`,
      "",
      `${yellow("●")} Opening your browser…`,
      `${dim("If it doesn't open automatically, the URL is printed below.")}`,
      "",
      `${dim("Waiting up to 10 min — ")}${gray("Ctrl+C")}${dim(" to abort.")}`,
    ],
    { title: "ChatGPT Sign-In", titleStyle: cyan },
  )}\n`

const renderSuccess = (
  rec: TokenRecord,
  tokenPath: string,
  nowMs: number,
  warn: string | null,
): string => {
  const plan = rec.plan_type ?? "unknown"
  const planStyled =
    plan === "free"
      ? red("free (no API access)")
      : plan === "unknown"
        ? gray("unknown")
        : green(plan)
  const expStyle = expiryColor(rec.expires_at, nowMs)
  const lines: string[] = [
    `${green("✓")} ${bold("Signed in")}`,
    "",
    kvLine("plan", planStyled, 13),
  ]
  if (rec.account_id) {
    lines.push(kvLine("account_id", gray(rec.account_id), 13))
  }
  lines.push(
    kvLine(
      "expires",
      `${expStyle(rec.expires_at)} ${dim(`(${humanRel(rec.expires_at, nowMs)})`)}`,
      13,
    ),
  )
  lines.push(kvLine("stored at", gray(tokenPath), 13))
  if (warn !== null) {
    lines.push("", `${yellow("●")} ${warn}`)
  }
  lines.push("", `${dim("Activate with ")}${cyan("QUANTA_PROVIDER=chatgpt-oauth")}`)
  return `${renderBox(lines, {
    title: "ChatGPT Sign-In",
    titleStyle: cyan,
    footer: "ADR-0094 · chatgpt-oauth Phase 1",
  })}\n`
}

const renderError = (title: string, detail: string, hint?: string): string => {
  const lines: string[] = [`${red("✗")} ${bold(title)}`, "", dim(detail)]
  if (hint) {
    lines.push("", `${yellow("●")} ${hint}`)
  }
  return `${renderBox(lines, { title: "ChatGPT Sign-In", titleStyle: cyan })}\n`
}

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e)

const buildErrorRender = (e: unknown): string => {
  if (e instanceof BrowserFlowError) {
    switch (e.reason) {
      case "ports_in_use":
        return renderError(
          "Local callback ports busy",
          e.message,
          "Close the process holding the port or wait a few seconds and retry.",
        )
      case "timeout":
        return renderError("Login timed out", e.message, "Run /login again when ready.")
      case "state_mismatch":
        return renderError(
          "State mismatch (possible CSRF)",
          e.message,
          "Retry from a clean browser tab.",
        )
      case "user_cancel":
        return renderError("Login cancelled at the OAuth screen", e.message)
      case "open_failed":
        return renderError(
          "Could not open browser",
          e.message,
          "Copy the authorize URL printed above into a browser manually.",
        )
    }
  }
  if (e instanceof TokenExchangeError) {
    return renderError(
      `Token exchange failed (HTTP ${e.statusCode})`,
      e.message,
      e.statusCode === 401
        ? "The OAuth client_id may be wrong or the code expired — try /login again."
        : "Retry /login. If this persists the issuer may be having an outage.",
    )
  }
  return renderError("Login failed", errMessage(e))
}

const peekPlanFromAccessToken = (rec: TokenRecord): string | null => {
  // The id_token usually carries chatgpt_plan_type. Some flows return only
  // access_token here; fall back to access_token decode in that case.
  const candidate = rec.id_token ?? rec.access_token
  try {
    const claims = decodeJwtClaims(candidate)
    return claims.chatgpt_plan_type ?? null
  } catch {
    return null
  }
}

export const buildLoginCmd = (deps: LoginDeps = {}): SlashCommand => ({
  name: "/login",
  describe: "Sign in to ChatGPT (Plus / Pro / Team / Business / Enterprise)",
  category: "auth",
  complete: (args, _partial, _ctx) =>
    args.length === 0
      ? [{ value: "--chatgpt", kind: "argument" as const, description: "ChatGPT OAuth flow" }]
      : [],
  async run(args, ctx: SlashContext) {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--chatgpt")) {
      ctx.err("/login: usage: /login [--chatgpt]\n")
      return 1
    }
    const env = deps.env ?? process.env
    const cfg = resolveOAuthConfig(env)
    if (!isClientIdConfigured(cfg)) {
      ctx.err(renderClientIdMissing())
      return 2
    }

    const home = ctx.prefsHome ?? resolveQuantaHome(env)
    const tokenPath = chatgptTokenPath(home)
    const nowMs = deps.nowMs?.() ?? (ctx.now ? ctx.now() : Date.now())

    ctx.out(renderFlowStart(cfg))

    // SIGINT escape hatch: the browser flow otherwise blocks for up to 10 min
    // and the REPL's interrupt handler can't reach inside the await. A local
    // controller wired to a SIGINT handler lets Ctrl+C unstick the flow.
    const ac = new AbortController()
    const sigintHandler = (): void => ac.abort()
    process.once("SIGINT", sigintHandler)
    try {
      const flowOpts = {
        cfg,
        ...(deps.opener !== undefined ? { opener: deps.opener } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        signal: ac.signal,
      }
      const flow = await runBrowserFlow(flowOpts)
      ctx.out(`${dim("→ exchanging authorization code for tokens…")}\n`)
      const exchangeOpts = {
        cfg,
        code: flow.code,
        verifier: flow.verifier,
        redirectUri: flow.redirectUri,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        nowMs: () => nowMs,
      }
      const record = await exchangeCode(exchangeOpts)
      await writeToken(tokenPath, record)

      // Free-account preflight warning (still write the token so /status
      // reflects truth — but warn the user that model calls will 403).
      const planForCheck = record.plan_type ?? peekPlanFromAccessToken(record) ?? "unknown"
      const freeWarn =
        planForCheck === "free"
          ? "Free ChatGPT plan does not include API access — model calls will fail."
          : null
      ctx.out(renderSuccess(record, tokenPath, nowMs, freeWarn))
      if (
        record.plan_type === undefined ||
        record.plan_type === "free" ||
        isFreePlan({ chatgpt_plan_type: record.plan_type })
      ) {
        // Non-zero exit only for the literal free plan — unknown stays 0 so
        // the (rare) case of a plan-less id_token doesn't block the user.
        return record.plan_type === "free" || planForCheck === "free" ? 3 : 0
      }
      return 0
    } catch (e) {
      ctx.err(buildErrorRender(e))
      return 1
    } finally {
      process.removeListener("SIGINT", sigintHandler)
    }
  },
})

export const loginCmd = buildLoginCmd()
