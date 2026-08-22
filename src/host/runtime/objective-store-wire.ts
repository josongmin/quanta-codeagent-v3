/**
 * ADR-0394 / RFC-06 A4.3 — objective-store composition wire (extracted from
 * `agent-config-assembler.ts` to keep that aggregator under the god-module line
 * cap; behavior byte-identical to the inlined `maybeWireObjective`).
 *
 * Wires the in-memory `ObjectivePort` that backs the `objective_*` LLM tools AND
 * the loop's derived-status consumers (`objectiveBudgetExhausted`,
 * `markObjectiveUsageLimitedFrom429`). The store's `enforceBudget` is resolved
 * from the SAME `QUANTA_OBJECTIVE_BUDGET_ENFORCE` gate those consumers read, so
 * the derived `usage_limited` / `budget_limited` states can actually surface in
 * prod when the operator opts in. Default-OFF ⇒ informational store ⇒
 * byte-identical.
 */

import type { AgentConfig } from "@/agent"
import type { ObjectivePort } from "@/objective"
import { buildObjectiveAuthority } from "@/runner/assemble/session-authorities"
import { gateOn } from "@/shared"

/** Minimal env view — same record shape the assembler threads everywhere. */
type Env = Record<string, string | undefined>

/**
 * Opt-in objective-store wire. No-op unless `QUANTA_OBJECTIVE_TOOLS` is on
 * (shared assembler — bench/eval + web-daemon must stay byte-identical unless
 * they opt in; the CLI host seeds the gate). Caller-override-precedence
 * (ADR-0332): a pre-set slot is preserved.
 */
export const maybeWireObjective = (cfg: AgentConfig, env: Env): void => {
  if (!gateOn(env, "QUANTA_OBJECTIVE_TOOLS")) return
  const slot = cfg as AgentConfig & { objective?: ObjectivePort }
  if (slot.objective !== undefined) return
  // enforceBudget rides `QUANTA_OBJECTIVE_BUDGET_ENFORCE`: OFF ⇒ the store never
  // derives usage_limited/budget_limited (byte-identical informational store).
  const enforceBudget = gateOn(env, "QUANTA_OBJECTIVE_BUDGET_ENFORCE")
  // RFC-03 C3 — `QUANTA_PROPOSE_GOAL` posture. ON ⇒ the authority gates every
  // model-originated set/replace/completion behind an admitted approval receipt
  // (the objective tool adapter awaits the existing `onConfirm` port between
  // `prepare` and `commit`; no store lock is held across that wait). OFF (the
  // default) ⇒ `gateOn` absent ⇒ byte-identical legacy (model mutations commit
  // without approval). `confirmationAvailable` is fail-closed: under the gate a
  // surface with NO confirm authority (`cfg.onConfirm` absent) refuses activation
  // (`approval-unavailable`), NEVER an approval bypass. `onConfirm` is a surface
  // capability the composition sets before the objective tools execute; when it
  // is not yet present the authority stays fail-closed and the tool adapter's own
  // `ctx.requestObjectiveApproval` presence check backstops it at execute time.
  const gateProposal = gateOn(env, "QUANTA_PROPOSE_GOAL")
  // RFC-03 C2 — construct through the ONE objective-authority builder (assembly
  // owns lifetime/restore), never a surface-local `createObjectiveStore()`.
  slot.objective = buildObjectiveAuthority({
    ...(enforceBudget ? { enforceBudget: true } : {}),
    ...(gateProposal ? { gateOn: true, confirmationAvailable: cfg.onConfirm !== undefined } : {}),
  })
}
