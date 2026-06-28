/**
 * Budget slice — pure types (RFC may-22-unified-agent-runtime / Phase 1).
 *
 * `BudgetDials` declare the *requested* per-run quantitative ceilings; the
 * meter compares observed counts against them propositionally
 * (`dial !== undefined && observed > dial`). All fields are OPTIONAL — when a
 * dial is omitted, that dimension is uncapped (i.e. the corresponding
 * exhaustion check is skipped). There are NO numerical literals in this file:
 * downstream code only ever reads the user-supplied values.
 *
 * `BudgetCaps` is the same shape (subset by construction) and represents the
 * MAXIMUM a given run-mode preset will permit. `clampDials(dials, caps)` is
 * the propositional intersection, NOT a heuristic — see `../run-mode/clamp.ts`.
 *
 * `BudgetExhaustionPolicy` is a closed literal union — surfaces / loop choose
 * one of four well-typed verbs when a dial fires.
 */

/**
 * All quantitative dials a budget meter can track. Every field is optional;
 * an absent field means "no cap on this dimension".
 */
export interface BudgetDials {
  /** Max conversational turns (loop iterations). */
  maxTurns?: number
  /** Max wall-clock duration in milliseconds. */
  maxWallClockMs?: number
  /** Max model-stream calls (one per turn typically; SAME-TURN retries count). */
  maxModelCalls?: number
  /** Max tool dispatches across the entire run. */
  maxToolCalls?: number
  /** Max bash/shell dispatches (subset of tool calls). */
  maxShellCommands?: number
  /** Max test-runner invocations (subset of tool calls). */
  maxTestRuns?: number
  /** Cumulative input tokens consumed. */
  maxInputTokens?: number
  /** Cumulative output tokens emitted. */
  maxOutputTokens?: number
  /** Cumulative reasoning/thinking tokens (provider-reported). */
  maxReasoningTokens?: number
  /** Cumulative tokens (in + out + reasoning). */
  maxTotalTokens?: number
  /** Estimated dollar cost ceiling. */
  maxCostUsd?: number
  /** Files-changed ceiling (e.g. via write/edit/patch). */
  maxFilesChanged?: number
  /** Cumulative patch payload size in bytes. */
  maxPatchBytes?: number
  /** Same-turn LLM retries (backoff path). */
  maxRetries?: number
  /** Consecutive failed tool dispatches before tripping. */
  maxConsecutiveFailures?: number
  /** Compaction trigger token threshold (advisory; surfaced for consumers). */
  compactionTokenThreshold?: number
}

/**
 * Per-mode caps — same shape as `BudgetDials`, represents the upper bound a
 * mode preset is willing to grant.
 */
export type BudgetCaps = BudgetDials

/**
 * Closed verb set the loop / surface chooses when a dial fires.
 *  - `ask-user`            — only legal in interactive mode; pauses for HITL
 *  - `stop`                — finish the run with `budget_exhausted` reason
 *  - `stop-with-summary`   — finish with a closeout summary
 *  - `emit-partial`        — emit whatever partial output is available
 *  - `fail-run`            — outcome.reason becomes `"error"`
 */
export type BudgetExhaustionPolicy =
  | "ask-user"
  | "stop"
  | "stop-with-summary"
  | "emit-partial"
  | "fail-run"

/**
 * Dimensions a caller can `tick(kind, n?)`. Closed string union so the meter's
 * internal counter map is exhaustively typed; an unknown kind is a type error.
 */
export type TickKind =
  | "turn"
  | "model_call"
  | "tool_call"
  | "shell_command"
  | "test_run"
  | "input_tokens"
  | "output_tokens"
  | "reasoning_tokens"
  | "files_changed"
  | "patch_bytes"
  | "retry"
  | "consecutive_failure"
  // Model-aware USD cost, accumulated per provider-usage event. UNLIKE the
  // token dims (raw counts), `cost_usd` is a fractional dollar amount the
  // CALLER computes from the pricing SSOT (`@/observability` `costUsd`) using
  // the per-event `ev.model` — the meter holds NO price table (RFC may-22:
  // "the meter never embeds a price table"). One tick per terminal `usage`
  // event, same delta semantics as the token ticks.
  | "cost_usd"

/** Snapshot of every counter — used for trajectory recording and tests. */
export interface BudgetUsage {
  turns: number
  modelCalls: number
  toolCalls: number
  shellCommands: number
  testRuns: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  filesChanged: number
  patchBytes: number
  retries: number
  consecutiveFailures: number
  wallClockMs: number
  costUsd: number
}

/** Result of `BudgetMeter.checkExhausted()` — propositional, never heuristic. */
export interface BudgetExhaustion {
  /** True if ANY dial is set AND observed value exceeds it. */
  exhausted: boolean
  /** The first dimension that tripped (deterministic check order). */
  kind?: TickKind | "wall_clock_ms" | "cost_usd" | "total_tokens"
  /** The configured budget that was exceeded. */
  budget?: number
  /** The observed value at the time of check. */
  observed?: number
}
