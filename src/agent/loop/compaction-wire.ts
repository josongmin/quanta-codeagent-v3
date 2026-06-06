import { join } from "node:path"
import type { Message, SystemPromptInput } from "@/llm"
import type { CompactionEventVariant } from "@/memory/typed-event"
import { errMessage, logger, runtimeConfig } from "@/shared"
import {
  type BgSummaryPayload,
  compactIfNeeded,
  estimateTokens,
  resolveCompactionLimitTokens,
} from "../compaction"
import type { BackgroundSummarizationController } from "../compaction/index"
import type { BreakerVerdict, CompactionBreaker } from "../compaction-breaker"
import { appendSummary, type ConversationSummaryArchive } from "../conversation-summary-archive"
import { buildPostCompactEmit, buildPreCompactHook } from "../loop-helpers"
import { buildTurnContext } from "../prompt"
import { createEvictionSpillPort, microcompactToolResults } from "../tool-result-evict"
import type { AgentConfig } from "../types"
import { configuredModel, emitRecovery, objectiveBudgetExhausted } from "./emit-helpers"

// ──────────────────────────────────────────────────────────────────────────
// RFC jun-6-microcompaction — tier-1 tool-result eviction (a CHEAPER FIRST tier
// in front of `compactIfNeeded`). Knob-gated (`QUANTA_MICROCOMPACT`); when OFF
// the pre-pass is NEVER constructed and this whole block is byte-identical.
// ──────────────────────────────────────────────────────────────────────────

/** Keep the LAST N tool_results intact (the live working set the model is
 *  reasoning over right now). Overridable via `QUANTA_MICROCOMPACT_KEEP_RECENT`. */
const DEFAULT_MICROCOMPACT_KEEP_RECENT = 3

/** Commit a microcompaction ONLY if estimated tokensSaved > this floor. Mirrors
 *  the reactive-squeeze magnitude (`REACTIVE_MIN_INPUT_TOKENS = 4_000`): below a
 *  few thousand tokens of saving, churning the transcript is not worth it. A
 *  knob (`QUANTA_MICROCOMPACT_FLOOR_TOKENS`), not a hard-coded heuristic. */
const DEFAULT_MICROCOMPACT_FLOOR_TOKENS = 4_000

/** Min interval (ms) between microcompaction fires — the time-based cadence held
 *  in the wire (the pure core never sees the clock). Overridable via
 *  `QUANTA_MICROCOMPACT_INTERVAL_MS`. An over-eager cadence is harmless: the
 *  floor gate just no-ops a fire that frees too little. */
const DEFAULT_MICROCOMPACT_INTERVAL_MS = 30_000

/** Per-session last-fire timestamp for the cadence gate (the only mutable wire
 *  state; keyed by session so concurrent runs don't share a clock). */
const lastMicrocompactAt = new Map<string, number>()

/**
 * Tier-1 microcompaction pass (RFC §4.6). Runs INSIDE `maybeCompact` BEFORE
 * `compactIfNeeded`, guarded by the knob + the time-based cadence gate. Installs
 * the result via `wm.replace(...)` (NOT in-place mutation) so the delta-token
 * counter re-anchors and `tokenTotal()` stays byte-identical to
 * `estimateTokens(snapshot())` (§3.4 — the single most important correctness
 * interaction). Returns `true` iff it changed the transcript.
 */
const maybeMicrocompact = (
  config: AgentConfig,
  wm: import("@/memory").WorkingMemory<Message> & {
    tokenTotal?(): number
    tokenReseed?(): void
  },
  snapshot: readonly Message[],
  now: number,
): boolean => {
  const cfg = runtimeConfig()
  if (!cfg.microcompact) return false
  const sessionKey = config.sessionId ?? ""
  const intervalMs = cfg.microcompactIntervalMs ?? DEFAULT_MICROCOMPACT_INTERVAL_MS
  const last = lastMicrocompactAt.get(sessionKey)
  if (last !== undefined && now - last < intervalMs) return false

  const spill = createEvictionSpillPort({
    spillDir: join(config.cwd, ".quanta", "tool-output"),
  })
  const result = microcompactToolResults({
    messages: snapshot,
    keepRecent: cfg.microcompactKeepRecent ?? DEFAULT_MICROCOMPACT_KEEP_RECENT,
    tokensSavedFloor: cfg.microcompactFloorTokens ?? DEFAULT_MICROCOMPACT_FLOOR_TOKENS,
    spill,
  })
  // Stamp the cadence clock on every fire ATTEMPT (whether or not it changed),
  // so a repeated no-op clear does not re-scan every turn.
  lastMicrocompactAt.set(sessionKey, now)
  if (!result.changed) return false

  // CRITICAL (§4.6): install via `wm.replace`, which flows through the
  // delta-token decorator and reseeds the counter. An in-place edit of
  // `wm.messages[i].content` would BYPASS the counter and drift `tokenTotal()`.
  wm.replace([...result.messages])
  // Stream-recovery reason stays `"compact"` (the stream union) with a
  // `"microcompact"` detail so observability attributes a tier-1 clear distinctly
  // from a tier-2 summarization without widening the recovery state machine.
  emitRecovery(config, "compact", "microcompact")
  emitCompactionEvent(config, {
    kind: "compaction_event",
    trigger: "pre_sampling",
    reason: "context_limit",
    tokensBefore: estimateTokens([...snapshot]),
    tokensAfter: estimateTokens([...result.messages]),
    messagesRemoved: 0,
    at: now,
  })
  return true
}

export const maybeCompact = async (
  config: AgentConfig,
  system: SystemPromptInput,
  wm: import("@/memory").WorkingMemory<Message> & { tokenTotal?(): number },
  breaker: CompactionBreaker | undefined,
  archive: ConversationSummaryArchive | undefined,
  turn: number,
  bgController: BackgroundSummarizationController<BgSummaryPayload> | undefined,
  resetClassifier: (classifier: AgentConfig["effortClassifier"]) => void,
  // D5 (jun-7) — the authoritative input-token baseline captured by the prior
  // turn's `exact` provider usage. `undefined` on turn-1 / before any exact
  // usage ⇒ the trigger uses the chars/4 estimate (legacy, byte-identical).
  tokenBaseline: import("../compaction").TokenBaseline | undefined,
  // D4 (jun-7) — the model that will ACTUALLY process this turn (sticky/skill
  // swap), so the window-derived threshold tracks the active model, not base
  // `config.llm`. Defaults to the base model id.
  activeModel: string = configuredModel(config.llm),
): Promise<BreakerVerdict> => {
  if (!config.compaction) return { abort: false }
  const verdict = breaker?.check() ?? { abort: false }
  if (verdict.abort) {
    emitRecovery(config, "compact", "breaker-disabled")
    return verdict
  }
  const onPreCompact = config.onPreCompact
  let snapshot = [...wm.snapshot()]
  // FULL-snapshot read: O(1) `tokenTotal()` is byte-identical to
  // `estimateTokens(snapshot)` when the counter is wired (knob ON); falls back
  // to the full re-scan when OFF (`tokenTotal` absent).
  let before = wm.tokenTotal?.() ?? estimateTokens(snapshot)
  // ── tier-1 microcompaction (RFC jun-6-microcompaction, knob-gated) ──
  // Runs BEFORE the bg-controller reconcile + the tier-2 summarization, so both
  // see the already-shrunk transcript (no stale-prefix double accounting). The
  // pre-pass installs via `wm.replace` ⇒ the delta counter reseeds, so the
  // re-read `before` below stays byte-identical to `estimateTokens(snapshot)`.
  if (maybeMicrocompact(config, wm, snapshot, Date.now())) {
    snapshot = [...wm.snapshot()]
    before = wm.tokenTotal?.() ?? estimateTokens(snapshot)
  }
  // D4 (jun-7 naive-impl hardening) — the bg-controller ceiling must match the
  // synchronous proactive path's model-derived threshold, so pass the same model.
  const bgLimitTokens = resolveCompactionLimitTokens(
    config.compaction?.thresholdTokens,
    activeModel,
  )
  const borrowed =
    bgController !== undefined
      ? await bgController.reconcileAtTurnBoundary({
          usedTokens: before,
          limitTokens: bgLimitTokens,
        })
      : undefined
  const turnId = config.run?.turn !== undefined ? `t${config.run.turn}` : `t${turn}`
  const fromTurnId = archive?.summaries.at(-1)?.toTurnId ?? "t0"
  let result: Awaited<ReturnType<typeof compactIfNeeded>>
  const isFirstCompaction = archive !== undefined && archive.summaries.length === 0
  const preCompactHook = buildPreCompactHook(config.hooks)
  const postCompactEmit = buildPostCompactEmit(config.hooks, config.sessionId ?? "")
  const objectiveSetNextActions = config.objective
    ? (tid: string, actions: readonly string[]): void => {
        try {
          if (objectiveBudgetExhausted(config, tid)) return
          config.objective?.setNextActions(tid, actions)
        } catch (e) {
          logger.warn(`loop.objectiveSetNextActions: ${errMessage(e)}`)
        }
      }
    : undefined
  try {
    if (borrowed?.kind === "install") {
      const installed = [...borrowed.summary]
      result = {
        compacted: true,
        messages: installed,
        summaryTokens: estimateTokens(installed.slice(0, 1)),
      }
    } else {
      result = await compactIfNeeded({
        messages: snapshot,
        llm: config.compaction.summarizerLlm ?? config.llm,
        system,
        isFirstCompaction,
        // D4 — model-derived threshold (known model ⇒ window−reserve−margin;
        // unknown ⇒ 120k legacy). D5 — authoritative-baseline trigger when the
        // loop captured an `exact` usage (absent ⇒ chars/4 over the whole
        // transcript, byte-identical legacy).
        model: activeModel,
        ...(tokenBaseline !== undefined ? { tokenBaseline } : {}),
        ...(config.compaction.thresholdTokens !== undefined
          ? { thresholdTokens: config.compaction.thresholdTokens }
          : {}),
        ...(config.compaction.keepRecentTurns !== undefined
          ? { keepRecentTurns: config.compaction.keepRecentTurns }
          : {}),
        ...(postCompactEmit !== undefined ? { postCompactEmit } : {}),
        ...(objectiveSetNextActions !== undefined ? { objectiveSetNextActions } : {}),
        ...(postCompactEmit !== undefined || objectiveSetNextActions !== undefined
          ? { recoveryReason: "token_budget_exceeded" as const }
          : {}),
        ...(config.sessionId !== undefined && config.sessionId.length > 0
          ? { threadId: config.sessionId }
          : {}),
        ...(onPreCompact !== undefined
          ? {
              preflight: async (q: {
                currentTokens: number
                threshold: number
                proposedKeep: number
                proposedSummaryTokens: number
              }): Promise<"approve" | "defer_one_turn" | "force_now"> =>
                onPreCompact({ turnId, ...q }),
            }
          : {}),
        ...(preCompactHook !== undefined ? { preCompactHook } : {}),
      })
    }
  } catch (e) {
    const message = errMessage(e)
    config.stream.emit({
      type: "error",
      message: `proactive compaction failed: ${message}`,
    })
    return { abort: false }
  }
  if (result.compacted) {
    emitRecovery(config, "compact", "proactive")
    const after = estimateTokens(result.messages)
    breaker?.recordProactive(before, after)
    emitCompactionEvent(config, {
      kind: "compaction_event",
      trigger: "pre_sampling",
      reason: "context_limit",
      tokensBefore: before,
      tokensAfter: after,
      messagesRemoved: Math.max(snapshot.length - result.messages.length, 0),
      at: Date.now(),
    })
    wm.replace(result.messages)
    resetClassifier(config.effortClassifier)
    if (archive !== undefined) {
      const summaryText = extractSummaryText(result.messages[0])
      const entry = {
        fromTurnId,
        toTurnId: turnId,
        summary: summaryText,
        ts: Date.now(),
        tokens: result.summaryTokens,
      }
      appendSummary(archive, entry)
      config.stream.emit({ type: "context_compacted", ...entry })
    }
  } else if (result.reason === "no_boundary") {
    breaker?.recordProactive(before, before)
  }
  bgController?.maybeStart({
    // FULL-snapshot read of the (possibly just-compacted) live wm. The decorator
    // reseeds on `replace`, so `tokenTotal()` reflects the post-compaction set
    // and is byte-identical to the re-scan; OFF ⇒ direct `estimateTokens`.
    usedTokens: wm.tokenTotal?.() ?? estimateTokens([...wm.snapshot()]),
    limitTokens: bgLimitTokens,
  })
  return { abort: false }
}

export const SUMMARY_WRAPPER_RE = /^<conversation summary>\n/

export const extractSummaryText = (msg: Message | undefined): string => {
  if (!msg || msg.content.length === 0) return ""
  const first = msg.content[0]
  if (!first || first.type !== "text") return ""
  return first.text.replace(SUMMARY_WRAPPER_RE, "")
}

export const staticSystemFor = (config: AgentConfig): SystemPromptInput =>
  buildTurnContext({
    baseMessages: [],
    cwd: config.cwd,
    planMode: config.planMode ?? false,
    system: config.system,
    untrustedEnvelope: runtimeConfig().untrustedEnvelope,
  }).system

export const emitCompactionEvent = (config: AgentConfig, event: CompactionEventVariant): void => {
  if (config.compactionEventEmit === undefined) return
  try {
    config.compactionEventEmit(event)
  } catch {
    // Pure observability.
  }
}

export const resolveContextEventsForTurn = (
  config: AgentConfig,
): readonly import("../context-change").ContextEvent[] => {
  if (config.contextEventsForTurn === undefined) return []
  try {
    return config.contextEventsForTurn()
  } catch {
    return []
  }
}
