/**
 * `from-pr` CLI sub-command (ADR-0311 entry point).
 *
 * Tier-0 user-facing entry around the `@/integrations/github` slice. Runs ONE
 * cycle to completion:
 *   1. envPort.get(QUANTA_GH_ACTIONS_TRIGGER) !== "1" ⇒ default-OFF, exit 0.
 *   2. createActionsEventSource → poll once → readonly ProactiveTrigger[].
 *   3. 0 triggers ⇒ exit 0 (no-op). ≥1 ⇒ parse PR# out of evidence.value URL.
 *   4. loadPrContext(prNumber) — 4-shot gh.
 *   5. compose summary body → redactPort.redact (defence in depth).
 *   6. dryRun=true ⇒ emit `dry-run-body`. dryRun=false ⇒ createPrOutputSink
 *      .postComment with computeIdempotencyKey(deliveryId, "comment").
 *
 * Every IO is a port (env / fs / gh / clock / redact). No direct process.env
 * / fs / Bun.spawn here — adapters live in `from-pr-cmd-adapters.ts`.
 *
 * Slice fence: imports `@/integrations/github` barrel + `@/reactor` types
 * only. No agent / llm / permission / tool / runner.
 */

import {
  computeIdempotencyKey,
  createActionsEventSource,
  createDeliveryStore,
  createPrOutputSink,
  type DeliveryStore,
  type FsPort,
  loadPrContext,
  type PrContext,
  type RedactPort,
  type TrustScope,
} from "@/integrations/github"
import type { ClockPort, EnvPort, GhCliPort, ProactiveTrigger } from "@/reactor"

export type FromPrCmdEvent =
  | { readonly type: "skipped"; readonly reason: string }
  | { readonly type: "trigger"; readonly prNumber: number; readonly url: string }
  | { readonly type: "context-loaded"; readonly prNumber: number }
  | { readonly type: "context-failed"; readonly prNumber: number; readonly error: string }
  | { readonly type: "dry-run-body"; readonly body: string }
  | { readonly type: "posted"; readonly url?: string }
  | { readonly type: "post-failed"; readonly error: string }
  | { readonly type: "error"; readonly error: string }

export interface FromPrCmdOpts {
  readonly envPort: EnvPort
  readonly fsPort: FsPort
  readonly ghCliPort: GhCliPort
  readonly clockPort: ClockPort
  readonly redactPort: RedactPort
  readonly deliveryStore?: DeliveryStore
  readonly onEvent?: (event: FromPrCmdEvent) => void
  readonly signal?: AbortSignal
  readonly cwd?: string
}

export interface FromPrCmdArgs {
  readonly prNumber?: number
  readonly repoSlug?: string
  readonly eventSource?: "actions" | "webhook" | "poll"
  readonly triggerPhrases?: readonly string[]
  readonly trustScope?: TrustScope
  readonly allowBots?: boolean
  readonly dryRun?: boolean
}

export interface FromPrCmdResult {
  readonly exitCode: number
  readonly triggers: number
  readonly contextLoaded: boolean
  readonly posted: boolean
  readonly error?: string
}

const DEFAULT_TRIGGER_PHRASES: readonly string[] = ["@quanta", "/quanta"]
const PR_BODY_EXCERPT_CHARS = 1024
const DIFF_EXCERPT_CHARS = 600
const FILES_EXCERPT_COUNT = 10
const COMMENTS_EXCERPT_COUNT = 3
const COMMENT_BODY_EXCERPT_CHARS = 240
/** ANCHORED at string start — prevents spoofed-prefix URLs like
 *  `https://evil.com/https://github.com/o/r/pull/42` from being parsed as
 *  PR #42. The `new URL()` second check below enforces host equality. */
const PR_URL_REGEX = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/

export const runFromPrCmd = async (
  args: FromPrCmdArgs,
  opts: FromPrCmdOpts,
): Promise<FromPrCmdResult> => {
  const emit = opts.onEvent ?? noop
  const signal = opts.signal
  const cwd = opts.cwd ?? "."

  const gateCheck = checkPreflightGates(args, opts, emit, signal)
  if (gateCheck !== undefined) return gateCheck

  const polled = await pollTriggers(args, opts, emit, signal)
  if (polled.kind === "done") return polled.result
  const { triggers, first, prNumber } = polled

  const repoSlug = args.repoSlug ?? opts.envPort.get("GITHUB_REPOSITORY") ?? ""
  if (repoSlug.length === 0) {
    const err = "missing repo slug (set GITHUB_REPOSITORY or pass --repo)"
    emit({ type: "error", error: err })
    return { ...zeroResult(), triggers: triggers.length, exitCode: 1, error: err }
  }

  const context = await safeLoadContext({
    args: { ghCliPort: opts.ghCliPort, repoCwd: cwd, repoSlug, prNumber, signal },
    emit,
    prNumber,
  })
  if (context === undefined) {
    return {
      ...zeroResult(),
      triggers: triggers.length,
      exitCode: 1,
      error: `failed to load PR context for #${prNumber}`,
    }
  }
  emit({ type: "context-loaded", prNumber })

  const summary = composeSummary(context, first.simulatedMessage, opts.clockPort.now())
  const redactedBody = opts.redactPort.redact(summary)

  if (args.dryRun === true) {
    emit({ type: "dry-run-body", body: redactedBody })
    return { exitCode: 0, triggers: triggers.length, contextLoaded: true, posted: false }
  }
  if (signal?.aborted) {
    emit({ type: "skipped", reason: "abort" })
    return { exitCode: 0, triggers: triggers.length, contextLoaded: true, posted: false }
  }

  return await postAndReport({
    args,
    opts,
    cwd,
    repoSlug,
    context,
    redactedBody,
    triggers,
    prNumber,
    signal,
    emit,
  })
}

interface PollEarly {
  readonly kind: "done"
  readonly result: FromPrCmdResult
}
interface PollOk {
  readonly kind: "ok"
  readonly triggers: readonly ProactiveTrigger[]
  readonly first: ProactiveTrigger
  readonly prNumber: number
}

const checkPreflightGates = (
  args: FromPrCmdArgs,
  opts: FromPrCmdOpts,
  emit: (e: FromPrCmdEvent) => void,
  signal: AbortSignal | undefined,
): FromPrCmdResult | undefined => {
  if (opts.envPort.get("QUANTA_GH_ACTIONS_TRIGGER") !== "1") {
    emit({ type: "skipped", reason: "env-off" })
    return zeroResult()
  }
  if (signal?.aborted === true) {
    emit({ type: "skipped", reason: "abort" })
    return zeroResult()
  }
  const sourceKind = args.eventSource ?? "actions"
  if (sourceKind !== "actions") {
    emit({ type: "skipped", reason: `event-source-not-implemented:${sourceKind}` })
    return zeroResult()
  }
  return undefined
}

const pollTriggers = async (
  args: FromPrCmdArgs,
  opts: FromPrCmdOpts,
  emit: (e: FromPrCmdEvent) => void,
  signal: AbortSignal | undefined,
): Promise<PollEarly | PollOk> => {
  const deliveryStore = opts.deliveryStore ?? createDeliveryStore()
  const source = createActionsEventSource({
    fsPort: opts.fsPort,
    envPort: opts.envPort,
    clockPort: opts.clockPort,
    deliveryStore,
    triggerPhrases: args.triggerPhrases ?? DEFAULT_TRIGGER_PHRASES,
    requireTrustScope: args.trustScope ?? "collaborator",
    allowBots: args.allowBots === true,
  })
  const triggers = await safePoll(source, signal, emit)
  if (triggers === undefined) {
    return { kind: "done", result: { ...zeroResult(), exitCode: 1, error: "poll failed" } }
  }
  if (triggers.length === 0) return { kind: "done", result: zeroResult() }
  const first = triggers[0] as ProactiveTrigger
  const prFromUrl = parsePrNumberFromUrl(first.evidence.value)
  const prNumber = args.prNumber ?? prFromUrl
  if (prNumber === undefined) {
    const err = `cannot resolve PR number (evidence=${first.evidence.value})`
    emit({ type: "error", error: err })
    return {
      kind: "done",
      result: { ...zeroResult(), triggers: triggers.length, exitCode: 1, error: err },
    }
  }
  emit({ type: "trigger", prNumber, url: first.evidence.value })
  return { kind: "ok", triggers, first, prNumber }
}

interface PostAndReportArgs {
  readonly args: FromPrCmdArgs
  readonly opts: FromPrCmdOpts
  readonly cwd: string
  readonly repoSlug: string
  readonly context: PrContext
  readonly redactedBody: string
  readonly triggers: readonly ProactiveTrigger[]
  readonly prNumber: number
  readonly signal: AbortSignal | undefined
  readonly emit: (e: FromPrCmdEvent) => void
}

const postAndReport = async (deps: PostAndReportArgs): Promise<FromPrCmdResult> => {
  const sink = createPrOutputSink({
    ghCliPort: deps.opts.ghCliPort,
    repoCwd: deps.cwd,
    repoSlug: deps.repoSlug,
    prNumber: deps.context.prNumber,
    redactPort: deps.opts.redactPort,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  })
  const deliveryId =
    deps.opts.envPort.get("GITHUB_DELIVERY") ?? `pr-${deps.prNumber}-${deps.opts.clockPort.now()}`
  const key = computeIdempotencyKey(deliveryId, "comment")
  const post = await sink.postComment({ body: deps.redactedBody, key })
  if (post.ok === false) {
    deps.emit({ type: "post-failed", error: post.error ?? "unknown error" })
    return {
      triggers: deps.triggers.length,
      contextLoaded: true,
      posted: false,
      exitCode: 1,
      error: post.error ?? "post failed",
    }
  }
  deps.emit({ type: "posted", ...(post.url !== undefined ? { url: post.url } : {}) })
  return {
    exitCode: 0,
    triggers: deps.triggers.length,
    contextLoaded: true,
    posted: true,
  }
}

const safePoll = async (
  source: { poll(o?: { signal?: AbortSignal }): Promise<readonly ProactiveTrigger[]> },
  signal: AbortSignal | undefined,
  emit: (e: FromPrCmdEvent) => void,
): Promise<readonly ProactiveTrigger[] | undefined> => {
  try {
    return await source.poll(signal !== undefined ? { signal } : undefined)
  } catch (error) {
    emit({ type: "error", error: stringifyError(error) })
    return undefined
  }
}

interface SafeLoadCtxArgs {
  readonly args: {
    readonly ghCliPort: GhCliPort
    readonly repoCwd: string
    readonly repoSlug: string
    readonly prNumber: number
    readonly signal: AbortSignal | undefined
  }
  readonly emit: (e: FromPrCmdEvent) => void
  readonly prNumber: number
}

const safeLoadContext = async (deps: SafeLoadCtxArgs): Promise<PrContext | undefined> => {
  try {
    const sig = deps.args.signal
    const ctx = await loadPrContext({
      ghCliPort: deps.args.ghCliPort,
      repoCwd: deps.args.repoCwd,
      repoSlug: deps.args.repoSlug,
      prNumber: deps.args.prNumber,
      ...(sig !== undefined ? { signal: sig } : {}),
    })
    if (ctx === undefined) {
      deps.emit({
        type: "context-failed",
        prNumber: deps.prNumber,
        error: "loader returned undefined",
      })
    }
    return ctx
  } catch (error) {
    deps.emit({ type: "context-failed", prNumber: deps.prNumber, error: stringifyError(error) })
    return undefined
  }
}

const composeSummary = (ctx: PrContext, simulated: string, atMs: number): string => {
  const ts = new Date(atMs).toISOString()
  const excerpt = clampBody(ctx.body)
  const filesFold = ctx.changedFiles.slice(0, FILES_EXCERPT_COUNT).join("\n  ")
  const filesSuffix =
    ctx.changedFiles.length > FILES_EXCERPT_COUNT
      ? `\n  … (${ctx.changedFiles.length - FILES_EXCERPT_COUNT} more)`
      : ""
  const diffFold = clamp(ctx.diff, DIFF_EXCERPT_CHARS)
  const commentsFold = ctx.recentComments
    .slice(0, COMMENTS_EXCERPT_COUNT)
    .map((c) => `  @${c.author} (${c.at}): ${clamp(c.body, COMMENT_BODY_EXCERPT_CHARS)}`)
    .join("\n")
  return [
    simulated,
    "",
    `Title: ${ctx.title}`,
    `Branch: ${ctx.headBranch} → ${ctx.baseBranch}`,
    `Files changed (${ctx.changedFiles.length}):`,
    `  ${filesFold}${filesSuffix}`,
    "",
    "PR description (excerpt):",
    excerpt,
    "",
    `Diff (first ${DIFF_EXCERPT_CHARS} chars):`,
    diffFold,
    ...(ctx.recentComments.length > 0
      ? [
          "",
          `Recent comments (top ${Math.min(COMMENTS_EXCERPT_COUNT, ctx.recentComments.length)}):`,
          commentsFold,
        ]
      : []),
    "",
    `Triggered at ${ts}. (Tier 0 ack; agent loop wiring is the next step.)`,
  ].join("\n")
}

const clamp = (s: string, max: number): string => {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

const clampBody = (body: string): string => clamp(body, PR_BODY_EXCERPT_CHARS)

/**
 * Parse PR number from an evidence URL with two checks:
 * 1. Regex anchored at string start (`^https://github.com/...`) — rejects
 *    spoofed prefix like `https://evil.com/https://github.com/o/r/pull/42`.
 * 2. `new URL(url)` — host MUST be exactly `github.com` (rejects IDN
 *    homograph, subdomain spoof, gist.github.com, api.github.com, userinfo).
 * 3. Protocol MUST be `https:` (rejects javascript:, http:).
 */
const parsePrNumberFromUrl = (url: string): number | undefined => {
  if (typeof url !== "string" || url.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "https:") return undefined
  if (parsed.host !== "github.com" && parsed.host !== "github.com:443") return undefined
  if (parsed.username !== "" || parsed.password !== "") return undefined
  const m = PR_URL_REGEX.exec(url)
  if (m === null) return undefined
  const captured = m[1]
  if (captured === undefined) return undefined
  const n = Number.parseInt(captured, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const zeroResult = (): FromPrCmdResult =>
  Object.freeze({ exitCode: 0, triggers: 0, contextLoaded: false, posted: false })

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const noop = (_event: FromPrCmdEvent): void => {
  // intentional no-op default sink.
}
