/**
 * RFC11-1 — corpus-parity observability projection for the subagent result.
 *
 * claude-code's `AgentOutput` carries `{modelsUsed?, totalToolUseCount,
 * totalDurationMs, totalTokens, usage{...}, frameCount?, worktreeBranch?}`.
 * quanta's `SubagentResult` historically carried only `{ok, finalText, turns}`.
 * Every missing signal ALREADY EXISTS elsewhere — this module surfaces them
 * ADDITIVELY by PROJECTING, never by introducing a store / meter / bus:
 *
 *   - `frameCount`        := `turns` (a parity alias — already tracked).
 *   - `modelsUsed`        := DISTINCT set = the child's resolved model UNIONED
 *                            with every model seen in the RFC-02-3
 *                            `model_route_changed` AgentEvents that reach the
 *                            child stream over the run. This is the SAME
 *                            project-from-events discipline RFC-02-3 mandates
 *                            (`stream/types.ts`: "there is NO route bus/store/
 *                            `modelsUsed` store; each caller PROJECTS"). SCOPE
 *                            (honest): the resolved model is ALWAYS present, so a
 *                            single-model run yields `[resolvedModel]` (the common
 *                            parity case). A route TRANSITION only widens the set
 *                            when its emitter targets the child loop's
 *                            `config.stream`; the three current route callers
 *                            (`operator_retry`/`scheduler_reroute`/`provider_
 *                            fallback`) own their OWN sink per the single-owner
 *                            matrix and are NOT all wired to a child loop today —
 *                            so runtime in-child transitions are captured IFF such
 *                            a caller emits onto the child stream. The tap
 *                            mechanism is correct and complete; wiring a route
 *                            caller onto the child stream is a caller-side concern
 *                            (deferred), NOT a store this projection may add.
 *   - `worktreeBranch`    := the throwaway worktree branch from the
 *                            `withWorktree` run info (RFC-06 owned-worktree
 *                            analogue at the @/agent fork layer).
 *   - `totalToolUseCount` := count of `tool_call` AgentEvents the run emitted
 *                            (the existing tool-dispatch path).
 *   - `totalTokens`/`usage`:= sum of the `usage` AgentEvents the run emitted
 *                            (the existing per-completion usage emit — always-on
 *                            `config.stream.emit({type:"usage",...})`).
 *   - `totalDurationMs`   := a plain wall-clock delta the runner measures around
 *                            the child run (a `now()` subtraction, NOT a meter).
 *
 * The tap is a PASS-THROUGH observer over the parent stream: every event is
 * forwarded verbatim, so the emitted event stream is byte-identical whether or
 * not the projection is read. The projected fields are spread onto the result
 * CONDITIONALLY (never a literal `undefined`), so a run that produced no signals
 * yields a byte-identical `SubagentResult`.
 */

import type { AgentEvent, StreamPort } from "@/stream"

/** Mutable accumulator the tap sink folds observed events into. Pure counters —
 *  no I/O, no clock. One instance per child run. */
export interface SubagentObsAccumulator {
  /** Distinct models seen across `model_route_changed` events (insertion order
   *  preserved: `fromModel` then `toModel` as each transition arrives). */
  readonly models: Set<string>
  toolCalls: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** True once at least one `usage` event folded in — distinguishes "0 tokens
   *  reported" from "no usage event at all" (the latter omits the field). */
  sawUsage: boolean
}

export const newSubagentObsAccumulator = (): SubagentObsAccumulator => ({
  models: new Set<string>(),
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  sawUsage: false,
})

/** Add `n` into `into` when it is a finite positive-or-zero datum. A poisoned
 *  provider report (NaN / negative / undefined) contributes 0 — same defensive
 *  posture as the loop's `BudgetMeter.tick`. */
const addToken = (into: number, n: number | undefined): number =>
  n !== undefined && Number.isFinite(n) ? into + n : into

/** Fold one `usage` AgentEvent's buckets into the accumulator. Extracted from
 *  {@link observe} to keep it below the cognitive-complexity cap. */
const foldUsage = (acc: SubagentObsAccumulator, event: Extract<AgentEvent, { type: "usage" }>) => {
  acc.sawUsage = true
  acc.inputTokens = addToken(acc.inputTokens, event.inputTokens)
  acc.outputTokens = addToken(acc.outputTokens, event.outputTokens)
  acc.reasoningTokens = addToken(acc.reasoningTokens, event.reasoningTokens)
  acc.cacheReadTokens = addToken(acc.cacheReadTokens, event.cacheReadTokens)
  acc.cacheCreationTokens = addToken(acc.cacheCreationTokens, event.cacheCreationTokens)
}

/** Fold one AgentEvent into the accumulator. Only the three observability arms
 *  contribute; every other event is ignored (the tap still forwards it). Pure. */
const observe = (acc: SubagentObsAccumulator, event: AgentEvent): void => {
  switch (event.type) {
    case "model_route_changed": {
      if (event.fromModel.length > 0) acc.models.add(event.fromModel)
      if (event.toModel.length > 0) acc.models.add(event.toModel)
      return
    }
    case "tool_call": {
      acc.toolCalls += 1
      return
    }
    case "usage": {
      foldUsage(acc, event)
      return
    }
    default:
      return
  }
}

/**
 * Wrap `inner` (the parent stream) with a PASS-THROUGH tap that folds each
 * event into `acc` and then forwards it verbatim. The forwarded stream is
 * byte-identical to `inner` alone — the tap is a pure observer. The child
 * config's `stream` is set to this so the runner can project the child run's
 * own events without a shared-stream ambiguity.
 */
export const tappedStream = (inner: StreamPort, acc: SubagentObsAccumulator): StreamPort => ({
  emit(event: AgentEvent): void {
    observe(acc, event)
    inner.emit(event)
  },
})

/** The additive projection the runner spreads onto its `SubagentResult`. Every
 *  field is optional; a field is present ONLY when its source produced a value,
 *  so an empty projection spreads to nothing (byte-identical result). */
export interface SubagentObsProjection {
  frameCount?: number
  modelsUsed?: readonly string[]
  worktreeBranch?: string
  totalToolUseCount?: number
  totalTokens?: number
  totalDurationMs?: number
  usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly reasoningTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheCreationTokens?: number
  }
}

/** Inputs the runner already holds by the time the child run settles. */
export interface SubagentObsProjectionInput {
  /** Model turns the child took (`AgentOutcome.turns`) — aliased to frameCount. */
  readonly turns: number
  /** The child's resolved model id (`resolveChildLlm(...).model`). Empty/absent
   *  ⇒ not unioned into `modelsUsed`. */
  readonly resolvedModel: string | undefined
  /** The owned-worktree branch (`withWorktree` run info), when the child ran
   *  isolated. Absent ⇒ `worktreeBranch` omitted. */
  readonly worktreeBranch: string | undefined
  /** Wall-clock ms the runner measured around the child run. */
  readonly durationMs: number
  /** The tap accumulator folded over the child run's events. */
  readonly acc: SubagentObsAccumulator
}

/**
 * Build the additive projection from what the runner observed. PURE: no I/O, no
 * clock. Union order for `modelsUsed`: the resolved model first (the model the
 * child STARTED on), then any route-transition models in observed order — so a
 * no-transition run yields exactly `[resolvedModel]`.
 */
export const projectSubagentObs = (input: SubagentObsProjectionInput): SubagentObsProjection => {
  const { turns, resolvedModel, worktreeBranch, durationMs, acc } = input

  const modelSet = new Set<string>()
  if (resolvedModel !== undefined && resolvedModel.length > 0) modelSet.add(resolvedModel)
  for (const m of acc.models) modelSet.add(m)
  const modelsUsed = [...modelSet]

  const usage =
    acc.sawUsage === true
      ? {
          inputTokens: acc.inputTokens,
          outputTokens: acc.outputTokens,
          ...(acc.reasoningTokens > 0 ? { reasoningTokens: acc.reasoningTokens } : {}),
          ...(acc.cacheReadTokens > 0 ? { cacheReadTokens: acc.cacheReadTokens } : {}),
          ...(acc.cacheCreationTokens > 0 ? { cacheCreationTokens: acc.cacheCreationTokens } : {}),
        }
      : undefined

  return {
    // frameCount is a pure alias for turns — always projectable.
    frameCount: turns,
    ...(modelsUsed.length > 0 ? { modelsUsed } : {}),
    ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
    ...(acc.toolCalls > 0 ? { totalToolUseCount: acc.toolCalls } : {}),
    ...(acc.sawUsage === true ? { totalTokens: acc.inputTokens + acc.outputTokens } : {}),
    // durationMs is measured unconditionally around every real run.
    totalDurationMs: durationMs,
    ...(usage !== undefined ? { usage } : {}),
  }
}
