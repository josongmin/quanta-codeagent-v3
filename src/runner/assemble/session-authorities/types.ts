/**
 * RFC-01 A2 — session-authority graph contracts (`@/runner/assemble/session-authorities`).
 *
 * `runner/assemble` is the repository's Layer-2 composition seam (blueprint §1):
 * it MAY import across domain slices because it constructs authorities; it holds
 * NO transition logic. This module is the FIRST holder of the shared
 * `session-authorities` owner lock (board §5: A2 -> D4 -> C2 -> E2/E3 -> F1).
 * Later packets ADD authorities (objective/posture/skills/activity) to
 * {@link SessionAuthorities}; A2 introduces only the task/question/attention
 * arms it needs, keeping the OFF-path graph byte-identical to `{ tasks }`.
 */

import type { ActivityStore } from "@/activity"
import type { AttentionAgent } from "@/attention"
import type { UserQuestionBroker, UserQuestionBrokerDeps } from "@/session/user-question"
import type { TaskRegistry } from "@/subagent"

/**
 * Read-only navigation projection over two LIVE authorities (the shared
 * `TaskRegistry` and the `UserQuestionBroker`). It adds NO state: every call
 * derives a fresh `AttentionAgent[]` snapshot from the live authorities and
 * feeds it to A1's PURE `nextNeedingAttention` resolver. Only the `task` arm of
 * a question owner joins the fleet — a `{ kind: "root" }` question is a
 * session-level question, never a subagent row (blueprint §5).
 */
export interface AttentionReader {
  /**
   * Immutable, freshly-derived fleet-attention snapshot: one row per task-owned
   * pending question that joins a live `TaskRecord`. Lineage is NOT pre-filtered
   * here — the pure resolver applies the lineage gate at selection time.
   */
  snapshot(): readonly AttentionAgent[]
  /**
   * The single agent the operator should go to next within `ownRootId`'s
   * lineage, via A1's pure resolver, or `undefined` when nothing in that lineage
   * is awaiting input. `afterRequestId` optionally advances the cursor.
   */
  next(ownRootId: string, afterRequestId?: string): AttentionAgent | undefined
}

/**
 * The per-session authority graph. Carries the ONE session `ActivityStore`
 * (RFC-04 D4 — always minted here, the single production owner all surfaces
 * observe via DI), plus the OPTIONAL shared task registry and the OPTIONAL
 * question/attention authority. The attention arms are present only under the
 * `QUANTA_ATTENTION_NAV` gate AND when a `tasks` registry exists; both ABSENT
 * (undefined) on the default-OFF path so the attention feature stays byte-
 * identical to the pre-attention baseline. `activity` is NOT gated — every
 * session has exactly one store.
 */
export interface SessionAuthorities {
  /** RFC-04 D4 — the ONE session activity store, minted by the authority builder
   *  and threaded to every surface (CLI/stdio/terminal) so all consumers observe
   *  the SAME instance (no command/surface-local `createActivityStore()`). */
  readonly activity: ActivityStore
  /** The shared task registry the graph carries — injected, never re-minted here
   *  (no parallel/duplicate authority). Absent when the surface has no subagent
   *  fleet (one-shot session commands, served/offline sessions). */
  readonly tasks?: TaskRegistry
  /** The pending-question authority; present only when the gate is ON + tasks. */
  readonly questions?: UserQuestionBroker
  /** The live fleet-attention reader; present only when the gate is ON + tasks. */
  readonly attention?: AttentionReader
}

/** Input to {@link buildSessionAuthorities}. */
export interface BuildSessionAuthoritiesInput {
  /** The shared task registry the graph wraps. The caller/composition owns
   *  construction; the builder never mints a parallel registry. Absent for a
   *  surface with no subagent fleet (the attention arms are then omitted). */
  readonly tasks?: TaskRegistry
  /** Environment bag the `QUANTA_ATTENTION_NAV` gate is resolved from. Passed in
   *  by the composition root so this module never reads `process.env` directly
   *  (blueprint §Default-OFF gate: resolved once by composition, threaded in). */
  readonly env: Record<string, string | undefined>
  /** RFC-04 D4 — optional pre-built activity store (tests inject one to observe
   *  the graph's instance). Absent ⇒ the builder mints THE one session store. */
  readonly activity?: ActivityStore
  /** Optional pre-built broker (tests inject one for deterministic id/clock, and
   *  to prove the graph carries the injected instance). When absent and the gate
   *  is ON, one is constructed from {@link questionDeps}. */
  readonly questions?: UserQuestionBroker
  /** Optional broker deps (clock/id factory) used only when the broker is
   *  constructed here. */
  readonly questionDeps?: UserQuestionBrokerDeps
}
