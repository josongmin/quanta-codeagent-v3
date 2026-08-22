/**
 * ADR-0311 — GitHub Actions trigger source.
 *
 * Reads `GITHUB_EVENT_PATH` ONCE per process lifetime and emits a single
 * {@link ProactiveTrigger} (reason: `pr_comment` for comment/review events,
 * `manual_resume` for `workflow_dispatch`, otherwise no emit). Subsequent
 * `poll()` calls return `[]` because the same delivery id has been recorded
 * in the {@link DeliveryStore}.
 *
 * Default-OFF: `EnvPort.get("QUANTA_GH_ACTIONS_TRIGGER")` MUST be `"1"`.
 *
 * Self-loop defense (3 stacked guards):
 *   1. mention filter rejects body containing our `<!-- quanta:idempotency= -->`
 *      marker (see `mention-filter.ts`),
 *   2. sender.type === "Bot" auto-rejects (mention filter default),
 *   3. delivery-id dedup prevents re-firing the same webhook even if the
 *      runner restarts inside the same workflow.
 */

import type {
  ClockPort,
  EnvPort,
  ProactiveTrigger,
  TriggerReason,
  TriggerSourcePort,
} from "@/reactor"

import { normalizeGhEvent, parseGhEventFile } from "./event-payload"
import { createDeliveryStore, type DeliveryStore } from "./idempotency"
import { createMentionFilter, type MentionFilter, matchMention } from "./mention-filter"
import type { FsPort, GhEventKind, NormalizedGhEvent, TrustScope } from "./types"

/** Env flag — exported so tests reference SSOT instead of a string literal. */
export const GH_ACTIONS_TRIGGER_ENV = "QUANTA_GH_ACTIONS_TRIGGER" as const

/** Default trigger phrases — mirror the Codex / Claude Code Action defaults
 *  (`@quanta`, `/quanta`). Composition root may override. */
const DEFAULT_TRIGGER_PHRASES: ReadonlyArray<string> = ["@quanta", "/quanta"]

const SNIPPET_MAX_CHARS = 280

export interface ActionsEventSourceOpts {
  readonly fsPort: FsPort
  readonly envPort: EnvPort
  readonly clockPort: ClockPort
  /** Override the env var the adapter reads for the event file path. Default
   *  is `"GITHUB_EVENT_PATH"`. */
  readonly eventPathEnv?: string
  /** Override the kind env var. Default is `"GITHUB_EVENT_NAME"`. */
  readonly eventNameEnv?: string
  /** Override the delivery-id env var. Default is `"GITHUB_DELIVERY"`. */
  readonly deliveryIdEnv?: string
  readonly deliveryStore?: DeliveryStore
  /** Pre-built mention filter (skips construction). When unset, the source
   *  builds one from `triggerPhrases` + `requireTrustScope` + `allowBots`. */
  readonly mentionFilter?: MentionFilter
  readonly triggerPhrases?: readonly string[]
  readonly requireTrustScope?: TrustScope
  readonly allowBots?: boolean
  readonly onError?: (message: string) => void
}

export const createActionsEventSource = (opts: ActionsEventSourceOpts): TriggerSourcePort => {
  const eventPathEnv = opts.eventPathEnv ?? "GITHUB_EVENT_PATH"
  const eventNameEnv = opts.eventNameEnv ?? "GITHUB_EVENT_NAME"
  const deliveryIdEnv = opts.deliveryIdEnv ?? "GITHUB_DELIVERY"
  const deliveryStore = opts.deliveryStore ?? createDeliveryStore()
  const filter =
    opts.mentionFilter ??
    createMentionFilter({
      triggerPhrases: opts.triggerPhrases ?? DEFAULT_TRIGGER_PHRASES,
      requireTrustScope: opts.requireTrustScope ?? "collaborator",
      allowBots: opts.allowBots ?? false,
    })

  return {
    poll: (pollOpts) =>
      runPoll({
        opts,
        signal: pollOpts?.signal,
        eventPathEnv,
        eventNameEnv,
        deliveryIdEnv,
        deliveryStore,
        filter,
      }),
  }
}

interface PollDeps {
  readonly opts: ActionsEventSourceOpts
  readonly signal: AbortSignal | undefined
  readonly eventPathEnv: string
  readonly eventNameEnv: string
  readonly deliveryIdEnv: string
  readonly deliveryStore: DeliveryStore
  readonly filter: MentionFilter
}

const runPoll = async (deps: PollDeps): Promise<readonly ProactiveTrigger[]> => {
  if (isAborted(deps.signal)) return []
  if (deps.opts.envPort.get(GH_ACTIONS_TRIGGER_ENV) !== "1") return []
  const ctx = readEnvContext(deps.opts, deps.eventPathEnv, deps.eventNameEnv, deps.deliveryIdEnv)
  if (ctx === undefined) return []
  const raw = await parseGhEventFile({ fsPort: deps.opts.fsPort, path: ctx.path })
  if (raw === undefined || isAborted(deps.signal)) return []
  const event = buildEvent(raw, ctx)
  if (event === undefined) return []
  if (!shouldEmit(event, ctx.kind, deps)) return []
  deps.deliveryStore.add(event.deliveryId)
  return [buildTrigger(event, ctx.kind)]
}

const buildEvent = (raw: unknown, ctx: EventContext): NormalizedGhEvent | undefined => {
  return normalizeGhEvent({
    raw,
    kind: ctx.kind,
    ...(ctx.deliveryOverride !== undefined ? { deliveryId: ctx.deliveryOverride } : {}),
  })
}

const shouldEmit = (event: NormalizedGhEvent, kind: GhEventKind, deps: PollDeps): boolean => {
  if (deps.deliveryStore.has(event.deliveryId)) return false
  // Single bot-gate SoT: the mention filter (`filter.evaluate`) is the sole
  // authority on the bot gate — it rejects `sender.type === "Bot"` unless its
  // own `allowBots` is set (see `mention-filter.ts`). Re-reading
  // `opts.allowBots` here would override an INJECTED filter's intent (a caller
  // that passed `mentionFilter` never set `opts.allowBots`), so we delegate
  // entirely, mirroring the webhook-server sibling.
  if (!isAccepted(event, kind, deps.filter)) return false
  return true
}

interface EventContext {
  readonly path: string
  readonly kind: GhEventKind
  readonly deliveryOverride: string | undefined
}

const readEnvContext = (
  opts: ActionsEventSourceOpts,
  eventPathEnv: string,
  eventNameEnv: string,
  deliveryIdEnv: string,
): EventContext | undefined => {
  const path = opts.envPort.get(eventPathEnv)
  if (typeof path !== "string" || path.length === 0) return undefined
  const kind = parseEventKind(opts.envPort.get(eventNameEnv))
  if (kind === undefined) return undefined
  const delivery = opts.envPort.get(deliveryIdEnv)
  const deliveryOverride =
    typeof delivery === "string" && delivery.length > 0 ? delivery : undefined
  return { path, kind, deliveryOverride }
}

const isAccepted = (
  event: NormalizedGhEvent,
  kind: GhEventKind,
  filter: MentionFilter,
): boolean => {
  if (kind === "workflow_dispatch") return true
  return filter.evaluate(event).matched
}

const buildTrigger = (event: NormalizedGhEvent, kind: GhEventKind): ProactiveTrigger => {
  const url = derivePrUrl(event)
  const reason: TriggerReason = kind === "workflow_dispatch" ? "manual_resume" : "pr_comment"
  return Object.freeze({
    reason,
    evidence: Object.freeze({ kind: "url" as const, value: url }),
    simulatedMessage: buildSimulatedMessage(event, kind),
    abortSignal: new AbortController().signal,
  })
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && signal.aborted === true

/**
 * Re-export of `matchMention` for callers that don't need the full filter
 * (e.g. internal mention-only audit hooks).
 */
export { matchMention }

const ALL_KINDS: ReadonlyArray<GhEventKind> = [
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
  "pull_request",
  "issues",
  "workflow_dispatch",
]

const parseEventKind = (raw: string | undefined): GhEventKind | undefined => {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  return (ALL_KINDS as readonly string[]).includes(raw) ? (raw as GhEventKind) : undefined
}

const derivePrUrl = (event: NormalizedGhEvent): string => {
  if (event.prNumber !== undefined) {
    return `https://github.com/${event.repo.owner}/${event.repo.name}/pull/${event.prNumber}`
  }
  return `https://github.com/${event.repo.owner}/${event.repo.name}`
}

const buildSimulatedMessage = (event: NormalizedGhEvent, kind: GhEventKind): string => {
  const prSeg = event.prNumber !== undefined ? ` on PR #${event.prNumber}` : ""
  const phrase = mentionPhraseOrAction(event, kind)
  const snippet = clampSnippet(event.body ?? "")
  return `GitHub @${event.sender.login}${prSeg}: ${phrase}${snippet ? ` → ${snippet}` : ""}`
}

const mentionPhraseOrAction = (event: NormalizedGhEvent, kind: GhEventKind): string => {
  if (kind === "workflow_dispatch") return "manual workflow_dispatch"
  const m = matchMention(event.body, ["@quanta", "/quanta"])
  if (m.matched && m.command !== undefined) return m.command
  return event.action ?? kind
}

const clampSnippet = (body: string): string => {
  const trimmed = body.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) return ""
  if (trimmed.length <= SNIPPET_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, SNIPPET_MAX_CHARS - 1)}…`
}
