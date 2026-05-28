/**
 * Effort classifier types (ADR-0417, absorption gap A1).
 *
 * A SESSION-scoped advisory that watches user prompts (for "think harder"
 * style keywords) and tool-failure accumulation, and surfaces a recommended
 * {@link EffortLevel}. The recommendation is purely ADVISORY — a future
 * consumer (loop / prompt-pipeline, wired in a later wave) may fold it into
 * the per-turn effort resolution, but this slice never mutates effort itself.
 *
 * Slice discipline (RFC §1.2 + biome boundaries):
 *   - Pure leaf. Imports ONLY `EffortLevel` from `./effort` (sibling pure leaf)
 *     so the tier vocabulary is single-sourced. No `@/llm`, no loop, no tool.
 *   - NO-THROW at the port boundary: every method swallows malformed input and
 *     returns an empty signal list rather than throwing into a caller's turn.
 */

import type { EffortLevel } from "../effort"

export type { EffortLevel } from "../effort"

/**
 * A single escalation observation. Two closed variants:
 *   - `keyword` — a user-prompt keyword rule matched (the literal that matched
 *     is carried for transparency/telemetry).
 *   - `tool_failure_accumulation` — a single tool's cumulative failure count
 *     reached the configured threshold this session.
 */
export type EscalationSignal =
  | { kind: "keyword"; matched: string; suggestedLevel: EffortLevel }
  | {
      kind: "tool_failure_accumulation"
      tool: string
      failureCount: number
      suggestedLevel: EffortLevel
    }

/**
 * The current rolled-up recommendation. `level` is the highest-intensity tier
 * voted by any signal seen this session (highest-wins, never downgrades);
 * `signals` is the accumulated evidence; `reason` is a short human string for
 * surfacing in telemetry / a status line.
 */
export interface EffortRecommendation {
  readonly level: EffortLevel
  readonly signals: readonly EscalationSignal[]
  readonly reason: string
}

/**
 * Session-scoped effort classifier port. Constructed once per session; the
 * (future) consumer feeds it `onUserPrompt` / `onToolFailure` and reads
 * `currentRecommendation()` per turn. `reset()` clears all accumulated state
 * (e.g. on a fork / compaction boundary where prior signals no longer apply).
 */
export interface EffortClassifierPort {
  /** Scan one user prompt for keyword escalations; returns the signals that
   *  matched THIS prompt (also folded into the running recommendation). */
  onUserPrompt(text: string): readonly EscalationSignal[]
  /** Record one failure for the named tool; returns a signal IFF this failure
   *  pushed that tool's cumulative count to/over the threshold. */
  onToolFailure(toolName: string): readonly EscalationSignal[]
  /** The rolled-up recommendation across every signal seen this session. */
  currentRecommendation(): EffortRecommendation
  /** Clear all accumulated keyword + failure state. */
  reset(): void
}

/** One keyword → tier rule. `pattern` is tested against the raw prompt text. */
export interface KeywordRule {
  readonly pattern: RegExp
  readonly level: EffortLevel
}

export interface EffortClassifierOptions {
  /** Replaces the default keyword rule set entirely when provided. */
  readonly keywordRules?: readonly KeywordRule[]
  /** Cumulative per-tool failure count that fires a signal. Default 3. */
  readonly failureThreshold?: number
  /** Tier voted by a failure-accumulation signal. Default "high". */
  readonly failureLevel?: EffortLevel
}
