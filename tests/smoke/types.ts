/**
 * Smoke-fixture core types (Phase 1 — single/medium/tikitaka × tier-0 replay).
 *
 * Each scenario is a self-contained folder under `tests/smoke/fixtures/<depth>/<NN-name>/`:
 *
 *   seed/                Files copied into a tmp workspace before the run.
 *   prompts.jsonl        One user message per line. Tikitaka feeds them in order.
 *   trajectory.jsonl     Recorded LLM events for tier-0 replay (one entry per event).
 *                        Missing ⇒ scenario is SKIPPED in tier-0 (politely pending).
 *   expect.json          Declarative assertion spec — see {@link ExpectSpec}.
 *
 * Industry-SOTA assertion shape blends Inspect AI / promptfoo / Braintrust
 * primitives:
 *   - {@link ExpectSpec.toolCalls}     positive + negative + ordering
 *   - {@link ExpectSpec.files}         post-state contains/notContains/absent
 *   - {@link ExpectSpec.finalText}     contains/containsAny/regex/notContains
 *   - {@link ExpectSpec.contextRetention} tikitaka — agent recalls a prior fact
 *   - {@link ExpectSpec.budget}        wall / token budgets (perf regression gate)
 *   - {@link ExpectSpec.judge}         OPTIONAL LLM-as-judge rubric (Phase 2 wire)
 *
 * Replay determinism: a `TrajectoryReplayLLM` yields the events scoped to the
 * current `(run, turn)` bucket. `run` = which user message (0-indexed),
 * `turn` = which LLM call within that user message.
 */

export type Depth = "single" | "medium" | "tikitaka"

export interface ScenarioMeta {
  readonly id: string
  readonly depth: Depth
  readonly dir: string
  readonly tags: readonly string[]
}

export interface TrajectoryEntry {
  /** Which user message this event belongs to (0-indexed). */
  readonly run: number
  /** Which LLM call within that user message (0-indexed). */
  readonly turn: number
  /** A raw `StreamEvent` (see `@/llm`). Kept structural here to avoid a hard
   *  dependency from the smoke types onto the LLM slice — the replay engine
   *  re-asserts shape at consumption time. */
  readonly event: Record<string, unknown>
}

/**
 * Declarative assertion spec. Everything is optional; an absent block is
 * "no opinion". Conventions:
 *  - `required` / `containsAny`: "at least one match".
 *  - `forbidden` / `notContains`: "zero matches" — safety sentinels.
 *  - `count.min` / `count.max`: closed inclusive ranges.
 */
export interface ExpectSpec {
  readonly stopReason?: "completed" | "max_turns" | "aborted" | "error"
  readonly turns?: { readonly count?: { readonly min?: number; readonly max?: number } }
  readonly toolCalls?: ToolCallExpect
  readonly files?: readonly FileExpect[]
  readonly finalText?: TextExpect
  readonly contextRetention?: readonly ContextRetentionExpect[]
  readonly budget?: BudgetExpect
  readonly judge?: JudgeExpect
}

export interface ToolCallExpect {
  /** At least one call to each named tool. */
  readonly required?: readonly string[]
  /** Zero calls to each named tool (safety sentinel). */
  readonly forbidden?: readonly string[]
  /** First N tool calls must match this prefix (order-aware). */
  readonly orderedPrefix?: readonly string[]
  /** Per-tool exact-or-range count constraints. */
  readonly counts?: Readonly<Record<string, { readonly min?: number; readonly max?: number }>>
}

export interface FileExpect {
  readonly path: string
  readonly contains?: readonly string[]
  readonly notContains?: readonly string[]
  /** When true, the file MUST NOT exist after the run. */
  readonly absent?: boolean
  readonly linesAdded?: { readonly min?: number; readonly max?: number }
}

export interface TextExpect {
  readonly contains?: readonly string[]
  readonly containsAny?: readonly string[]
  readonly notContains?: readonly string[]
  readonly regex?: string
}

export interface ContextRetentionExpect {
  /** 0-indexed user-message turn the assistant response is keyed to. */
  readonly inRun: number
  /** Phrases the assistant MUST mention in that run (proves recall). */
  readonly assistantTranscriptContains: readonly string[]
}

export interface BudgetExpect {
  readonly wallSeconds?: { readonly max?: number }
  readonly tokensInput?: { readonly max?: number }
  readonly tokensOutput?: { readonly max?: number }
}

/** LLM-as-judge rubric. Implementation lands in Phase 2; the shape is fixed
 *  here so Phase 1 fixtures can already author judge blocks that get cached. */
export interface JudgeExpect {
  readonly rubric: string
  /** Pass threshold on the judge's 0..1 score. */
  readonly threshold: number
  /** Optional: a recorded judge response (cached for tier-0 determinism). */
  readonly cached?: { readonly score: number; readonly rationale: string }
}

// ---------------------------------------------------------------------------
// Runtime result types
// ---------------------------------------------------------------------------

export interface AssertionFailure {
  readonly path: string
  readonly expected: string
  readonly actual: string
}

export interface ScenarioResult {
  readonly meta: ScenarioMeta
  readonly status: "passed" | "failed" | "skipped"
  readonly skipReason?: string
  readonly failures: readonly AssertionFailure[]
  readonly durationMs: number
  readonly stopReason?: string
  readonly turns?: number
}
