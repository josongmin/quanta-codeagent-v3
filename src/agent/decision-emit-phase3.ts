/**
 * ADR-0269 (Phase 3 of ADR-0239 / follow-up to ADR-0267) — `decision` event
 * emit helpers for the THREE remaining gate sites that the Phase 2 wire-up
 * in `admissibility-gate.ts` did not cover:
 *
 *   - kind:"cap"     — `CapEnforcer.check` returns a non-undefined reminder
 *                      string (ADR-0062 ignored-hint signal). Emitted from
 *                      the dispatch chokepoint at the `tool_progress` site.
 *   - kind:"jail"    — `enforceJail` rejects a path that escapes the
 *                      workspace. Emitted from `@/storage/service.ts` via a
 *                      module-level sink (see `setFsJailDecisionSink`).
 *   - kind:"budget"  — `BudgetMeter.checkExhausted()` returns exhausted=true
 *                      at the per-turn epilogue. Emitted from `loop.ts`.
 *
 * Why a SEPARATE helper module (not `admissibility-gate.ts`):
 *   - The Phase 2 emit helper lives INSIDE the admissibility gate because
 *     it consumes `AdmissibilityGateConfig` and runs as part of the gate
 *     call graph (rule/hook/permission).  The Phase 3 sites are NOT in
 *     the gate's call graph: cap fires AFTER the gate (in dispatch), jail
 *     fires INSIDE the storage layer (free-function chokepoint), budget
 *     fires AT the loop epilogue.  Putting their helpers in a separate
 *     leaf keeps each gate's emit logic close to its consumer site, and
 *     leaves `admissibility-gate.ts` untouched (Phase 2 byte-identical).
 *
 * Default-OFF: every helper accepts `emitter: DecisionEmitter | undefined`;
 * an undefined emitter is a no-op with zero allocation.  Throws from the
 * emitter are swallowed by `safeEmitDecision` — the gate's deny/allow
 * decision is authoritative, the emit channel is best-effort.
 *
 * Sanitisation contract (mirrors ADR-0267 §helper docs):
 *   - `reason` is a short human-readable one-liner with categorical info
 *     only (tool name, cap dimension, dial value, ratio). NEVER tool input
 *     bodies, env values, or file contents.
 *   - `metadata` carries kind-specific safe extras:
 *       cap     → `{ tool }`            (tool name is safe — it's already
 *                                        public in the registry surface)
 *       jail    → `{ path }`            (path is the OFFENDING absolute
 *                                        path; per ADR-0269 §3 it is OK to
 *                                        surface — the user supplied it,
 *                                        AND a jail-deny means the path
 *                                        was REJECTED so its contents are
 *                                        not exposed by this event)
 *       budget  → `{ kind, used, limit }` (numerical observation + the
 *                                          dial dimension — all categorical)
 *   - No emit site ever spreads `action.input` or `call.input` into
 *     `metadata`.
 */

import type { DecisionEmitter, DecisionEvent } from "@/stream"
import { safeEmitDecision } from "@/stream"
import type { BudgetExhaustion } from "./budget"

/** Build + emit a `kind:"cap"` decision when a {@link CapEnforcer.check}
 *  returns a non-undefined reminder. Caller invokes ONLY on the reminder-
 *  fire path (the allow path stays silent — see ADR-0269 §"allow silence").
 *
 *  `reason` is the categorical phrasing the caller passes in (the
 *  enforcer's `buildReminder` output is too verbose for the decision row;
 *  the helper composes a shorter line keyed on the reminder's first
 *  sentence). Callers MUST NOT pass the raw `action.input`.
 */
export const emitCapReminderDecision = (
  emitter: DecisionEmitter | undefined,
  args: {
    readonly tool: string
    readonly toolCallId: string
    readonly reminder: string
    readonly turn: number
  },
): void => {
  if (emitter === undefined) return
  // Compress the reminder body to a single short reason: keep the first
  // sentence (everything up to the first ";") so the decision row stays
  // grep-friendly without leaking the longer ADR-0062 rationale.
  const firstSentence = args.reminder.split(";")[0]?.trim() ?? args.reminder
  const event: DecisionEvent = {
    type: "decision",
    turn: args.turn,
    kind: "cap",
    outcome: "deny",
    reason: `cap reminder: ${firstSentence}`,
    toolCallId: args.toolCallId,
    metadata: { tool: args.tool },
  }
  safeEmitDecision(emitter, event)
}

/** Build + emit a `kind:"budget"` decision when {@link BudgetMeter.checkExhausted}
 *  returns `exhausted=true`. Caller invokes ONLY on the exhausted path
 *  (the allow path stays silent). `BudgetExhaustion.kind/budget/observed`
 *  are guaranteed present whenever `exhausted=true` per the meter's
 *  propositional contract — defensively fall back to empty/0 if the meter
 *  ever returns `exhausted=true` without them (defence-in-depth). */
export const emitBudgetExhaustedDecision = (
  emitter: DecisionEmitter | undefined,
  ex: BudgetExhaustion,
  args: { readonly turn: number },
): void => {
  if (emitter === undefined) return
  if (!ex.exhausted) return
  const kind = ex.kind ?? "unknown"
  const used = ex.observed ?? 0
  const limit = ex.budget ?? 0
  const event: DecisionEvent = {
    type: "decision",
    turn: args.turn,
    kind: "budget",
    outcome: "deny",
    reason: `budget exhausted: ${kind} used=${used} limit=${limit}`,
    metadata: { kind, used, limit },
  }
  safeEmitDecision(emitter, event)
}

/** Build the `kind:"jail"` event payload. Exported so the storage layer
 *  (which owns the module-level sink) can construct the same event shape
 *  without re-importing safeEmitDecision indirection. The actual emission
 *  happens inside `service.ts#enforceJail` via the registered sink — that
 *  is the chokepoint every read/write/edit tool hits.
 *
 *  `path` is the canonicalized OFFENDING absolute path. The user supplied
 *  it (so disclosure is already user-known), AND the path was REJECTED so
 *  this event does NOT expose the file's contents. Reason is categorical:
 *  "path outside workspace" with a short tail. */
export const buildJailDecisionEvent = (args: {
  readonly path: string
  readonly root: string
}): DecisionEvent => ({
  type: "decision",
  turn: 0,
  kind: "jail",
  outcome: "deny",
  reason: `path outside workspace: ${args.path}`,
  metadata: { path: args.path, root: args.root },
})
