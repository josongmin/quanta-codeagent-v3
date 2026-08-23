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
import {
  buildObjectiveAuthority,
  encodeObjectiveSnapshot,
} from "@/runner/assemble/session-authorities"
import type { PersistedObjectiveSnapshot } from "@/session"
import { gateOn } from "@/shared"

/** Minimal env view — same record shape the assembler threads everywhere. */
type Env = Record<string, string | undefined>

/**
 * RFC-03 H1 — resolve THE ONE gated objective authority for a surface, reading
 * the SAME three gates every objective consumer honors:
 *
 *   - `QUANTA_OBJECTIVE_TOOLS` OFF ⇒ `undefined` (NO authority ⇒ `config.objective`
 *     stays unset ⇒ `buildObjectiveBlock` composes NO `objective_*` tools; the
 *     `objective_set` tool-surface SSOT default is `cli: "opt-in"`). This is the
 *     strict opt-in the manifest promises.
 *   - `QUANTA_PROPOSE_GOAL` ⇒ `gateOn`: ON ⇒ every model-originated
 *     set/replace/completion is mediated (an admitted approval receipt is
 *     required; the objective tool adapter awaits the confirm port BETWEEN
 *     `prepare` and `commit`, no store lock across the wait). OFF ⇒ byte-identical
 *     legacy (model mutations commit without approval).
 *   - `confirmationAvailable` — the SURFACE's static confirm capability. Under the
 *     gate a surface that CANNOT raise an approval dialog is FAIL-CLOSED
 *     (`approval-unavailable` ⇒ the mutation is refused), NEVER an approval bypass.
 *   - `QUANTA_OBJECTIVE_BUDGET_ENFORCE` ⇒ `enforceBudget`: OFF ⇒ the store never
 *     derives usage_limited/budget_limited (informational store, byte-identical).
 *
 * Unlike {@link maybeWireObjective} (per-turn, `cfg`-mutating, derives
 * `confirmationAvailable` from `cfg.onConfirm`), this RETURNS the value so a
 * surface that owns a SESSION-STABLE instance (the CLI `/goal` core-state; the
 * web-daemon observability wire) can construct it ONCE and hand the SAME object to
 * BOTH `config.objective` (the LLM tools, adopted verbatim by
 * `maybeWireObjective`'s caller-override) AND its own consumers (the CLI slash +
 * idle ticker + status chip; the web objective emitter) — one authority per
 * surface, no split-brain, no per-turn re-mint that would drop the goal.
 */
export const resolveGatedObjectiveAuthority = (
  env: Env,
  opts: {
    readonly confirmationAvailable: boolean
    /** RFC-03 C2 — durable resume: the objective snapshot loaded from the
     *  reopened session's `SavedSession.objective`. When present it is decoded
     *  and restored VERBATIM at construction (ids / revision / provenance
     *  preserved; forged completions fail-closed on decode). Absent ⇒ a fresh
     *  empty authority (byte-identical legacy). */
    readonly restoreFrom?: PersistedObjectiveSnapshot | undefined
  },
): ObjectivePort | undefined => {
  if (!gateOn(env, "QUANTA_OBJECTIVE_TOOLS")) return undefined
  const enforceBudget = gateOn(env, "QUANTA_OBJECTIVE_BUDGET_ENFORCE")
  const gateProposal = gateOn(env, "QUANTA_PROPOSE_GOAL")
  // RFC-03 C2 — construct through the ONE objective-authority builder (assembly
  // owns lifetime/restore), never a surface-local `createObjectiveStore()`. A
  // present `restoreFrom` rebuilds a byte-equivalent authority from the reopened
  // session; absent ⇒ fresh empty (default-OFF byte-identical).
  return buildObjectiveAuthority({
    ...(enforceBudget ? { enforceBudget: true } : {}),
    ...(gateProposal ? { gateOn: true, confirmationAvailable: opts.confirmationAvailable } : {}),
    ...(opts.restoreFrom !== undefined ? { restoreFrom: opts.restoreFrom } : {}),
  })
}

/**
 * RFC-03 C2 — build the LAZY objective-snapshot provider the per-turn save
 * (`persistTurn`) attaches to the durable `SavePayload`. Encodes the live
 * objective authority into its persisted DTO on demand (once per id-mode save),
 * so the goal / criterion-ids / revision / provenance survive a real `--resume`.
 *
 * `objective` is the base's slice-opaque `ObjectivePort` slot (typed `unknown`
 * on `RuntimeBase` so the host layer never value-couples to the domain). ABSENT
 * (no authority ⇒ `QUANTA_OBJECTIVE_TOOLS` off, or a surface with no goal wire)
 * ⇒ `undefined` ⇒ `persistTurn` omits the field ⇒ the store PRESERVES any
 * on-disk snapshot and the write is byte-identical (default-OFF). This is the
 * ONE place the encode adapter is reached on the save path.
 */
export const buildObjectiveSnapshotProvider = (
  objective: unknown,
): (() => PersistedObjectiveSnapshot | undefined) | undefined => {
  if (objective === undefined || objective === null) return undefined
  const port = objective as ObjectivePort
  return () => encodeObjectiveSnapshot(port)
}

/**
 * Opt-in objective-store wire. No-op unless `QUANTA_OBJECTIVE_TOOLS` is on
 * (shared assembler — bench/eval + web-daemon must stay byte-identical unless
 * they opt in; the CLI host seeds the gate). Caller-override-precedence
 * (ADR-0332): a pre-set slot is preserved (regardless of gate — a surface that
 * already threaded its SESSION-STABLE gated authority down on `base.objective`
 * keeps it; the assembler never clobbers a caller value). `confirmationAvailable`
 * is derived from the per-turn `cfg.onConfirm`, which the composition sets before
 * the objective tools execute; when it is absent the authority stays fail-closed
 * and the tool adapter's own `ctx.requestObjectiveApproval` presence check
 * backstops it at execute time.
 */
export const maybeWireObjective = (cfg: AgentConfig, env: Env): void => {
  const slot = cfg as AgentConfig & { objective?: ObjectivePort }
  if (slot.objective !== undefined) return
  const authority = resolveGatedObjectiveAuthority(env, {
    confirmationAvailable: cfg.onConfirm !== undefined,
  })
  if (authority !== undefined) slot.objective = authority
}
