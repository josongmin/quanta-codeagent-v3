import type { LLMPort, StreamEvent, ToolChoice } from "@/llm"
import { applyMeasuredUsageLimit } from "@/objective"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  type NormalizedUsage,
  normalizeUsage,
  priceUsage,
  type UsageAccountingPort,
  type UsageCost,
  type UsageProvenance,
  type UsageRejection,
} from "@/observability/usage-accounting"
import type { PromptPolicySnapshot, TurnPolicySnapshot } from "@/shared"
import { errMessage, LLMError, logger, runtimeConfig } from "@/shared"
import type { BudgetBreach } from "../budget-ledger"
import type { CancelSubagentOutcome, ResponseQueuedReason } from "../control-op-handler"
import type { AgentRecorder } from "../metrics"
import type { RecoveryReason } from "../recovery"
import { isRootAgent } from "../spawn-depth"
import type { AgentConfig } from "../types"
import type { TurnWorkMetricsCollector } from "../work-metrics-collector"

// Re-exported from the dispatch SSOT so the loop's consumers (turn-loop,
// stream-consume) keep a stable `./emit-helpers` import while the predicate has
// a single definition shared with the sync/streaming dispatch paths.
export { isSessionApprovalRequiredError } from "../dispatch-helpers"

/** The priced context one usage event is fanned out to every downstream sink
 *  with. `eventCost` is priced ONCE here through the single formula and shared,
 *  so no sink re-prices — and no two sinks can reach different totals for the
 *  same event, which is exactly what used to happen when the meter read one
 *  implementation and the ledger another. */
type UsageSinkCtx = {
  readonly config: AgentConfig
  readonly ev: Extract<StreamEvent, { type: "usage" }>
  readonly recorder: AgentRecorder | undefined
  readonly collector: TurnWorkMetricsCollector | undefined
  readonly taskSpend: { tokens: number } | undefined
  /** ALBB-21 — a single-slot handoff between the L4 record sink (producer) and
   *  the budget-breach advisory sink (consumer). The record sink writes the
   *  ledger's returned breach list here; the later advisory sink reads it and
   *  emits one `budget_breach` AgentEvent per breach. The object reference is
   *  `readonly` but its slot is mutable — the only stateful handoff between two
   *  sinks (they run in array order, producer strictly before consumer). Empty
   *  by default: no ledger / no breach ⇒ stays `[]` ⇒ the advisory sink is a
   *  no-op (default-OFF byte-identical). */
  readonly breachSlot: { breaches: ReadonlyArray<BudgetBreach> }
  /** MR-03 — lineage of the agent that made THIS call, derived once from the
   *  emitting config so every sink stamps the same answer. */
  readonly provenance: UsageProvenance
  /** MR-03 — the same usage in canonical disjoint buckets. Normalized ONCE
   *  here so no sink re-derives it (and re-derives it differently). */
  readonly normalized: NormalizedUsage
  /** The itemized cost of {@link normalized}. Every sink that needs a dollar
   *  figure reads THIS one. */
  readonly eventCost: UsageCost
  /** Identity of this model call, shared by every sink that records it, so the
   *  accountant and the OTel export describe the SAME call rather than two. */
  readonly callId: string
}

/** One usage-event consumer. Adding a downstream (a new meter, ledger, gauge)
 *  is appending a sink HERE — never surgery on the {@link emitUsage} hot body
 *  (OCP). Each sink is individually a no-op when its optional collaborator is
 *  unwired, so ordering is observable-independent; the array order mirrors the
 *  historical inline order for byte-identity. */
type UsageSink = (c: UsageSinkCtx) => void

const USAGE_SINKS: readonly UsageSink[] = [
  // Surface stream event — the `/context` gauge & usage readouts.
  ({ config, ev, provenance }) =>
    config.stream.emit({
      type: "usage",
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      model: ev.model,
      // MR-03 — who spent it. A subagent emits onto the parent's stream, so
      // without these two fields the surface cannot separate root from child.
      agentId: provenance.agentId,
      agentKind: provenance.agentKind,
      ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
      ...(ev.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: ev.cacheCreationTokens }
        : {}),
      // S3 (jul-03) — forward the OpenAI-Responses reasoning-token split so
      // surface sinks can render it. `!== undefined` (not truthiness) keeps an
      // explicit `0` split; omission stays omitted (Anthropic byte-identical).
      ...(ev.reasoningTokens !== undefined ? { reasoningTokens: ev.reasoningTokens } : {}),
    }),
  // MR-06 — OTel export. The token counters stay provider-shaped (semconv);
  // what comes from the canonical record is the pair that had no live emit site
  // at all: cache-WRITE and the priced cost.
  ({ recorder, ev, eventCost }) => recorder?.usageRecorded(ev, eventCost),
  // Autonomous-safety cost cap (L0): tick tokens AND the pre-priced USD into the
  // per-run meter (the same single seam). Unpriced model ⇒ skip the cost tick so
  // the cap stays a no-op rather than billing $0 falsely. `maxCostUsd` is only
  // set on autonomous modes (batch/daemon/ci-bot); interactive accrues but never
  // gates (human-paced, by design).
  ({ config, ev, eventCost }) => {
    config.budgetMeter?.tick("input_tokens", ev.inputTokens)
    config.budgetMeter?.tick("output_tokens", ev.outputTokens)
    // MR-05 — the meter now ticks the SAME priced figure the accountant records,
    // which is the whole point of there being one formula. Two consequences,
    // both deliberate:
    //   - cache-WRITE is now billed to the meter. `costUsd` has no parameter
    //     for it, so every cache-creation token used to be free to the cost
    //     cap while the ledger billed it — an autonomous run could exceed its
    //     ceiling by whatever it spent warming caches.
    //   - an unpriced model still skips the tick rather than billing $0, so an
    //     unknown model leaves the cap inert instead of falsely reassuring it.
    if (eventCost.pricingKnown) config.budgetMeter?.tick("cost_usd", eventCost.totalUsd)
  },
  // L4 cross-run cost ledger (default-OFF: no `budgetLedger` ⇒ no-op). Maps the
  // provider's cache-CREATION tokens onto the ledger's cache-write bucket (which
  // the ledger bills and `costUsd` does not); same SSOT rate card so meter and
  // ledger never disagree. Hard breach *stops* the run at the turn epilogue via
  // `ledgerHardBreachCondition`; the returned breach list is captured here so the
  // ADVISORY sink below can surface EVERY crossed cap (soft AND hard) as a
  // `budget_breach` event without re-recording. Return dropped ⇒ no advisory
  // (the wired-but-inert trap this fix closes).
  ({ config, ev, breachSlot }) => {
    const result = config.budgetLedger?.record({
      model: ev.model,
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
      ...(ev.cacheCreationTokens !== undefined ? { cacheWriteTokens: ev.cacheCreationTokens } : {}),
      sessionId: config.sessionId ?? "",
      at: Date.now(),
    })
    if (result !== undefined) breachSlot.breaches = result.breaches
  },
  // MR-03 — the session's usage accountant. Absent ⇒ no-op (default-OFF,
  // byte-identical). This is the sink every cost SURFACE will read from, so it
  // records the canonical normalized usage and the priced cost rather than a
  // surface-specific projection. Children share the parent's instance, so a
  // subagent's spend lands in the same counters instead of falling out of them.
  ({ config, normalized, provenance, eventCost, callId, recorder }) => {
    const accounting = config.usageAccounting
    if (accounting === undefined) return
    const result = accounting.record({
      callId,
      at: Date.now(),
      usage: normalized,
      cost: eventCost,
      provenance,
    })
    // A5 — a refusal must be visible. The counter ticks on EVERY rejection
    // (metrics optional); the operator warn is latched per AUTHORITY + REASON
    // so repeats do not spam, while a second failure mode is not suppressed by
    // whichever one happened first.
    const reason = result.reason
    if (!result.admitted && reason !== undefined && reason !== "duplicate") {
      recorder?.usageRejected(reason)
      const warnedReasons = rejectedWarned.get(accounting) ?? new Set<ObservableUsageRejection>()
      if (!warnedReasons.has(reason)) {
        warnedReasons.add(reason)
        rejectedWarned.set(accounting, warnedReasons)
        logger.warn(
          `usage accounting rejected a record (${reason}) — model=${normalized.model} agent=${provenance.agentId}; totals exclude it`,
        )
      }
    }
  },
  // Turn work-metrics collector.
  ({ collector, ev, eventCost }) =>
    collector?.recordUsage({
      tokensInput: ev.inputTokens,
      tokensOutput: ev.outputTokens,
      // MR-05 — the model THIS request ran on, as reported by the adapter that
      // streamed it. Costing the whole turn at one label (a live selection read at
      // turn close) priced every request at whatever was selected when the turn
      // ended, which is wrong the moment a turn spans two models.
      ...(ev.model !== undefined ? { model: ev.model } : {}),
      ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
      cost: eventCost,
    }),
  // Per-task spend accumulator (guards against NaN / negative token counts).
  ({ taskSpend, ev }) => {
    if (taskSpend === undefined) return
    const inTok = Number.isFinite(ev.inputTokens) && ev.inputTokens > 0 ? ev.inputTokens : 0
    const outTok = Number.isFinite(ev.outputTokens) && ev.outputTokens > 0 ? ev.outputTokens : 0
    taskSpend.tokens += inTok + outTok
  },
  // Prompt-cache hit/write observer.
  ({ config, ev }) =>
    config.promptCacheObserver?.record({
      model: ev.model,
      sessionId: config.sessionId ?? "",
      turnIndex: 0,
      atMs: Date.now(),
      inputTokens: ev.inputTokens,
      cacheCreationTokens: ev.cacheCreationTokens ?? 0,
      cacheReadTokens: ev.cacheReadTokens ?? 0,
      outputTokens: ev.outputTokens,
    }),
  // ALBB-21 advisory: surface each crossed budget cap as ONE non-fatal
  // `budget_breach` AgentEvent. Consumes the `RecordResult.breaches` the L4
  // record sink captured above (deterministic order, 0..4 entries). SOFT
  // never stops the run (HARD *stop* is `ledgerHardBreachCondition`'s job);
  // this is pure observability, mirroring the Claude Code / Codex cost-warning
  // banner. `severity`/`scope`/`observed`/`limit` are derived VERBATIM from the
  // typed `BudgetBreach` (no invented threshold). Empty ⇒ no emit (default-OFF
  // byte-identical: no ledger or no crossing leaves the slot `[]`).
  ({ config, breachSlot }) => {
    for (const breach of breachSlot.breaches) {
      config.stream.emit({
        type: "budget_breach",
        severity: breach.kind.endsWith("-hard") ? "hard" : "soft",
        scope: breach.scope,
        observed: breach.observed,
        limit: breach.limit,
      })
    }
  },
]

/**
 * Fallback call sequence for the default-OFF path.
 *
 * A wired authority owns and persists its own sequence. This weak map exists
 * only when accounting is absent, where the identifier is not persisted and no
 * accounting deduplication depends on it.
 *
 * This makes ids unique; it does not make `emitUsage` deduplicating. The port's
 * `callId` idempotency defends against a record being submitted twice from
 * ELSEWHERE — a resumed session replaying persisted records, or a shadow
 * reconciliation feeding the same call down two paths. One stream event still
 * means one admitted call.
 */
const callSeq = new WeakMap<object, { n: number }>()

type ObservableUsageRejection = Exclude<UsageRejection, "duplicate">

/** A5 — rejection reasons already voiced by each authority. Each set is
 *  bounded by the closed two-member rejection union; weak keys avoid keeping
 *  dead session authorities alive. */
const rejectedWarned = new WeakMap<object, Set<ObservableUsageRejection>>()

/** Test seam: has this authority voiced this rejection reason? When omitted,
 *  preserves the old any-warning probe for downstream tests. */
export const __rejectedWarnedFor = (
  accounting: object,
  reason?: ObservableUsageRejection,
): boolean => {
  const warnedReasons = rejectedWarned.get(accounting)
  return reason === undefined
    ? (warnedReasons?.size ?? 0) > 0
    : (warnedReasons?.has(reason) ?? false)
}

/** Test seam: number of distinct reasons voiced for this authority. */
export const __rejectedWarnedReasonCountFor = (accounting: object): number =>
  rejectedWarned.get(accounting)?.size ?? 0

const nextCallId = (
  accounting: UsageAccountingPort | undefined,
  fallbackIdentity: object,
  provenance: UsageProvenance,
): string => {
  if (accounting !== undefined) return accounting.mintCallId(provenance)
  const seq = callSeq.get(fallbackIdentity) ?? { n: 0 }
  seq.n += 1
  callSeq.set(fallbackIdentity, seq)
  return `${provenance.sessionId}:${provenance.agentId}:${seq.n}`
}

/**
 * Derive who is spending from the emitting config's own lineage.
 *
 * `depth` is the authority: it is set at spawn (`childDepthOf(parent)`) and
 * persisted, so it survives resume. A root config has no depth; anything
 * deeper is a subagent. The mailbox ids supply stable names.
 */
const provenanceOf = (config: AgentConfig): UsageProvenance => {
  const depth = config.depth ?? 0
  return {
    sessionId: config.sessionId ?? "",
    agentId: config.mailboxAgentId ?? "root",
    agentKind: isRootAgent(config) ? "root" : "subagent",
    depth,
    ...(config.mailboxParentId !== undefined ? { parentAgentId: config.mailboxParentId } : {}),
  }
}

export const emitUsage = (
  config: AgentConfig,
  ev: Extract<StreamEvent, { type: "usage" }>,
  recorder: AgentRecorder | undefined,
  collector: TurnWorkMetricsCollector | undefined,
  taskSpend: { tokens: number } | undefined,
): void => {
  const provenance = provenanceOf(config)
  const normalized = normalizeUsage({
    model: ev.model,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
    // The adapter's cache-CREATION bucket is the canonical cache-WRITE bucket.
    ...(ev.cacheCreationTokens !== undefined ? { cacheWriteTokens: ev.cacheCreationTokens } : {}),
    ...(ev.reasoningTokens !== undefined ? { reasoningTokens: ev.reasoningTokens } : {}),
  })
  const ctx: UsageSinkCtx = {
    config,
    ev,
    recorder,
    collector,
    taskSpend,
    // Priced once via the pricing SSOT (the only place `ev.model` is available).
    // ALBB-21 — fresh per-event breach handoff slot (record sink writes, advisory
    // sink reads). Starts empty so the advisory sink is a no-op when no cap crosses.
    breachSlot: { breaches: [] },
    provenance,
    normalized,
    eventCost: priceUsage(normalized, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
    callId: nextCallId(config.usageAccounting, config, provenance),
  }
  for (const sink of USAGE_SINKS) sink(ctx)
}

export const emitRecovery = (
  config: AgentConfig,
  reason: RecoveryReason,
  detail?: string,
): void => {
  config.stream.emit({
    type: "recovery",
    reason,
    ...(detail !== undefined ? { detail } : {}),
  })
}

export const configuredModel = (llm: AgentConfig["llm"]): string => {
  const m = llm.model
  return m !== undefined && m !== "" ? m : "unknown"
}

/** gap GAP 3 (ADR-0505) — the model id to resolve the CONTEXT WINDOW against
 *  (compaction threshold + usage gauge). When the active turn model IS the
 *  configured base model AND the port pins a 1M window key (context-1m active),
 *  resolve the window against that `<model>-1m` key so compaction tracks the
 *  granted 1M window. A skill/sticky SWAP (active != base) or no pinned key ⇒ the
 *  active model id as-is. NEVER returned to reporting/records — those keep the
 *  real model id; this is window-resolution ONLY. */
export const resolveWindowModel = (
  llm: AgentConfig["llm"],
  activeModel: string = configuredModel(llm),
): string =>
  llm.contextWindowKey !== undefined && activeModel === configuredModel(llm)
    ? llm.contextWindowKey
    : activeModel

export const objectiveBudgetExhausted = (config: AgentConfig, threadId: string): boolean => {
  if (!runtimeConfig().objectiveBudgetEnforce) return false
  if (config.objective === undefined || threadId.length === 0) return false
  try {
    return config.objective.get(threadId)?.status === "budget_limited"
  } catch (e) {
    logger.warn(`loop.objectiveBudgetExhausted: ${errMessage(e)}`)
    // ALBB-07 claim 3 — DIRECTIONAL ADVISORY hardening ONLY. With enforce ON, a
    // throwing objective store previously returned `false` (fail-OPEN) → the
    // reactive compact branch proceeded to the "Resuming after mid-turn
    // compaction" advisory nudge. Its blast radius is ONLY that advisory
    // next-actions nudge — NOT the loop-continuation enforcement gate (that
    // lives in `objective/continuation.ts` and is INDEPENDENTLY fail-closed on a
    // throwing store: `readStatus` → null → `skip("no-goal")`; a throwing store
    // cannot bypass real enforcement). Fail-CLOSED here (treat as exhausted ⇒
    // skip the advisory nudge) is a defensive default, NOT an enforcement-bypass
    // fix — no efficacy A/B required.
    return true
  }
}

/**
 * RFC-06 A4.3 — feed a MEASURED provider 429 (`LLMError.retryAfterMs`, the
 * server's `retry-after` delta parsed at the `fromSdkError` boundary) into the
 * objective as a transient `usage_limited` window.
 *
 * GATE (byte-identical default-OFF): reads `runtimeConfig().objectiveBudgetEnforce`
 * — the SAME gate `objectiveBudgetExhausted` rides. When OFF this returns BEFORE
 * touching the objective port, so NO `markUsageLimited` mutation ever happens
 * (the objective is byte-identical to today). When ON, an `active`/`usage_limited`
 * objective is limited until `Date.now() + retryAfterMs` (auto-resets when the
 * clock passes it — see `applyMeasuredUsageLimit`'s no-resurrect + no-double-count
 * contract).
 *
 * `result` is the loop's non-success recovery payload: it carries the thrown
 * stream `error` ONLY on the `{ error, message }` arm (a successfully-assembled
 * turn has no `error`). We act ONLY on an `LLMError` bearing a finite positive
 * `retryAfterMs` — a 429 without a parsable retry-after (no epoch) is left to
 * blind-exponential backoff and does NOT limit the objective.
 *
 * Returns `true` iff a window was set (for the caller to attribute / observe);
 * NO-THROW — any failure degrades to `false`.
 */
export const markObjectiveUsageLimitedFrom429 = (
  config: AgentConfig,
  threadId: string,
  result: { readonly error: unknown } | { readonly message: unknown },
): boolean => {
  if (!runtimeConfig().objectiveBudgetEnforce) return false
  if (config.objective === undefined || threadId.length === 0) return false
  if (!("error" in result)) return false
  const error = result.error
  if (!(error instanceof LLMError)) return false
  // `retryAfterMs` is present ONLY when the boundary parsed a server delay from a
  // rate-limit / overload response. Absent ⇒ no measured epoch ⇒ no-op (blind
  // backoff owns that case; we never invent a window).
  const retryAfterMs = error.retryAfterMs
  if (retryAfterMs === undefined) return false
  try {
    return applyMeasuredUsageLimit(config.objective, threadId, retryAfterMs)
  } catch (e) {
    logger.warn(`loop.markObjectiveUsageLimitedFrom429: ${errMessage(e)}`)
    return false
  }
}

export const finalizeTurnPolicy = (args: {
  readonly promptPolicy: PromptPolicySnapshot
  readonly toolChoice: ToolChoice
  readonly promptCacheKey?: string
}): TurnPolicySnapshot => ({
  ...args.promptPolicy,
  toolChoice: args.toolChoice.kind,
  ...(args.toolChoice.kind === "tool" ? { toolChoiceToolName: args.toolChoice.name } : {}),
  promptCacheKeyPresent: args.promptCacheKey !== undefined && args.promptCacheKey.length > 0,
})

/**
 * Announce the request the turn is ABOUT to make.
 *
 * MR-04 — every identity field comes from the port that will actually STREAM
 * (`turnLlm.llm`), never from `config.llm`.
 *
 * `config.llm` is the BOOT port. Once a sticky pick, a `/model` switch or a skill
 * `model:` override could swap the port per turn, this event kept naming the boot
 * model for the rest of the session — and it is not a debug field: the CLI prints
 * it (`— llm request (<model>) —`), the debug tracer shows it, the session JSONL
 * records it, and the headless `stream-json` surface publishes it as
 * `turn.llm.request.model`. Measured through the real loop: the picked port
 * streamed while this said `boot-model`.
 *
 * The caller already holds the resolved port (`runSamplingScope` receives
 * `turnLlm`), so this takes it explicitly rather than re-deriving it — a
 * re-derivation is what would drift again.
 */
export const emitLlmRequest = (
  config: AgentConfig,
  llm: LLMPort,
  policy: TurnPolicySnapshot,
): void => {
  config.stream.emit({
    type: "llm_request",
    model: configuredModel(llm),
    ...(llm.provider !== undefined ? { provider: llm.provider } : {}),
    ...(llm.surfaceId !== undefined ? { surfaceId: llm.surfaceId } : {}),
    ...(llm.transportId !== undefined ? { transportId: llm.transportId } : {}),
    ...(llm.authMode !== undefined ? { authMode: llm.authMode } : {}),
    policy,
  })
}

export const emitLlmContinuation = (
  config: AgentConfig,
  ev: Extract<StreamEvent, { type: "llm_continuation" }>,
): void => {
  config.stream.emit({
    type: "llm_continuation",
    ...(config.llm.provider !== undefined ? { provider: config.llm.provider } : {}),
    surfaceId: ev.surfaceId,
    transportId: ev.transportId,
    phase: ev.phase,
    mode: ev.mode,
    reason: ev.reason,
    ...(ev.statusCode !== undefined ? { statusCode: ev.statusCode } : {}),
  })
}

export const emitSubagentCancel = (
  config: AgentConfig,
  subagentId: string,
  outcome: CancelSubagentOutcome,
  source: "submission_op" | "conversation_action",
): void => {
  config.stream.emit({
    type: "subagent_cancel",
    subagentId,
    outcome:
      outcome === "registry_absent"
        ? "registry_absent"
        : outcome === "stopped"
          ? "stopped"
          : "not_found",
    source,
  })
}

export const emitResponseQueued = (
  config: AgentConfig,
  reason: ResponseQueuedReason,
  hint?: string,
): void => {
  config.stream.emit({
    type: "response_queued",
    reason,
    ...(hint !== undefined ? { hint } : {}),
  })
}

export const emitInterrupted = (
  config: AgentConfig,
  source: "submission_interrupt" | "conversation_action_cancel",
  reason?: string,
): void => {
  config.stream.emit({
    type: "interrupted",
    source,
    ...(reason !== undefined ? { reason } : {}),
  })
}
