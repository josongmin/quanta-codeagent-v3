/**
 * GOAL-01 — objective identity.
 *
 * Every objective carries an AUTHORITY-issued `objectiveId` (a generation
 * identity: `create`/`replace` mint a fresh one; pause/resume/budget amendment
 * keep it). Evidence (manual/verifier/progress receipts) is bound to that id so
 * a receipt produced against an older generation can never attach to a newer
 * goal on the same thread.
 *
 * Legacy (v1) snapshots pre-date the id. They migrate ONCE to a deterministic
 * `legacy-v1:<sha256>` id over a versioned, LENGTH-DELIMITED canonical stream of
 * (schema marker, threadId, goal, createdAt) — raw concatenation is forbidden so
 * `("ab","c")` and `("a","bc")` can never collide.
 *
 * The domain also owns the goal-text ceiling (`MAX_GOAL_CHARS`); CLI, model tool,
 * web and migration all exercise this same limit.
 *
 * SLICE FENCE: node:crypto only.
 */

import { createHash, randomUUID } from "node:crypto"

export const MAX_GOAL_CHARS = 4000

export type ObjectiveIdFactory = () => string

export const defaultObjectiveIdFactory: ObjectiveIdFactory = () => randomUUID()

export const LEGACY_OBJECTIVE_ID_PREFIX = "legacy-v1:"

const LEGACY_SCHEMA_MARKER = "quanta-objective-legacy-v1"

/** Deterministic id for a pre-GOAL-01 objective record. */
export const legacyObjectiveId = (input: {
  readonly threadId: string
  readonly goal: string
  readonly createdAt: number
}): string => {
  const hash = createHash("sha256")
  const field = (name: string, value: string): void => {
    // `<name>:<byteLength>:<bytes>|` — the byte-length prefix is what makes the
    // stream canonical: no delimiter inside a value can shift a field boundary.
    hash.update(`${name}:${Buffer.byteLength(value, "utf8")}:`)
    hash.update(value)
    hash.update("|")
  }
  field("schema", LEGACY_SCHEMA_MARKER)
  field("threadId", input.threadId)
  field("goal", input.goal)
  field("createdAt", String(Number.isFinite(input.createdAt) ? Math.trunc(input.createdAt) : 0))
  return `${LEGACY_OBJECTIVE_ID_PREFIX}${hash.digest("hex")}`
}

/** The domain's goal-text normalization: a non-empty string of at most
 *  {@link MAX_GOAL_CHARS} characters passes verbatim; anything else is `null`.
 *  No trimming — the caller's bytes are the goal. */
export const normalizeGoalText = (goal: unknown): string | null =>
  typeof goal === "string" && goal.length > 0 && goal.length <= MAX_GOAL_CHARS ? goal : null

/** Bounded, non-empty objective id (a UUID or a legacy hash id). */
export const isObjectiveIdLike = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256
