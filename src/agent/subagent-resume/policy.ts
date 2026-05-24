/**
 * Resume-policy port + 3 stock policies (ADR-0159 Phase 2 — work-resume).
 *
 * The {@link ResumePolicy} port is what `resumeInterruptedHandles` consults
 * per interrupted handle. Centralized so the decision logic is auditable +
 * testable + swappable; the orchestrator stays pure mechanics.
 *
 * Plane-clean: imports ONLY `@/agent/subagent-persistence-store` (for the
 * `PersistedHandle` type). NO `@/agent/loop`, `@/agent/dispatch`, `@/llm`,
 * `@/permission`, `@/tool`.
 *
 * Idempotency-gating rationale: AUTO-RESUMING any interrupted work is
 * dangerous — the original interruption may have been caused by the work
 * itself (looping tool, OOM, deliberate kill). The conservative default
 * therefore requires the spec author to explicitly DECLARE the work safe to
 * replay via `spec.metadata.idempotent === "true"`. Without that opt-in,
 * defaultResumePolicy returns "skip" so the user inspects + decides
 * manually. See ADR-0159 §"Alternatives rejected → Auto-resume all".
 */

import type { PersistedHandle } from "@/agent/subagent-persistence-store"

/** Resume decision per interrupted handle. Caller-pluggable so policy is
 *  centralized + auditable + testable. */
export type ResumeDecision =
  | { readonly action: "resume"; readonly reason: string }
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "mark-failed"; readonly reason: string }
  | { readonly action: "ask-user"; readonly promptHint: string }

export interface ResumePolicy {
  /** Decide what to do with each interrupted handle. Called once per handle
   *  at orchestrator entry. Pure function — must not perform I/O. */
  decide(handle: PersistedHandle): ResumeDecision
}

/** Tunables for {@link defaultResumePolicy}. All fields optional; reasonable
 *  conservative defaults applied when absent. */
export interface DefaultResumePolicyOpts {
  /** Max age in ms for a handle to still be considered resumable. Older →
   *  `"mark-failed"` (probably stale). Default 24h = 86_400_000. */
  readonly maxAgeMs?: number
  /** Ratio of `turns / spec.maxTurns` at or above which we treat the handle
   *  as "likely was in a loop" and mark-failed instead of resuming. Default
   *  0.8 (= 80%). Only applies when `spec.maxTurns` is set. */
  readonly staleTurnsRatio?: number
  /** Injected clock. Default `Date.now`. */
  readonly now?: () => number
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h
const DEFAULT_STALE_TURNS_RATIO = 0.8

/** Default conservative policy:
 *   - `spec.metadata.idempotent === "true"` → `"resume"` (caller opted in).
 *     This wins over staleness/age — once the spec author declares the work
 *     idempotent, replaying is safe by definition.
 *   - `now - startedAt > maxAgeMs` → `"mark-failed"` (likely stale).
 *   - `spec.maxTurns` set AND `turns / maxTurns >= staleTurnsRatio` →
 *     `"mark-failed"` (likely looped — interruption probably saved us).
 *   - Else → `"skip"` (user inspects + decides via separate API).
 *
 *  The 4 arms cover the meaningful decision surface without forcing every
 *  caller to write the same boilerplate. */
export const defaultResumePolicy = (opts: DefaultResumePolicyOpts = {}): ResumePolicy => {
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
  const staleTurnsRatio = Math.max(0, opts.staleTurnsRatio ?? DEFAULT_STALE_TURNS_RATIO)
  const now = opts.now ?? Date.now
  return {
    decide(handle): ResumeDecision {
      // 1) Idempotent opt-in wins over staleness checks — caller knows best.
      const idempotent = handle.spec.metadata?.idempotent === "true"
      if (idempotent) {
        return { action: "resume", reason: "spec.metadata.idempotent === 'true'" }
      }
      // 2) Staleness by age.
      const age = now() - handle.startedAt
      if (age > maxAgeMs) {
        return {
          action: "mark-failed",
          reason: `interrupted handle is stale (age ${age}ms > maxAgeMs ${maxAgeMs}ms)`,
        }
      }
      // 3) Staleness by turn budget — only if spec.maxTurns is set.
      const maxTurns = handle.spec.maxTurns
      if (maxTurns !== undefined && maxTurns > 0) {
        const ratio = handle.turns / maxTurns
        if (ratio >= staleTurnsRatio) {
          return {
            action: "mark-failed",
            reason: `interrupted handle consumed ${handle.turns}/${maxTurns} turns (>= ${staleTurnsRatio} ratio); likely looped`,
          }
        }
      }
      // 4) Default — leave for user inspection.
      return {
        action: "skip",
        reason: "no idempotent marker; under staleness thresholds — user must decide",
      }
    },
  }
}

/** Aggressive policy — always returns `"resume"`. For tests + power users who
 *  understand the risk. Use with extreme care: ANY interruption (including
 *  ones caused by the work itself) becomes a re-fork. */
export const alwaysResumePolicy: ResumePolicy = {
  decide(_handle): ResumeDecision {
    return { action: "resume", reason: "alwaysResumePolicy: unconditional resume" }
  },
}

/** Most-conservative policy — always returns `"ask-user"`. The orchestrator
 *  takes no action; the caller's UI surfaces the prompt. The `promptHint`
 *  carries enough spec detail to render a meaningful confirmation prompt. */
export const askUserResumePolicy: ResumePolicy = {
  decide(handle): ResumeDecision {
    const taskHead =
      handle.spec.task.length > 80 ? `${handle.spec.task.slice(0, 79)}…` : handle.spec.task
    const promptHint = `Resume interrupted subagent ${handle.id}? task="${taskHead}" turns=${handle.turns} startedAt=${handle.startedAt}`
    return { action: "ask-user", promptHint }
  },
}
