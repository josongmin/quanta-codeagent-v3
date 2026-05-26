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
const PR_URL_REGEX = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/

export const runFromPrCmd = async (
  args: FromPrCmdArgs,
  opts: FromPrCmdOpts,
): Promise<FromPrCmdResult> => {
  const emit = opts.onEvent ?? noop
  const signal = opts.signal
  const cwd = opts.cwd ?? "."

  // 1. Default-OFF gate.
  if (opts.envPort.get("QUANTA_GH_ACTIONS_TRIGGER") !== "1") {
    emit({ type: "skipped", reason: "env-off" })
    return zeroResult()
  }
  if (signal?.aborted === true) {
    emit({ type: "skipped", reason: "abort" })
    return zeroResult()
  }

  // 2. Event source kind gate (Tier-1 webhook/poll deferred).
  const sourceKind = args.eventSource ?? "actions"
  if (sourceKind !== "actions") {
    emit({ type: "skipped", reason: `event-source-not-implemented:${sourceKind}` })
    return zeroResult()
  }

  // 3. Build event source + poll once.
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
    return { ...zeroResult(), exitCode: 1, error: "poll failed" }
  }
  if (triggers.length === 0) return zeroResult()

  const first = triggers[0] as ProactiveTrigger
  const prFromUrl = parsePrNumberFromUrl(first.evidence.value)
  const prNumber = args.prNumber ?? prFromUrl
  if (prNumber === undefined) {
    const err = `cannot resolve PR number (evidence=${first.evidence.value})`
    emit({ type: "error", error: err })
    return { ...zeroResult(), triggers: triggers.length, exitCode: 1, error: err }
  }
  emit({ type: "trigger", prNumber, url: first.evidence.value })

  // 4. Resolve repo slug.
  const repoSlug = args.repoSlug ?? opts.envPort.get("GITHUB_REPOSITORY") ?? ""
  if (repoSlug.length === 0) {
    const err = "missing repo slug (set GITHUB_REPOSITORY or pass --repo)"
    emit({ type: "error", error: err })
    return { ...zeroResult(), triggers: triggers.length, exitCode: 1, error: err }
  }

  // 5. Load PR context.
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

  // 6. Compose + redact (defence in depth — context fields may carry secrets).
  const summary = composeSummary(context, first.simulatedMessage, opts.clockPort.now())
  const redactedBody = opts.redactPort.redact(summary)

  if (args.dryRun === true) {
    emit({ type: "dry-run-body", body: redactedBody })
    return {
      exitCode: 0,
      triggers: triggers.length,
      contextLoaded: true,
      posted: false,
    }
  }
  if (signal !== undefined && signal.aborted) {
    emit({ type: "skipped", reason: "abort" })
    return {
      exitCode: 0,
      triggers: triggers.length,
      contextLoaded: true,
      posted: false,
    }
  }

  // 7. Post (idempotent via delivery-id derived key).
  const sink = createPrOutputSink({
    ghCliPort: opts.ghCliPort,
    repoCwd: cwd,
    repoSlug,
    prNumber: context.prNumber,
    redactPort: opts.redactPort,
    ...(signal !== undefined ? { signal } : {}),
  })
  const deliveryId = opts.envPort.get("GITHUB_DELIVERY") ?? `pr-${prNumber}-${opts.clockPort.now()}`
  const key = computeIdempotencyKey(deliveryId, "comment")
  const post = await sink.postComment({ body: redactedBody, key })
  if (post.ok === false) {
    emit({ type: "post-failed", error: post.error ?? "unknown error" })
    return {
      triggers: triggers.length,
      contextLoaded: true,
      posted: false,
      exitCode: 1,
      error: post.error ?? "post failed",
    }
  }
  emit({ type: "posted", ...(post.url !== undefined ? { url: post.url } : {}) })
  return {
    exitCode: 0,
    triggers: triggers.length,
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
  return [
    simulated,
    "",
    `Title: ${ctx.title}`,
    `Branch: ${ctx.headBranch} → ${ctx.baseBranch}`,
    `Files changed: ${ctx.changedFiles.length}`,
    "",
    "PR description (excerpt):",
    excerpt,
    "",
    `Triggered at ${ts}. (Tier 0 ack; agent loop wiring is the next step.)`,
  ].join("\n")
}

const clampBody = (body: string): string => {
  if (body.length <= PR_BODY_EXCERPT_CHARS) return body
  return `${body.slice(0, PR_BODY_EXCERPT_CHARS - 1)}…`
}

const parsePrNumberFromUrl = (url: string): number | undefined => {
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
