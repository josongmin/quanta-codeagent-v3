/**
 * RFC-03 C2 / GOAL-01 — the SINGLE production objective-authority builder + the
 * persistence ENCODE adapter (v2).
 *
 * This is THE one place production code constructs the per-session objective
 * authority (mirrors RFC-04 D4's `ActivityStore` single-owner pattern). Every
 * surface — host objective wire, CLI core-state, agent observability wire —
 * routes construction through {@link buildObjectiveAuthority} instead of minting
 * its own `createObjectiveStore()` fallback (pinned by the objective
 * constructor-owner ratchet).
 *
 * `runner/assemble` is the Layer-2 composition seam, so it MAY import the
 * `@/objective` domain (construction) AND the `@/session` DTO (persistence). The
 * `@/session` slice itself never imports `@/objective`: it stores/loads only the
 * plain JSON {@link PersistedObjectiveSnapshot}, and the encode/decode ADAPTER
 * lives here.
 *
 * Fixed restore order: session identity → SAVED OBJECTIVE (`restoreFrom`, v1 or
 * v2 — v1 is migrated once in `./restore`) → policy binding → AUTHORITY
 * CONSTRUCTION. Encoding is ALWAYS v2 and includes cleared-thread TOMBSTONES
 * (`objective: null` + revision) so a stale pre-clear command stays fenced after
 * a reopen.
 *
 * exactOptionalPropertyTypes: optional fields are OMITTED when absent.
 */

import {
  asObjectiveAuthority,
  type BlockerDependencyResolverPort,
  createObjectiveAuthority,
  type ObjectiveDomainSnapshot,
  type ObjectiveIdFactory,
  type ObjectiveLifecycleSink,
  type ObjectivePort,
  type SuccessCriterion,
} from "@/objective"
import {
  OBJECTIVE_SNAPSHOT_VERSION,
  type PersistedObjectiveBodyV2,
  type PersistedObjectiveCompletion,
  type PersistedObjectiveCriterion,
  type PersistedObjectiveSnapshot,
  type PersistedObjectiveSnapshotV2,
  type PersistedObjectiveThreadV2,
} from "@/session"
import { decodeObjectiveSnapshot } from "./restore"

/** Inputs to {@link buildObjectiveAuthority}. All optional — the default is a
 *  fresh, gate-OFF, informational authority. */
export interface BuildObjectiveAuthorityInput {
  /** Injected clock seam (default `Date.now`). */
  readonly now?: () => number
  /** GOAL-01 — objective generation id minter (default `crypto.randomUUID`). */
  readonly idFactory?: ObjectiveIdFactory
  /** H17 budget/usage derivation — forwarded from `QUANTA_OBJECTIVE_BUDGET_ENFORCE`
   *  by the surface that owns that gate. */
  readonly enforceBudget?: boolean
  /** RFC-03 `QUANTA_PROPOSE_GOAL` posture (default OFF). */
  readonly gateOn?: boolean
  /** Whether the surface can raise an approval dialog (fail-closed under the
   *  gate when false). */
  readonly confirmationAvailable?: boolean
  /** Host registry authority for model blocker dependency resolution. */
  readonly blockerDependencyResolver?: BlockerDependencyResolverPort
  /** Optional bounded lifecycle sink owned by the composition root. */
  readonly lifecycleSink?: ObjectiveLifecycleSink
  /** RFC-03 C2 — durable resume: a previously persisted objective snapshot (v1
   *  or v2) to restore at construction (ids / revision / provenance preserved).
   *  Absent ⇒ a fresh empty authority. */
  readonly restoreFrom?: PersistedObjectiveSnapshot | undefined
}

/**
 * Construct THE per-session objective authority (typed as `ObjectivePort` — the
 * surface every consumer binds; the richer `ObjectiveAuthority` protocol is
 * recovered via `asObjectiveAuthority`). When `restoreFrom` is supplied, its
 * threads are decoded (migrated when v1) and restored verbatim as part of
 * construction (fixed restore order). This is the one production objective
 * constructor owner.
 */
export const buildObjectiveAuthority = (input: BuildObjectiveAuthorityInput = {}): ObjectivePort =>
  createObjectiveAuthority({
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.idFactory !== undefined ? { idFactory: input.idFactory } : {}),
    ...(input.enforceBudget !== undefined ? { enforceBudget: input.enforceBudget } : {}),
    ...(input.gateOn !== undefined ? { gateOn: input.gateOn } : {}),
    ...(input.confirmationAvailable !== undefined
      ? { confirmationAvailable: input.confirmationAvailable }
      : {}),
    ...(input.blockerDependencyResolver !== undefined
      ? { blockerDependencyResolver: input.blockerDependencyResolver }
      : {}),
    ...(input.lifecycleSink !== undefined ? { lifecycleSink: input.lifecycleSink } : {}),
    ...(input.restoreFrom !== undefined
      ? { restoreDomains: decodeObjectiveSnapshot(input.restoreFrom) }
      : {}),
  })

/** RFC-03 C4 — encode ONE domain criterion into its persisted DTO. `kind` is
 *  OMITTED for a plain manual criterion (byte-identical to the pre-C4
 *  `{ id, text, met }`); a CHECKED criterion carries its immutable `check`;
 *  `completion` evidence (with its generation binding) rides along when present. */
const encodeCriterion = (c: SuccessCriterion): PersistedObjectiveCriterion => {
  const completion: PersistedObjectiveCompletion | undefined =
    c.completion === undefined
      ? undefined
      : c.completion.source === "verifier"
        ? {
            source: "verifier",
            objectiveId: c.completion.objectiveId,
            checkId: c.completion.checkId,
            objectiveRevision: c.completion.objectiveRevision,
            sourceDigest: c.completion.sourceDigest,
            executionPosture: c.completion.executionPosture,
            verifierResult: {
              exitCode: c.completion.verifierResult.exitCode,
              passed: c.completion.verifierResult.passed,
            },
            verifiedAt: c.completion.verifiedAt,
          }
        : {
            source: "manual",
            objectiveId: c.completion.objectiveId,
            actor: c.completion.actor,
            objectiveRevision: c.completion.objectiveRevision,
            verifiedAt: c.completion.verifiedAt,
          }
  if (c.kind === "checked") {
    return {
      id: c.id,
      text: c.text,
      met: c.met,
      kind: "checked",
      check: {
        id: c.check.id,
        kind: "command",
        argv: [...c.check.argv],
        cwdPolicy: "thread",
        timeoutMs: c.check.timeoutMs,
        successExitCodes: [...c.check.successExitCodes],
      },
      ...(completion !== undefined ? { completion } : {}),
    }
  }
  return {
    id: c.id,
    text: c.text,
    met: c.met,
    ...(completion !== undefined ? { completion } : {}),
  }
}

/** Encode ONE per-thread domain snapshot into its v2 envelope. A thread whose
 *  state is null with a positive revision is a TOMBSTONE; a null state at
 *  revision 0 was never an objective and is skipped. */
const encodeThread = (dom: ObjectiveDomainSnapshot): PersistedObjectiveThreadV2 | null => {
  if (dom.state === null) {
    return dom.revision > 0
      ? { threadId: dom.threadId, revision: dom.revision, objective: null }
      : null
  }
  const obj = dom.state.objective
  const body: PersistedObjectiveBodyV2 = {
    objectiveId: obj.objectiveId,
    createdBy: obj.createdBy,
    ...(obj.migrationSource !== undefined ? { migrationSource: obj.migrationSource } : {}),
    goal: obj.goal,
    successCriteria: obj.successCriteria.map(encodeCriterion),
    status: obj.status,
    explicitStatus: dom.state.explicitStatus,
    ...(dom.state.usageLimitedUntil !== undefined
      ? { usageLimitedUntil: dom.state.usageLimitedUntil }
      : {}),
    budget: {
      tokensUsed: obj.budget.tokensUsed,
      turnsUsed: obj.budget.turnsUsed,
      ...(obj.budget.maxTokens !== undefined ? { maxTokens: obj.budget.maxTokens } : {}),
      ...(obj.budget.maxTurns !== undefined ? { maxTurns: obj.budget.maxTurns } : {}),
    },
    blockers: obj.blockers.map((b) => ({
      id: b.id,
      ...(b.dependencyId !== undefined ? { dependencyId: b.dependencyId } : {}),
      reason: b.reason,
      waitingOn: b.waitingOn,
      since: b.since,
    })),
    ...(obj.blockerObservations.length > 0
      ? {
          blockerObservations: obj.blockerObservations.map((observation) => ({
            observationId: observation.observationId,
            dependencyId: observation.dependencyId,
            waitingOn: observation.waitingOn,
            occurrences: observation.occurrences.map((occurrence) => ({ ...occurrence })),
          })),
        }
      : {}),
    nextActions: [...obj.nextActions],
    attempts: {
      autonomousTurnsStarted: obj.attempts.autonomousTurnsStarted,
      ...(obj.attempts.started !== undefined ? { started: { ...obj.attempts.started } } : {}),
    },
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    ...(dom.progressReceipts !== undefined && dom.progressReceipts.length > 0
      ? { progressReceipts: dom.progressReceipts }
      : {}),
  }
  return { threadId: dom.threadId, revision: dom.revision, objective: body }
}

/**
 * ENCODE the live objective authority into the durable session DTO (v2): every
 * known thread's full state + its per-thread `revision` + provenance, and every
 * cleared thread's tombstone. The result is plain JSON — the session store
 * persists it as-is. The thread order is the authority's known-thread order
 * (deterministic: revision-map insertion order, then any live objective the
 * map does not yet know).
 */
export const encodeObjectiveSnapshot = (port: ObjectivePort): PersistedObjectiveSnapshotV2 => {
  const authority = asObjectiveAuthority(port)
  const threads: PersistedObjectiveThreadV2[] = []
  for (const threadId of authority.knownThreadIds()) {
    const encoded = encodeThread(authority.readDomain(threadId))
    if (encoded !== null) threads.push(encoded)
  }
  return { version: OBJECTIVE_SNAPSHOT_VERSION, threads }
}
