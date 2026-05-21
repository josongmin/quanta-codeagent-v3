/**
 * ADR-0068 Wave A — Phase 1 per-thread distillation orchestrator.
 *
 * `runPhase1` takes a {@link Phase1Input} assembled from a just-finished
 * session, a {@link Phase1Port} (LLM call wrapper), and a
 * {@link Stage1StorePort} (SQLite upsert sink), and returns a
 * discriminated {@link Phase1Outcome}.
 *
 * Determinism contract:
 *   - Skip-condition order is fixed and verified by tests; renumbering
 *     is observable. The 4 reasons are exhaustive — every non-distill
 *     branch hits exactly one.
 *   - `input.now()` is the only clock; injected so tests can pin
 *     `sourceUpdatedAt` and `durationMs`.
 *   - `port.distill` throws → wrapped in {@link Phase1DistillError} and
 *     re-thrown; never swallowed, never null-returned.
 *   - `store.upsert` throws → propagated as-is; the store layer surfaces
 *     SQLite errors with its own context.
 */
import { MIN_TURN_THRESHOLD } from "./constants"
import {
  Phase1DistillError,
  type Phase1Input,
  type Phase1Outcome,
  type Phase1Port,
  type Stage1Output,
  type Stage1StorePort,
} from "./types"

export const runPhase1 = async (
  input: Phase1Input,
  port: Phase1Port,
  store: Stage1StorePort,
): Promise<Phase1Outcome> => {
  // ── Skip conditions (deterministic order; tests assert each branch) ──
  //
  // 1. thread_id empty — PRIMARY KEY violation would explode in the
  //    store; surface a structured skip instead of a sqlite throw.
  if (input.threadId === "") {
    return { kind: "skipped", reason: "thread_id_empty" }
  }
  // 2. memory_mode disabled — Phase 1 is opt-in (DEFAULT_MEMORY_MODE).
  //    Cheapest skip; saves an LLM call when the feature is off.
  if (input.memoryMode !== "enabled") {
    return { kind: "skipped", reason: "memory_mode_disabled" }
  }
  // 3. no messages — rollout is empty (sessions that never made a real
  //    turn); LLM has nothing to distill.
  if (input.rolloutMessages.length === 0) {
    return { kind: "skipped", reason: "no_messages" }
  }
  // 4. turns below threshold — short conversations are LLM-call cost
  //    without distillable signal (Codex parity, MIN_TURN_THRESHOLD).
  if (input.turnCount < MIN_TURN_THRESHOLD) {
    return { kind: "skipped", reason: "turns_below_threshold" }
  }

  // ── Distill path ────────────────────────────────────────────────────
  const startedAt = input.now()

  // `port.distill` is the LLM-backed seam. We catch only to wrap the
  // failure in a named error carrying `threadId`; the original cause is
  // chained via `Error.cause` so operators retain the stack.
  let distilled: Awaited<ReturnType<Phase1Port["distill"]>>
  try {
    distilled = await port.distill({ rolloutMessages: input.rolloutMessages })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const wrapped = new Phase1DistillError(message, input.threadId)
    if (e instanceof Error) {
      // Preserve original stack for triage. Set via property so we don't
      // change the constructor signature in types.ts.
      ;(wrapped as Error & { cause?: unknown }).cause = e
    }
    throw wrapped
  }

  const sourceUpdatedAt = input.now()
  const stage1: Stage1Output = {
    threadId: input.threadId,
    // Slug is derived deterministically from sessionId — Codex stores a
    // human slug; we fall back to sessionId verbatim so the row is
    // queryable without a separate name table. (Wave D may compute a
    // `${YYYYMMDD-HHMMSS}-${title}` slug; this slot accepts any
    // non-empty string per Stage1Output JSDoc.)
    rolloutSlug: input.sessionId,
    rolloutSummary: distilled.rolloutSummary,
    rawMemory: distilled.rawMemory,
    preferenceSignals: distilled.preferenceSignals,
    sourceUpdatedAt,
    // Phase 1 marks the row as a Phase 2 candidate; Phase 2 clears the
    // flag after consolidating (Wave B).
    selectedForPhase2: true,
    selectedForPhase2SourceUpdatedAt: sourceUpdatedAt,
    // Phase 2 has not seen this row yet.
    lastUsage: null,
    usageCount: 0,
  }

  // `store.upsert` throws → propagate. Caller (Wave D session-end hook)
  // emits an OTel span around `runPhase1` and records the exception via
  // MEMORY_PHASE1_OUTCOME_KEY = "error" attribute.
  await store.upsert(stage1)

  return {
    kind: "distilled",
    stage1,
    durationMs: input.now() - startedAt,
  }
}
