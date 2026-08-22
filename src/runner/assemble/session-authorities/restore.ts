/**
 * RFC-03 C2 — objective persistence DECODE adapter (session JSON → authority
 * domain snapshots).
 *
 * `runner/assemble` is the Layer-2 composition seam: it MAY import BOTH the
 * `@/session` DTO (plain JSON data) and the `@/objective` domain types, so it is
 * the correct home for the pure data adapter that maps between them. The
 * `@/session` slice itself never imports `@/objective` (its `denyImports` forbid
 * it) — it only stores/loads the JSON DTO.
 *
 * This module is a PURE data adapter: no store construction, no behavior. It
 * decodes a persisted objective snapshot into the ordered per-thread
 * {@link ObjectiveDomainSnapshot}s the authority consumes at construction
 * (`ObjectiveAuthorityOptions.restoreDomains`). The order is the persisted
 * thread order — a DETERMINISTIC, fixed restore order.
 *
 * exactOptionalPropertyTypes: optional fields are OMITTED when absent.
 */

import type {
  Blocker,
  CompletionReceipt,
  Objective,
  ObjectiveActor,
  ObjectiveBudget,
  ObjectiveDomainSnapshot,
  ObjectiveStatus,
  ObjectiveThreadSnapshot,
  SuccessCriterion,
  WaitingOn,
} from "@/objective"
import { isObjectiveActor, normalizeCheckDeclaration } from "@/objective"
import type {
  PersistedObjectiveBlocker,
  PersistedObjectiveCompletion,
  PersistedObjectiveCriterion,
  PersistedObjectiveSnapshot,
  PersistedObjectiveThread,
} from "@/session"

const OBJECTIVE_STATUSES: ReadonlySet<string> = new Set<ObjectiveStatus>([
  "active",
  "paused",
  "usage_limited",
  "budget_limited",
  "completed",
  "blocked",
])

const WAITING_ON: ReadonlySet<string> = new Set<WaitingOn>([
  "user",
  "tool",
  "network",
  "child_agent",
])

/** Coerce a persisted status string into the closed `ObjectiveStatus` union.
 *  The derived status is RE-DERIVED by the store on restore (from explicit
 *  intent + criteria + blockers), so this is only the advisory projection value;
 *  an unknown string falls back to the explicit intent. */
const toStatus = (raw: string, explicit: ObjectiveStatus): ObjectiveStatus =>
  OBJECTIVE_STATUSES.has(raw) ? (raw as ObjectiveStatus) : explicit

const toWaitingOn = (raw: string): WaitingOn => (WAITING_ON.has(raw) ? (raw as WaitingOn) : "user")

/** RFC-03 C4 — decode a persisted completion receipt into the domain evidence
 *  union. The manual `actor` string is coerced to the closed `ObjectiveActor`
 *  (unknown ⇒ `system`); a malformed receipt is dropped upstream by the caller. */
const toCompletion = (raw: PersistedObjectiveCompletion): CompletionReceipt => {
  if (raw.source === "verifier") {
    return {
      source: "verifier",
      checkId: raw.checkId,
      objectiveRevision: raw.objectiveRevision,
      sourceDigest: raw.sourceDigest,
      verifierResult: { exitCode: raw.verifierResult.exitCode, passed: raw.verifierResult.passed },
      verifiedAt: raw.verifiedAt,
    }
  }
  const actor: ObjectiveActor = isObjectiveActor(raw.actor) ? raw.actor : "system"
  return {
    source: "manual",
    actor,
    objectiveRevision: raw.objectiveRevision,
    verifiedAt: raw.verifiedAt,
  }
}

/** RFC-03 C4 — decode a persisted criterion into the domain manual/checked union.
 *  A record with `kind:"checked"` + a check ⇒ checked (check id preserved verbatim
 *  so a verifier receipt keeps binding); anything else ⇒ manual (legacy migration).
 *  Completion evidence is carried only when it matches the arm. */
const toCriterion = (c: PersistedObjectiveCriterion): SuccessCriterion => {
  // A checked criterion needs a well-formed, id-bearing check; a malformed/absent
  // one downgrades to manual (fail-safe) rather than crashing the restore. In
  // production the persisted check is zod-validated, but `restoreFrom` is a public
  // seam so this mirrors the store's defensive `rebuildCheck`.
  const decl =
    c.kind === "checked" && c.check !== undefined ? normalizeCheckDeclaration(c.check) : null
  const checkId =
    c.check !== undefined && typeof c.check.id === "string" && c.check.id.length > 0
      ? c.check.id
      : null
  if (decl !== null && checkId !== null) {
    const completion =
      c.completion !== undefined && c.completion.source === "verifier"
        ? toCompletion(c.completion)
        : undefined
    return {
      kind: "checked",
      id: c.id,
      text: c.text,
      met: c.met,
      check: {
        id: checkId,
        kind: "command",
        argv: [...decl.argv],
        cwdPolicy: "thread",
        timeoutMs: decl.timeoutMs,
        successExitCodes: [...decl.successExitCodes],
      },
      ...(completion !== undefined && completion.source === "verifier" ? { completion } : {}),
    }
  }
  const completion =
    c.completion !== undefined && c.completion.source === "manual"
      ? toCompletion(c.completion)
      : undefined
  return {
    kind: "manual",
    id: c.id,
    text: c.text,
    met: c.met,
    ...(completion !== undefined && completion.source === "manual" ? { completion } : {}),
  }
}

const toBlocker = (b: PersistedObjectiveBlocker): Blocker => ({
  id: b.id,
  reason: b.reason,
  waitingOn: toWaitingOn(b.waitingOn),
  since: b.since,
})

/** Reconstruct the full public `Objective` from a persisted thread. Every field
 *  round-trips verbatim; ids are NEVER re-minted (they carry from the DTO). */
const toObjective = (t: PersistedObjectiveThread): Objective => {
  const budget: ObjectiveBudget = {
    tokensUsed: t.budget.tokensUsed,
    turnsUsed: t.budget.turnsUsed,
    ...(t.budget.maxTokens !== undefined ? { maxTokens: t.budget.maxTokens } : {}),
    ...(t.budget.maxTurns !== undefined ? { maxTurns: t.budget.maxTurns } : {}),
  }
  return {
    threadId: t.threadId,
    goal: t.goal,
    successCriteria: t.successCriteria.map(toCriterion),
    status: toStatus(t.status, t.explicitStatus),
    budget,
    blockers: t.blockers.map(toBlocker),
    nextActions: [...t.nextActions],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

/** Decode ONE persisted thread into a per-thread domain snapshot (state +
 *  revision) the authority restores verbatim. */
const toDomainSnapshot = (t: PersistedObjectiveThread): ObjectiveDomainSnapshot => {
  const state: ObjectiveThreadSnapshot = {
    objective: toObjective(t),
    explicitStatus: t.explicitStatus,
    ...(t.usageLimitedUntil !== undefined ? { usageLimitedUntil: t.usageLimitedUntil } : {}),
  }
  return { threadId: t.threadId, revision: t.revision, state }
}

/**
 * Decode a persisted objective snapshot into the ordered per-thread domain
 * snapshots the authority consumes at construction. Threads with an empty
 * `threadId` are dropped (never a live thread). The output order is the
 * persisted order — a fixed, deterministic restore order.
 */
export const decodeObjectiveSnapshot = (
  snapshot: PersistedObjectiveSnapshot,
): readonly ObjectiveDomainSnapshot[] =>
  snapshot.threads.filter((t) => t.threadId.length > 0).map(toDomainSnapshot)
