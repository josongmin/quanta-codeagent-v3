import { join } from "node:path"
import type { Message, SystemPromptInput } from "@/llm"
import type { CompactionEventVariant } from "@/memory/typed-event"
import { errMessage, logger, runtimeConfig } from "@/shared"
import {
  type BgSummaryPayload,
  compactIfNeeded,
  estimateTokens,
  resolveCompactionLimitTokens,
  TokenBaselineBox,
  toolResultRefs,
  toolUseIds,
} from "../compaction"
import type { BackgroundSummarizationController } from "../compaction/index"
import type { BreakerVerdict, CompactionBreaker } from "../compaction-breaker"
import { appendSummary, type ConversationSummaryArchive } from "../conversation-summary-archive"
import { buildPostCompactEmit, buildPreCompactHook } from "../loop-helpers"
import { buildTurnContext } from "../prompt"
import { createEvictionSpillPort, microcompactToolResults } from "../tool-result-evict"
import type { AgentConfig } from "../types"
import {
  configuredModel,
  emitRecovery,
  objectiveBudgetExhausted,
  resolveWindowModel,
} from "./emit-helpers"

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
 * Drop a session's microcompact-cadence entry. Called from `finishAgentSession`
 * on session end so this module `Map` does not accumulate ONE entry per session
 * for the whole process lifetime — a real leak in a long-lived daemon running
 * many sessions with `QUANTA_MICROCOMPACT` on (measured ~2 KB/session, never
 * GC-reclaimable while the module holds the key). Idempotent / no-op on a session
 * that never microcompacted.
 */
export const forgetMicrocompactSession = (sessionId: string | undefined): void => {
  lastMicrocompactAt.delete(sessionId ?? "")
}

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
    // jul-3: a tier-1 microcompaction fired by the time-based CADENCE gate, not a
    // hard context/token limit. Emitting `cadence` (vs the tier-2 proactive
    // path's `context_limit`) lets a consumer tell a cheap periodic eviction
    // apart from a real limit-driven summarize in the typed narrative.
    reason: "cadence",
    tokensBefore: estimateTokens([...snapshot]),
    tokensAfter: estimateTokens([...result.messages]),
    messagesRemoved: 0,
    at: now,
  })
  return true
}

/** §11.5 — ON-DEMAND summarize (the `/summarize-now` mid-turn verb). A lean
 *  force-compaction over the live working memory: unlike {@link maybeCompact}
 *  (auto-window, microcompact + bg-controller machinery), this skips all the
 *  optimizers and just runs ONE tier-2 summarize regardless of the token
 *  threshold (`force:true`), installing the result via `wm.replace`. Returns
 *  whether it actually compacted (`no_boundary` ⇒ false, no-op). Default-OFF:
 *  `config.compaction` absent ⇒ returns false (the verb degrades to a no-op). */
export const compactNowOnDemand = async (
  config: AgentConfig,
  wm: import("@/memory").WorkingMemory<Message> & { tokenTotal?(): number },
  // D5 (jul-2) — the per-session token-baseline BOX. On-demand `/summarize-now`
  // shrinks the prefix via `wm.replace` below, so the baseline measured against
  // the OLD prefix is now stale (its `measuredAtMessageCount` index no longer maps
  // onto the new transcript). Every OTHER replace site invalidates it (the
  // proactive path at ~L202, the reactive path in recovery-executor); this one did
  // NOT, so once the transcript regrew past the stale index the `> length`
  // fail-safe stopped firing and a later turn compacted prematurely. Thread the box
  // (same shape the proactive path takes) and invalidate AFTER the replace.
  // `undefined` ⇒ no box wired ⇒ byte-identical to the pre-fix behaviour.
  tokenBaselineBox: import("../compaction").TokenBaselineBoxState | undefined = undefined,
  activeModel: string = configuredModel(config.llm),
): Promise<boolean> => {
  if (!config.compaction) return false
  const result = await compactIfNeeded({
    messages: [...wm.snapshot()],
    llm: config.compaction.summarizerLlm ?? config.llm,
    system: config.system,
    force: true,
    // GAP 3 (ADR-0505): threshold resolves against the 1M window when active.
    model: resolveWindowModel(config.llm, activeModel),
    ...(config.compaction.thresholdTokens !== undefined
      ? { thresholdTokens: config.compaction.thresholdTokens }
      : {}),
    ...(config.compaction.keepRecentTurns !== undefined
      ? { keepRecentTurns: config.compaction.keepRecentTurns }
      : {}),
  })
  if (!result.compacted) return false
  const beforeMessages = [...wm.snapshot()]
  const before = beforeMessages.length
  // jul-3 — emit the typed compaction narrative for the ON-DEMAND `/summarize-now`
  // verb. Every OTHER compaction site (proactive tier-2 ~L409, tier-1 micro ~L112)
  // emits a `compaction_event`; this hand-triggered path did NOT, so a manual
  // summarize was invisible in the typed history stream. `trigger:"user_requested"`
  // + `reason:"manual"` (both pre-existing enum members) mark it distinctly from a
  // limit-driven pass. Emitted BEFORE `wm.replace` so `tokensBefore` measures the
  // pre-compaction transcript. No-op emitter (config.compactionEventEmit absent) ⇒
  // byte-identical (the emit swallows on undefined port).
  emitCompactionEvent(config, {
    kind: "compaction_event",
    trigger: "user_requested",
    reason: "manual",
    tokensBefore: estimateTokens(beforeMessages),
    tokensAfter: estimateTokens([...result.messages]),
    messagesRemoved: Math.max(before - result.messages.length, 0),
    at: Date.now(),
  })
  // CRITICAL (§4.6): install via `wm.replace` so the delta-token counter reseeds
  // (a direct `wm.messages[i]` write would bypass it and drift `tokenTotal()`).
  wm.replace([...result.messages])
  // D5 (jul-2) — the on-demand summarize just replaced the prefix. If it SHRANK
  // the transcript, the token baseline measured against the old prefix is stale;
  // invalidate it via the owner method (the same `invalidateOnShrink` seam the
  // proactive path in `prepareTurnContext` uses) so a stale index cannot force a
  // premature compaction on a later turn. No-op when no box is wired or the
  // transcript did not shrink (byte-identical).
  if (tokenBaselineBox !== undefined)
    TokenBaselineBox.wrap(tokenBaselineBox).invalidateOnShrink(before, wm.snapshot().length)
  return true
}

/**
 * H1 (jul-2) — rebuild a background-compaction install against the LIVE working
 * memory instead of installing the FROZEN snapshot suffix the bg pass produced.
 *
 * The bg pass (`speculativeSummarizeAdapter`) snapshots the wm at `maybeStart`
 * time (turn N), folds `snapshot[0..prefixLen)` into a synthetic summary, and
 * returns `[synthetic, ...snapshot[prefixLen..]]`. By the reconcile boundary the
 * LIVE wm has usually GROWN — turn N+1 appended messages AFTER the snapshot.
 * Installing the frozen payload verbatim would `wm.replace(...)` those appends
 * away (history loss, and a possible orphaned tool_use/tool_result at the seam).
 *
 * This recomputes `[synthetic, ...liveWm.slice(prefixLen)]` so the post-snapshot
 * appends survive. It returns `undefined` (⇒ DISCARD, caller falls back to the
 * synchronous path and leaves live history untouched) when the boundary is stale
 * or the seam would orphan a tool_result:
 *   - `prefixLen` out of range for the live wm (the wm was shrunk/replaced under
 *     us between maybeStart and reconcile), OR
 *   - the FROZEN suffix (what the pass captured at `snapshot[prefixLen..]`) is no
 *     longer a prefix of the live suffix (`liveWm[prefixLen..]`). Turn N+1 only
 *     APPENDS, so the frozen suffix must still sit at the head of the live suffix
 *     by reference (the wm hands back the SAME stored objects). A mismatch means
 *     the live history was REWRITTEN/replaced (e.g. a microcompact or a reactive
 *     squeeze) under us ⇒ our synthetic no longer summarizes the right prefix ⇒
 *     installing would corrupt. This subsumes a bare length check and catches a
 *     same-length in-place rewrite. OR
 *   - the LIVE suffix contains a tool_result whose tool_use lived in the
 *     summarized prefix (the synthetic carries no tool_use ⇒ it would dangle).
 *
 * PURE + side-effect-free; the caller applies `wm.replace`.
 */
export const rebuildBgInstallAgainstLive = (
  frozenSummary: readonly Message[],
  summarizedPrefixLen: number,
  liveMessages: readonly Message[],
): Message[] | undefined => {
  // The bg payload is ALWAYS `[synthetic, ...suffix]` (length ≥ 1); a malformed
  // empty payload is a discard.
  const synthetic = frozenSummary[0]
  if (synthetic === undefined) return undefined
  // STALE-BOUNDARY GUARD — the boundary must still index into the live wm.
  if (summarizedPrefixLen < 0 || summarizedPrefixLen > liveMessages.length) return undefined
  const liveSuffix = liveMessages.slice(summarizedPrefixLen)
  // STALE-HISTORY GUARD — the frozen suffix must still be the HEAD of the live
  // suffix (turn N+1 only appends). A reference mismatch ⇒ the wm was rewritten/
  // replaced between maybeStart and reconcile ⇒ discard (do NOT corrupt). The
  // live suffix must be at least as long as the frozen one (appends grow it).
  const frozenSuffix = frozenSummary.slice(1)
  if (liveSuffix.length < frozenSuffix.length) return undefined
  for (let i = 0; i < frozenSuffix.length; i++)
    if (frozenSuffix[i] !== liveSuffix[i]) return undefined
  // ORPHAN RE-CHECK at the synthetic↔suffix seam. The synthetic replaces the
  // whole summarized prefix and carries NO tool_use, so any tool_result in the
  // live suffix whose matching tool_use lived in the (now-summarized) prefix is
  // orphaned (Anthropic rejects an unpaired tool_result). Reuse the SAME id
  // helpers `findBoundary` uses: gather every tool_use id the suffix itself
  // produces, then reject if any suffix tool_result references an id NOT in that
  // set. (The suffix interior was already self-consistent in the live wm; the
  // only NEW risk is refs into the removed prefix — this catches all of them.)
  const suffixToolUseIds = new Set<string>()
  for (const m of liveSuffix) for (const id of toolUseIds(m)) suffixToolUseIds.add(id)
  for (const m of liveSuffix)
    for (const ref of toolResultRefs(m)) if (!suffixToolUseIds.has(ref)) return undefined
  return [synthetic, ...liveSuffix]
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
  // D5 (jun-7) — the per-session token-baseline BOX. `.current` (the prior turn's
  // exact measurement) anchors the trigger; `undefined` ⇒ chars/4 (legacy). We
  // take the BOX (not the value) so a tier-1 MICROCOMPACT — which replaces
  // tool_result CONTENT while keeping the message COUNT — can INVALIDATE the
  // baseline: the length-based `markBaselineStaleIfShrunk` (context-assembler)
  // structurally cannot see a content-only shrink, so the stale prefix-measured
  // baseline would otherwise force a premature tier-2 compaction.
  tokenBaselineBox: import("../compaction").TokenBaselineBoxState | undefined,
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
    // D5 — microcompact replaced the prefix's tool_result CONTENT (count-stable),
    // so the baseline measured against that fat prefix is now stale. Invalidate
    // it; the tier-2 decision below + the next turn re-anchor on chars/4 until a
    // fresh exact usage lands. (The length-based invalidation cannot catch this.)
    if (tokenBaselineBox !== undefined)
      TokenBaselineBox.wrap(tokenBaselineBox).invalidateOnContentChange()
  }
  // D4 (jun-7 naive-impl hardening) — the bg-controller ceiling must match the
  // synchronous proactive path's model-derived threshold, so pass the same model.
  const bgLimitTokens = resolveCompactionLimitTokens(
    config.compaction?.thresholdTokens,
    resolveWindowModel(config.llm, activeModel),
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
  // H1 (jul-2) — recompute a bg-compaction install against the LIVE wm (`snapshot`
  // is `[...wm.snapshot()]` at reconcile time, already reflecting turn N+1's
  // appends). Installing `borrowed.summary` verbatim would `wm.replace(...)` those
  // appends away. `undefined` ⇒ stale/orphan-unsafe ⇒ fall through to the
  // synchronous path (leave live history untouched). NB: `bgController` is only
  // wired when QUANTA_BG_COMPACTION==="1"; OFF ⇒ `borrowed` is undefined ⇒ this is
  // never entered ⇒ byte-identical.
  const bgInstall =
    borrowed?.kind === "install"
      ? rebuildBgInstallAgainstLive(borrowed.summary, borrowed.summarizedPrefixLen, snapshot)
      : undefined
  if (borrowed?.kind === "install" && bgInstall === undefined)
    emitRecovery(config, "compact", "bg-install-stale")
  try {
    if (bgInstall !== undefined) {
      result = {
        compacted: true,
        messages: bgInstall,
        summaryTokens: estimateTokens(bgInstall.slice(0, 1)),
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
        // transcript, byte-identical legacy). GAP 3 (ADR-0505): the window
        // resolves to the 1M key when context-1m is active (compactIfNeeded uses
        // `model` ONLY for the threshold, never for records).
        model: resolveWindowModel(config.llm, activeModel),
        ...(tokenBaselineBox !== undefined &&
        TokenBaselineBox.wrap(tokenBaselineBox).currentBaseline() !== undefined
          ? // biome-ignore lint/style/noNonNullAssertion: guarded by the check above
            { tokenBaseline: TokenBaselineBox.wrap(tokenBaselineBox).currentBaseline()! }
          : {}),
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
    // M9 (jul-2) — a proactive compaction that THREW freed nothing, so it must
    // accrue a no-progress strike (identical to the `no_boundary` branch below).
    // Otherwise a summarizer that keeps throwing over threshold spins forever and
    // the futility breaker never trips in the exact mode it exists for. We do NOT
    // fail-close here: proactive runs pre-sampling and the reactive PTL path is
    // the correct fail-closed backstop (there is no hardWindow concept here), so
    // we keep `return {abort:false}` — the strike surfaces at the NEXT
    // `maybeCompact` via `breaker.check()`. Emit a `proactive-failed` recovery
    // detail so the trajectory distinguishes a throw from a successful compact.
    breaker?.recordProactive(before, before)
    emitRecovery(config, "compact", "proactive-failed")
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
  } catch (e) {
    // A throwing context-events provider must be OBSERVABLE, not silently
    // indistinguishable from "no events" — mirror the sibling `resolveMemoryContext`
    // (context-assembler) which surfaces a NON-FATAL `error` event on throw. We
    // still degrade clean (return `[]`); the emit only ADDS visibility. The SUCCESS
    // path is untouched (no emit when nothing throws) ⇒ byte-identical.
    config.stream.emit({
      type: "error",
      message: `context-events provider failed: ${errMessage(e)}`,
    })
    return []
  }
}
