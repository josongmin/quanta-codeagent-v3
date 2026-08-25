/**
 * GOAL-02 — the ONE objective policy: who may issue which mutation, when a
 * mutation is a proposal that needs an admitted approval, what counts as
 * COMPLETION, and which explicit transitions are legal.
 *
 * The authority consults {@link authorizeMutation} after normalization and
 * before commit. Every refusal is a stable typed {@link CommitRejection}; the
 * tool / CLI / web render the code and never re-implement the policy.
 *
 * The table is EXHAUSTIVE over `OBJECTIVE_OPERATION_KINDS × OBJECTIVE_ACTORS`
 * both at the type level (`Record<…>`) and at module load
 * ({@link assertMutationPolicyComplete}) so a new kind or actor cannot ship
 * without a decided cell.
 *
 * SLICE FENCE: pure — imports ONLY sibling modules.
 */

import type { ObjectiveDomainSnapshot, ValidationContract } from "./model"
import {
  OBJECTIVE_ACTORS,
  OBJECTIVE_OPERATION_KINDS,
  type ObjectiveActor,
  type ObjectiveMutation,
  type ObjectiveOperationKind,
} from "./mutations"
import type { CommitRejection, ObjectiveMutationCommand } from "./ports"
import type { Objective, SuccessCriterion } from "./types"

/** `allow` — proceed to CAS; `approval` — proceed only with an admitted
 *  approval receipt (the gated model proposal); `{ deny }` — refuse with the
 *  typed code. */
export type MutationVerdict = "allow" | "approval" | { readonly deny: CommitRejection }

export type MutationPolicyTable = Record<
  ObjectiveOperationKind,
  Record<ObjectiveActor, MutationVerdict>
>

const ACTOR_FORBIDDEN: MutationVerdict = { deny: "actor-forbidden" }
const DEFINITION_FORBIDDEN: MutationVerdict = { deny: "definition-change-forbidden" }
const ATTESTATION_REQUIRED: MutationVerdict = { deny: "manual-attestation-required" }

const row = (
  user: MutationVerdict,
  model: MutationVerdict,
  continuation: MutationVerdict,
  verifier: MutationVerdict,
  system: MutationVerdict,
): Record<ObjectiveActor, MutationVerdict> => ({ user, model, continuation, verifier, system })

/**
 * The actor × mutation table (README §결정 기록 / ticket GOAL-02).
 *
 * | kind                  | user  | model                 | continuation | verifier | system |
 * | create                | allow | approval (gate) *     | deny         | deny     | allow  |
 * | replace/clear/amend   | allow | definition-forbidden  | def-forbid   | def-forb | allow  |
 * | setExplicitStatus     | allow | actor-forbidden       | actor-forb   | actor-fb | allow  |
 * | setNextActions        | allow | allow                 | allow        | actor-fb | allow  |
 * | markCriterion         | allow | attestation-required  | attest-req   | attest   | allow  |
 * | markCriterionVerified | actor | actor-forbidden       | actor-forb   | allow    | actor  |
 * | addBlocker            | allow | allow (pre-GOAL-09)   | allow        | actor-fb | allow  |
 * | clearBlocker          | allow | actor-forbidden       | actor-forb   | actor-fb | allow  |
 * | settle/usageLimit/restore | actor-forbidden …                                  | allow  |
 *
 * (*) `approval` resolves to `actor-forbidden` when the propose gate is OFF —
 * a model may never mint a definition without an admitted operator approval.
 */
export const MUTATION_POLICY: MutationPolicyTable = {
  create: row("allow", "approval", ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, "allow"),
  replace: row("allow", DEFINITION_FORBIDDEN, DEFINITION_FORBIDDEN, DEFINITION_FORBIDDEN, "allow"),
  clear: row("allow", DEFINITION_FORBIDDEN, DEFINITION_FORBIDDEN, DEFINITION_FORBIDDEN, "allow"),
  amendBudget: row(
    "allow",
    DEFINITION_FORBIDDEN,
    DEFINITION_FORBIDDEN,
    DEFINITION_FORBIDDEN,
    "allow",
  ),
  setExplicitStatus: row("allow", ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, "allow"),
  setNextActions: row("allow", "allow", "allow", ACTOR_FORBIDDEN, "allow"),
  markCriterion: row(
    "allow",
    ATTESTATION_REQUIRED,
    ATTESTATION_REQUIRED,
    ATTESTATION_REQUIRED,
    "allow",
  ),
  markCriterionVerified: row(
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    "allow",
    ACTOR_FORBIDDEN,
  ),
  addBlocker: row("allow", "allow", "allow", ACTOR_FORBIDDEN, "allow"),
  clearBlocker: row("allow", ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, "allow"),
  applyVerificationBatch: row(
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    "allow",
    ACTOR_FORBIDDEN,
  ),
  invalidateVerification: row(
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    "allow",
    ACTOR_FORBIDDEN,
  ),
  beginAttempt: row(ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, "allow"),
  abandonAttempt: row("allow", ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, "allow"),
  settleAttempt: row(ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, "allow"),
  markUsageLimited: row(
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    ACTOR_FORBIDDEN,
    "allow",
  ),
  restore: row(ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, ACTOR_FORBIDDEN, "allow"),
}

const isVerdict = (v: unknown): v is MutationVerdict =>
  v === "allow" ||
  v === "approval" ||
  (v !== null && typeof v === "object" && typeof (v as { deny?: unknown }).deny === "string")

/** Runtime drift guard: every kind × actor cell must exist and be a verdict.
 *  Throws (naming the hole) so a partial table can never load. */
export const assertMutationPolicyComplete = (table: MutationPolicyTable): void => {
  for (const kind of OBJECTIVE_OPERATION_KINDS) {
    const cells = (table as Partial<Record<string, Partial<Record<string, unknown>>>>)[kind]
    if (cells === undefined) throw new Error(`objective policy: no row for mutation kind '${kind}'`)
    for (const actor of OBJECTIVE_ACTORS) {
      if (!isVerdict(cells[actor])) {
        throw new Error(`objective policy: no verdict for '${kind}' × '${actor}'`)
      }
    }
  }
}

assertMutationPolicyComplete(MUTATION_POLICY)

// ─────────────────────────────────────────────────────────────────────────────
// Completion contract
// ─────────────────────────────────────────────────────────────────────────────

const TRUSTED_ATTESTORS: ReadonlySet<ObjectiveActor> = new Set<ObjectiveActor>(["user", "system"])

/** One criterion carries TRUSTED completion evidence bound to this generation. */
export const criterionSatisfied = (c: SuccessCriterion, objectiveId: string): boolean => {
  if (!c.met || c.completion === undefined) return false
  if (c.kind === "manual") {
    return (
      c.completion.source === "manual" &&
      c.completion.objectiveId === objectiveId &&
      TRUSTED_ATTESTORS.has(c.completion.actor)
    )
  }
  return (
    c.completion.source === "verifier" &&
    c.completion.objectiveId === objectiveId &&
    c.completion.checkId === c.check.id &&
    c.completion.verifierResult.passed === true
  )
}

/** The deterministic completion projection: at least one criterion, no open
 *  blocker, every criterion satisfied by trusted evidence. */
export const completionSatisfied = (
  o: Pick<Objective, "objectiveId" | "successCriteria" | "blockers">,
): boolean =>
  o.successCriteria.length > 0 &&
  o.blockers.length === 0 &&
  o.successCriteria.every((c) => criterionSatisfied(c, o.objectiveId))

/** What kind of stopping contract the objective declares. */
export const validationContractOf = (o: Pick<Objective, "successCriteria">): ValidationContract => {
  if (o.successCriteria.length === 0) return "missing"
  return o.successCriteria.some((c) => c.kind === "checked") ? "checked" : "manual-only"
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization (table + state transitions)
// ─────────────────────────────────────────────────────────────────────────────

/** Derived states an explicit `active` may not override. */
const NON_RESUMABLE = new Set<Objective["status"]>(["blocked", "budget_limited", "usage_limited"])

const BLOCKER_TARGET_KINDS: ReadonlySet<string> = new Set([
  "approval",
  "external",
  "user-input",
  "tool",
])

const validObservedBlocker = (
  mutation: Extract<ObjectiveMutation, { kind: "addBlocker" }>,
): boolean =>
  typeof mutation.attemptId === "string" &&
  mutation.attemptId.length > 0 &&
  mutation.attemptId.length <= 512 &&
  mutation.target !== undefined &&
  BLOCKER_TARGET_KINDS.has(mutation.target.kind) &&
  mutation.target.ref.trim().length > 0 &&
  mutation.target.ref.length <= 2_000

const transitionRejection = (
  prior: ObjectiveDomainSnapshot,
  mutation: ObjectiveMutation,
): CommitRejection | null => {
  const o = prior.state?.objective
  // Generation preconditions are POLICY (raised before CAS and before any
  // approval prompt): a proposal on a live thread, or a definition change on an
  // empty one, is refused without consulting the operator.
  if (mutation.kind === "create" && o !== undefined) return "objective-exists"
  if ((mutation.kind === "replace" || mutation.kind === "clear") && o === undefined) {
    return "objective-missing"
  }
  // GOAL-04 — a durable started attempt owns the accounting; the definition
  // cannot be replaced/cleared under it (pause/cancel/abandon first).
  if (
    (mutation.kind === "replace" || mutation.kind === "clear") &&
    o?.attempts.started !== undefined
  ) {
    return "attempt-in-flight"
  }
  if (o === undefined) return null
  if (
    mutation.kind === "setExplicitStatus" &&
    mutation.status === "active" &&
    NON_RESUMABLE.has(o.status)
  ) {
    return "invalid-transition"
  }
  return null
}

/**
 * Resolve the policy for a bound command against the prior snapshot.
 * Returns `{ verdict: "allow" }`, `{ verdict: "approval" }` (commit needs an
 * admitted receipt), or `{ verdict: "deny", reason }`.
 */
export const authorizeMutation = (
  prior: ObjectiveDomainSnapshot,
  command: ObjectiveMutationCommand,
  gateOn: boolean,
):
  | { readonly verdict: "allow" | "approval" }
  | { readonly verdict: "deny"; readonly reason: CommitRejection } => {
  const cell = MUTATION_POLICY[command.mutation.kind]?.[command.actor]
  if (cell === undefined) return { verdict: "deny", reason: "invalid" }
  if (typeof cell === "object") return { verdict: "deny", reason: cell.deny }
  // Terminal: a completed objective accepts no model/continuation mutation.
  if (
    (command.actor === "model" || command.actor === "continuation") &&
    prior.state?.objective.status === "completed"
  ) {
    return { verdict: "deny", reason: "terminal-objective" }
  }
  if (
    command.mutation.kind === "addBlocker" &&
    (command.actor === "model" || command.actor === "continuation") &&
    !validObservedBlocker(command.mutation)
  ) {
    return { verdict: "deny", reason: "invalid" }
  }
  const transition = transitionRejection(prior, command.mutation)
  if (transition !== null) return { verdict: "deny", reason: transition }
  if (cell === "approval") {
    return gateOn ? { verdict: "approval" } : { verdict: "deny", reason: "actor-forbidden" }
  }
  return { verdict: "allow" }
}
