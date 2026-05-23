/**
 * Per-turn summary panel — verify-guard / HITL handoff / compaction / memory
 * provenance / recovery in a single rounded box rendered at turn end.
 *
 * Why: `renderTurnDashboard` already paints the cost/cache numbers when
 * `QUANTA_METRICS` is on, but operationally the user is more often interested
 * in WHAT happened during the turn ("the model tripped verify-guard once", "1
 * tool was denied", "the context was compacted") than in raw token counts.
 * This panel surfaces those signals BY DEFAULT for TTY surfaces; it complements
 * the dashboard rather than replacing it (the call sites are still both wired
 * in `repl.ts`).
 *
 * Design constraints (pin):
 *  - **Default-ON for TTY**, default-OFF for pipes/redirects/eval — when no
 *    signals fired (or the collector is disabled), `render(outcome)` returns
 *    `""` and the caller writes nothing. The dashboard remains byte-identical
 *    in that case.
 *  - **Read-only AgentEvent consumption** — the collector subscribes via the
 *    {@link StreamPort} contract (caller tees it alongside the existing ports).
 *    It NEVER mutates the event or influences control flow.
 *  - **No `AgentEvent` shape change** — every signal comes from events the
 *    loop ALREADY emits (`tool_call`, `tool_result`, `recovery`,
 *    `context_compacted`, `usage`) or from `AgentOutcome.memoryCitations`. We
 *    only consume.
 *  - **No secret exposure** — `redactionRollup` count is surfaced (if at all
 *    in a future row), never the redacted span text. HITL deny reason strings
 *    are NOT surfaced (HARD_DENY regex must not leak).
 *
 * Slice isolation: imports from `@/agent` (types) + `@/stream` (events) +
 * `@/ui/ui-helpers` (box render + colours) only. No cross-app imports.
 */

import type { AgentOutcome } from "@/agent"
import type { MemoryCitation } from "@/agent/types"
import type { AgentEvent, StreamPort } from "@/stream"
import { cyan, dim, gray, green, magenta, red, renderBox, yellow } from "@/ui/ui-helpers"

/** Per-turn signal counts captured by the collector. Pure data — the renderer
 *  is a separate function so the same counts can be inspected by tests. */
interface TurnSignals {
  /** Total `tool_call` events observed (one per attempted invocation). */
  toolCalls: number
  /** `tool_result.ok === true` count. */
  toolApproved: number
  /** `tool_result.ok === false` count. */
  toolDenied: number
  /** Per-reason recovery counts. Keyed by `RecoveryReason`. */
  recoveryByReason: Map<string, number>
  /** `verify-guard` trip count — `recovery.reason === "unverified"`. */
  verifyGuardTrips: number
  /** Compaction occurrences. `kind` distinguishes proactive (top-of-turn)
   *  from PTL-reactive (mid-turn) by reading the `detail` field of the
   *  preceding `recovery:{reason:"compact"}` event. */
  compactions: ReadonlyArray<CompactionMark>
  /** Cumulative usage (last `usage` event wins — providers emit cumulative). */
  usage: { inputTokens: number; outputTokens: number } | undefined
}

interface CompactionMark {
  readonly kind: "proactive" | "ptl"
  readonly tokens: number
}

const freshSignals = (): TurnSignals => ({
  toolCalls: 0,
  toolApproved: 0,
  toolDenied: 0,
  recoveryByReason: new Map(),
  verifyGuardTrips: 0,
  compactions: [],
  usage: undefined,
})

export interface TurnSummaryCollector {
  /** Subscribe to a single AgentEvent. Idempotent on shape errors — events
   *  the collector doesn't care about are ignored. */
  onEvent(event: AgentEvent): void
  /** Render the summary block. Returns `""` when no signal is worth showing
   *  (no tools, no recovery, no compaction, no memory citations on outcome).
   *  Caller writes the string to stderr verbatim. */
  render(outcome: AgentOutcome): string
  /** Reset all counters for the next turn. */
  reset(): void
  /** Build a {@link StreamPort} that tees this collector — caller composes it
   *  with the existing recorder/indicator ports. */
  asStreamPort(): StreamPort
}

export interface TurnSummaryOptions {
  /** When `false`, the collector is a no-op: `onEvent` ignores, `render`
   *  returns `""`. Default `true`. Callers gate by TTY + ENV at construction;
   *  this option lets a composite caller degrade gracefully. */
  enabled?: boolean
  /** Max memory citation rows to show. Default 3. */
  maxMemoryRows?: number
  /** Reserved for verbose mode — emit per-tool row breakdown when set.
   *  Default 0 (off). */
  maxToolRows?: number
  /** Turn number to render in the box title. Default omitted ⇒ title is
   *  the literal "turn summary". */
  turnNumber?: number
  /** Verbose mode: include raw recovery counts even when zero. Default `false`. */
  verbose?: boolean
}

/** Probe whether the turn-summary collector should be active for the calling
 *  surface. `QUANTA_TURN_SUMMARY` overrides; non-TTY auto-OFF. */
export const isTurnSummaryEnabled = (
  env: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): boolean => {
  const raw = env.QUANTA_TURN_SUMMARY
  if (raw !== undefined) {
    const v = raw.toLowerCase()
    if (v === "0" || v === "false" || v === "off" || v === "no") return false
    if (v === "1" || v === "true" || v === "on" || v === "yes") return true
  }
  return isTTY === true
}

/** Probe the matching verbose knob — `QUANTA_TURN_SUMMARY_VERBOSE=1`. */
export const isTurnSummaryVerbose = (env: NodeJS.ProcessEnv): boolean => {
  const raw = env.QUANTA_TURN_SUMMARY_VERBOSE
  if (raw === undefined) return false
  const v = raw.toLowerCase()
  return v === "1" || v === "true" || v === "on" || v === "yes"
}

export const createTurnSummary = (opts: TurnSummaryOptions = {}): TurnSummaryCollector => {
  const enabled = opts.enabled !== false
  const maxMemoryRows = Math.max(0, opts.maxMemoryRows ?? 3)
  const verbose = opts.verbose === true
  let signals = freshSignals()
  /** Tracks the most-recent `recovery:{reason:"compact"}` detail. When the
   *  subsequent `context_compacted` event fires (loop emits them as a pair),
   *  we tag the compaction with that detail (`"proactive"` ⇒ proactive,
   *  anything else / absent ⇒ PTL). The pairing is reset every consumption. */
  let pendingCompactDetail: string | undefined

  const consume = (event: AgentEvent): void => {
    if (!enabled) return
    switch (event.type) {
      case "tool_call":
        signals.toolCalls += 1
        return
      case "tool_result":
        if (event.ok) signals.toolApproved += 1
        else signals.toolDenied += 1
        return
      case "recovery": {
        const prev = signals.recoveryByReason.get(event.reason) ?? 0
        signals.recoveryByReason.set(event.reason, prev + 1)
        if (event.reason === "unverified") signals.verifyGuardTrips += 1
        if (event.reason === "compact") pendingCompactDetail = event.detail
        return
      }
      case "context_compacted": {
        const kind: "proactive" | "ptl" = pendingCompactDetail === "proactive" ? "proactive" : "ptl"
        signals = {
          ...signals,
          compactions: [...signals.compactions, { kind, tokens: event.tokens }],
        }
        pendingCompactDetail = undefined
        return
      }
      case "usage":
        signals.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        }
        return
      default:
        // Closed-union exhaustiveness: any other event is ignored. We do NOT
        // assert `never` here — the union is large and additive, and the
        // summary collector must remain forward-compatible (a future event
        // type SHOULD NOT crash the panel).
        return
    }
  }

  return {
    onEvent: consume,
    render: (outcome) =>
      enabled
        ? renderSummary(signals, outcome, {
            maxMemoryRows,
            verbose,
            ...(opts.turnNumber !== undefined ? { turnNumber: opts.turnNumber } : {}),
          })
        : "",
    reset: () => {
      signals = freshSignals()
      pendingCompactDetail = undefined
    },
    asStreamPort: () => ({
      emit: (event): void => {
        try {
          consume(event)
        } catch {
          // A bug in the collector must never poison the upstream emit chain
          // (TeeStream forwards in order; a throw here is reported as a
          // degraded record by the recorder downstream). Swallow in place.
        }
      },
    }),
  }
}

interface RenderContext {
  readonly maxMemoryRows: number
  readonly verbose: boolean
  readonly turnNumber?: number
}

/** Pure renderer — takes the collected signals + outcome and produces either
 *  a multi-line rounded-box string OR an empty string when no row is worth
 *  showing. Extracted so tests can drive it directly without an event source. */
const renderSummary = (signals: TurnSignals, outcome: AgentOutcome, ctx: RenderContext): string => {
  const lines: string[] = []
  const tools = formatToolsRow(signals)
  if (tools) lines.push(tools)
  const verify = formatVerifyRow(signals)
  if (verify) lines.push(verify)
  const compact = formatCompactRow(signals)
  if (compact) lines.push(compact)
  const memory = formatMemoryRow(outcome.memoryCitations, ctx.maxMemoryRows)
  if (memory) lines.push(memory)
  const recovery = formatRecoveryRow(signals)
  if (recovery) lines.push(recovery)
  if (ctx.verbose) {
    const usage = formatUsageRow(signals)
    if (usage) lines.push(usage)
  }
  if (lines.length === 0) return ""
  const title = ctx.turnNumber !== undefined ? `turn ${ctx.turnNumber}` : "turn summary"
  return `${renderBox(lines, { title, titleStyle: cyan, padX: 2, minInner: 48 })}\n`
}

/** Tools row — `✓ N tools · approved A · denied D`. Hidden when no tool ran. */
const formatToolsRow = (s: TurnSignals): string => {
  if (s.toolCalls === 0) return ""
  const parts: string[] = [green("✓"), `${s.toolCalls} tools`]
  parts.push(dim("·"), `approved ${s.toolApproved}`)
  if (s.toolDenied > 0) {
    parts.push(dim("·"), red(`denied ${s.toolDenied}`))
  }
  return parts.join(" ")
}

/** Verify-guard row — `↻ verify-guard: tripped N×`. Hidden when no trip. */
const formatVerifyRow = (s: TurnSignals): string => {
  if (s.verifyGuardTrips === 0) return ""
  const label = yellow(`↻ verify-guard:`)
  return `${label} tripped ${s.verifyGuardTrips}×`
}

/** Compaction row — `↻ compacted: <kind>@turn · X→Y tokens` style.
 *  We don't have the `before` size on the event, so the row shows the
 *  post-compaction size only (`Ytok`). Hidden when no compaction. */
const formatCompactRow = (s: TurnSignals): string => {
  if (s.compactions.length === 0) return ""
  const proactive = s.compactions.filter((c) => c.kind === "proactive").length
  const ptl = s.compactions.length - proactive
  const kinds: string[] = []
  if (proactive > 0) kinds.push(`proactive×${proactive}`)
  if (ptl > 0) kinds.push(`ptl×${ptl}`)
  const tok = s.compactions.reduce((acc, c) => acc + c.tokens, 0)
  return `${magenta("↻ compacted:")} ${kinds.join(" + ")} · ${tok}tok`
}

/** Memory row — `◇ memory: N hits (id1, id2, id3)`. Hidden when no citation.
 *  Per Audit-Catalog: SCORES ARE NOT EXPOSED — we surface only the count and
 *  the first N record ids. */
const formatMemoryRow = (
  citations: ReadonlyArray<MemoryCitation> | undefined,
  maxRows: number,
): string => {
  if (citations === undefined || citations.length === 0) return ""
  const ids = citations.slice(0, Math.max(0, maxRows)).map((c) => c.recordId)
  const more = citations.length > ids.length ? `, +${citations.length - ids.length} more` : ""
  const label = cyan(`◇ memory:`)
  return `${label} ${citations.length} hits (${ids.join(", ")}${more})`
}

/** Recovery row — `⟲ recovery: N×backoff · M×nudge`. `compact` and
 *  `unverified` are NOT included here (they have dedicated rows). Hidden when
 *  no remaining recovery reason fired. */
const formatRecoveryRow = (s: TurnSignals): string => {
  const reasons: Array<[string, number]> = []
  for (const [reason, count] of s.recoveryByReason) {
    if (reason === "compact" || reason === "unverified") continue
    if (count > 0) reasons.push([reason, count])
  }
  if (reasons.length === 0) return ""
  reasons.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const parts = reasons.map(([r, n]) => `${n}×${r}`)
  return `${gray("⟲ recovery:")} ${parts.join(" · ")}`
}

/** Usage row (verbose only) — `$ Xtok in / Y tok out`. */
const formatUsageRow = (s: TurnSignals): string => {
  if (s.usage === undefined) return ""
  return `${dim("usage:")} ${s.usage.inputTokens}tok in / ${s.usage.outputTokens}tok out`
}

/** Internal helpers exported for unit-test drilling — NOT part of the public
 *  callable surface. A future round may switch these to file-scoped if the
 *  caller no longer needs them. */
export const __internal = Object.freeze({
  freshSignals,
  formatToolsRow,
  formatVerifyRow,
  formatCompactRow,
  formatMemoryRow,
  formatRecoveryRow,
  formatUsageRow,
  renderSummary,
})
