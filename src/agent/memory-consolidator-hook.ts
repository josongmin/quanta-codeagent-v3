/**
 * ADR-0068 Wave D — session-end consolidator hook (L4 wire).
 *
 * Pure wiring around `runPhase1`: turns the agent's session-end signal +
 * the host-injected `Phase1Port` / `Stage1StorePort` + the final outcome
 * into a Phase1Input, calls `runPhase1`, and converts the result into
 * either a no-op (skip) OR a non-fatal logged side effect (success / error).
 *
 * Contract:
 *   - NO-THROW: every internal failure (port throw, store throw, missing
 *     port) is caught and surfaced via the injected `log` callback so the
 *     session-finishing path is never derailed by a consolidator bug.
 *   - DEFAULT-OFF: the caller decides whether to invoke this hook at all
 *     (it lives outside `runAgent` so an absent `memoryConsolidator` is
 *     zero allocation).
 *   - FORCE_SUMMARIZATION: SOTA Cursor mirror — when the host sets
 *     `forceSummarization: true`, the consolidator's `memoryMode` is
 *     forced to `"enabled"` regardless of host opt-in, so the per-thread
 *     turn-count cap is the only remaining skip condition.
 */
import type { Message } from "@/llm"
import {
  Phase1DistillError,
  type Phase1Input,
  type Phase1Outcome,
  type Phase1Port,
  runPhase1,
  type Stage1StorePort,
} from "@/memory"
import { errMessage } from "@/shared"

/** Outcome of a session-end consolidator attempt. Mirrors `Phase1Outcome`
 *  shape but adds the structured-skip arms the hook itself can produce
 *  (no port / no store / no thread id / consolidator-disabled). */
export type ConsolidatorHookOutcome =
  | { kind: "distilled"; durationMs: number; threadId: string }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "error"; message: string }

/** Skip reasons surfaced by the hook layer (distinct from Phase1's own
 *  skip reasons which are surfaced verbatim in the same enum). The two
 *  sets are merged at the hook boundary so a consumer sees ONE skip
 *  taxonomy regardless of where the skip fired. */
export type SkipReason =
  | "consolidator_disabled"
  | "session_errored"
  | "port_missing"
  | "store_missing"
  | "thread_id_missing"
  | "memory_mode_disabled"
  | "turns_below_threshold"
  | "no_messages"
  | "thread_id_empty"

/** Inputs the hook reads from the loop. Narrow shape so callers can
 *  unit-test the hook against scripted values without standing up a full
 *  `AgentConfig`. */
export interface ConsolidatorHookInput {
  /** Was the session successful? Hook is no-op when false. */
  readonly sessionOk: boolean
  /** ADR-0068 consolidator opt-in surface (from `AgentConfig.memoryConsolidator`). */
  readonly consolidator:
    | {
        enabled?: boolean
        forceSummarization?: boolean
        port?: Phase1Port
        store?: Stage1StorePort
        threadId?: string
      }
    | undefined
  /** Session id — fallback for `threadId` when consolidator.threadId is unset. */
  readonly sessionId: string | undefined
  /** Final rollout (the loop's `wm.snapshot()` cast to the structural
   *  shape Phase1 expects). */
  readonly rolloutMessages: ReadonlyArray<Message>
  /** Real (non-meta) turn count from the session — drives the
   *  MIN_TURN_THRESHOLD skip arm. */
  readonly turnCount: number
  /** Injected clock — defaults to `Date.now`. */
  readonly now?: () => number
}

/** Non-fatal logger — emit a structured event so the session finishes
 *  cleanly while the operator can still see what happened. The session
 *  is already wrapping up; we MUST NOT throw. */
export type ConsolidatorHookLogger = (event: ConsolidatorHookOutcome) => void

/** Run the consolidator hook. ALL failure paths return an outcome — the
 *  function never throws (its no-throw contract is what lets `runAgent`'s
 *  finally call it without a defensive try/catch). */
export const runMemoryConsolidatorHook = async (
  input: ConsolidatorHookInput,
  log?: ConsolidatorHookLogger,
): Promise<ConsolidatorHookOutcome> => {
  const result = await runMemoryConsolidatorHookInner(input)
  log?.(result)
  return result
}

const runMemoryConsolidatorHookInner = async (
  input: ConsolidatorHookInput,
): Promise<ConsolidatorHookOutcome> => {
  const cfg = input.consolidator
  // Opt-in: consolidator must be configured AND either `enabled` true OR
  // `forceSummarization` true (SOTA Cursor — explicit manual trigger).
  if (cfg === undefined) {
    return { kind: "skipped", reason: "consolidator_disabled" }
  }
  if (cfg.enabled !== true && cfg.forceSummarization !== true) {
    return { kind: "skipped", reason: "consolidator_disabled" }
  }
  // Session-error skip: a session that ended in error should not have
  // its tainted rollout fed to the distill (RolloutTaintedError semantics
  // at the consolidator layer would still catch a malicious payload, but
  // we skip earlier to save the LLM call). `forceSummarization` does NOT
  // override this — a force is intent-to-distill on success, not on a
  // failed run.
  if (!input.sessionOk) {
    return { kind: "skipped", reason: "session_errored" }
  }
  // Required ports/store: absent ⇒ structured skip (no throw). A host
  // that sets `enabled: true` but forgets the port/store learns via the
  // log, the session still finishes cleanly.
  if (cfg.port === undefined) {
    return { kind: "skipped", reason: "port_missing" }
  }
  if (cfg.store === undefined) {
    return { kind: "skipped", reason: "store_missing" }
  }
  const threadId = cfg.threadId ?? input.sessionId
  if (threadId === undefined || threadId.length === 0) {
    return { kind: "skipped", reason: "thread_id_missing" }
  }
  const phase1Input: Phase1Input = {
    threadId,
    sessionId: input.sessionId ?? threadId,
    rolloutMessages: input.rolloutMessages.map((m) => ({ role: m.role, content: m.content })),
    turnCount: input.turnCount,
    // SOTA Cursor `force_summarization` — bypass the host's opt-in by
    // forcing memoryMode=enabled. The MIN_TURN_THRESHOLD cap still
    // applies in the consolidator itself (force does not over-ride the
    // "no signal in tiny conversations" floor).
    memoryMode: cfg.forceSummarization === true || cfg.enabled === true ? "enabled" : "disabled",
    now: input.now ?? Date.now,
  }
  let outcome: Phase1Outcome
  try {
    outcome = await runPhase1(phase1Input, cfg.port, cfg.store)
  } catch (e) {
    if (e instanceof Phase1DistillError) {
      return { kind: "error", message: `Phase1DistillError: ${e.message}` }
    }
    const message = errMessage(e)
    return { kind: "error", message }
  }
  if (outcome.kind === "skipped") {
    return { kind: "skipped", reason: outcome.reason }
  }
  return { kind: "distilled", durationMs: outcome.durationMs, threadId }
}
