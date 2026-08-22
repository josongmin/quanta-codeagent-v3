/**
 * RFC-03 C1 — the CLOSED objective mutation union.
 *
 * Every write to the objective domain is one of these typed variants. The
 * authority (`./authority`) is the ONLY writer and dispatches on `kind`; a
 * `Record<ObjectiveOperationKind, …>` dispatch table makes adding a variant to
 * this union without routing it a COMPILE error, and the two-way guard below
 * (mirroring the `src/tool/objective/index.ts` STATUS_ENUM pattern) makes the
 * runtime floor exact — so the mutation-completeness ratchet
 * (`tests/unit/objective/mutation-completeness.test.ts`) fires if any operation
 * stops flowing through the authority.
 *
 * SLICE FENCE: imports ONLY sibling `./types` + `./model`. Pure data.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { CriterionDeclaration, VerifierCompletionReceipt } from "./criteria/model"
import type { ObjectiveDomainSnapshot } from "./model"
import type { ObjectiveStatus, WaitingOn } from "./types"

export type { CriterionDeclaration } from "./criteria/model"

/**
 * WHO originated a mutation. Bound by the CALLER/session — NEVER read from model
 * input (RFC-03 §8 stop rule). `model` is the only actor whose completion and
 * set/replace are gated; `user`/`system`/`continuation` are trusted callers and
 * `verifier` is the sole actor permitted to complete a criterion.
 */
export type ObjectiveActor = "model" | "user" | "system" | "verifier" | "continuation"

export const OBJECTIVE_ACTORS = [
  "model",
  "user",
  "system",
  "verifier",
  "continuation",
] as const satisfies readonly ObjectiveActor[]

/** The closed mutation union. Each variant maps 1:1 to a `ObjectivePort`
 *  mutator (plus `restore`, the authority-owned exact undo). */
export type ObjectiveMutation =
  | {
      kind: "set"
      goal: string
      successCriteria?: readonly string[] | undefined
      /** RFC-03 C4 — rich criterion declarations (manual or checked). When
       *  present it is the criterion source (a checked declaration carries a
       *  `check`); `successCriteria` remains the string-only back-compat path. */
      criteria?: readonly CriterionDeclaration[] | undefined
      budget?: { maxTokens?: number | undefined; maxTurns?: number | undefined } | undefined
    }
  | { kind: "updateStatus"; status: ObjectiveStatus }
  | { kind: "addBlocker"; reason: string; waitingOn: WaitingOn }
  | { kind: "clearBlocker"; blockerId: string }
  | { kind: "setNextActions"; actions: readonly string[] }
  | { kind: "markCriterion"; criterionId: string; met: boolean }
  /** RFC-03 C4 — the VERIFIER-ONLY checked-criterion completion. Carries the
   *  full verifier receipt; the authority admits it ONLY for a `verifier` actor
   *  against a `checked` criterion whose `check.id` matches the receipt. No tool
   *  input schema maps to this kind (forgery stop-rule). */
  | { kind: "markCriterionVerified"; criterionId: string; receipt: VerifierCompletionReceipt }
  | { kind: "recordUsage"; tokens?: number | undefined; turns?: number | undefined }
  | { kind: "markUsageLimited"; untilEpochMs: number }
  | { kind: "restore"; snapshot: ObjectiveDomainSnapshot }

export type ObjectiveOperationKind = ObjectiveMutation["kind"]

/**
 * The exhaustive operation-kind floor. `satisfies` proves array ⊆ union; the
 * reverse assert below proves every union member appears (adding a variant
 * without listing it here fails compile). Non-zero floor pins the ratchet.
 */
export const OBJECTIVE_OPERATION_KINDS = [
  "set",
  "updateStatus",
  "addBlocker",
  "clearBlocker",
  "setNextActions",
  "markCriterion",
  "markCriterionVerified",
  "recordUsage",
  "markUsageLimited",
  "restore",
] as const satisfies readonly ObjectiveOperationKind[]

// Two-way drift guard: prove every union member is in the array above. Without
// it, a new variant could be added to the union and silently escape the floor.
type _AssertKind<T extends true> = T
export type _ObjectiveOperationKindDriftGuard = _AssertKind<
  ObjectiveOperationKind extends (typeof OBJECTIVE_OPERATION_KINDS)[number] ? true : false
>

const OPERATION_KIND_SET: ReadonlySet<string> = new Set(OBJECTIVE_OPERATION_KINDS)

/** Runtime membership predicate for the closed operation union. */
export const isObjectiveOperationKind = (v: unknown): v is ObjectiveOperationKind =>
  typeof v === "string" && OPERATION_KIND_SET.has(v)

const ACTOR_SET: ReadonlySet<string> = new Set(OBJECTIVE_ACTORS)

/** Runtime membership predicate for the closed actor union. */
export const isObjectiveActor = (v: unknown): v is ObjectiveActor =>
  typeof v === "string" && ACTOR_SET.has(v)
