/**
 * Compare-tier agent adapter contract. Each competing agent has ONE file
 * implementing `AgentAdapter`; the runner sees only this surface.
 *
 * Adapter must be deterministic about availability — `available()` is called
 * BEFORE `runOne` so the runner can record `skipped` without spawning. Errors
 * inside `runOne` are surfaced as `{ exitOk: false, failureReason }` rather
 * than thrown (the orchestrator never catches inside the loop body).
 */
import type { Scenario } from "../synthetic/scenario"

export interface CompareRunResult {
  /** Adapter id, copied from the adapter (`adapter.name`). */
  agent: string
  /** Full assistant text the judge will read. May include intermediate
   *  thinking / status lines for CLI agents — that's fine, the judge sees
   *  the whole transcript. */
  transcript: string
  /** Tool calls observed (names only). Empty list for opaque CLI agents. */
  toolsUsed: readonly string[]
  /** Wall-clock ms. */
  durationMs: number
  /** True when the adapter believes the run finished without infrastructure
   *  failure. A run that completes but produces bad output is still `true`
   *  here — the judge decides quality. */
  exitOk: boolean
  /** Set on infrastructure failure (CLI missing, non-zero exit, timeout). */
  failureReason?: string
}

export interface AgentAdapter {
  /** Stable id (e.g. `"quanta"`, `"claude-code"`, `"cursor"`, `"aider"`). */
  readonly name: string
  /** Resolves whether this adapter can run on the current host. CLI adapters
   *  probe for the binary; the in-process Quanta adapter always returns true
   *  when its LLMPort is configured. */
  available(): Promise<{ ok: boolean; reason?: string }>
  /** Execute the scenario end-to-end. MUST NOT throw — return `exitOk:false`
   *  with `failureReason` instead. */
  runOne(scenario: Scenario): Promise<CompareRunResult>
}
