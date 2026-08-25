/**
 * GOAL-01 — objective provenance: WHO originates a mutation and where a persisted
 * objective came from.
 *
 * `ObjectiveActor` is bound by the CALLER/session — never read from model input
 * (RFC-03 §8 stop rule). `types.ts` and `mutations.ts` both import it from here so
 * neither has to import the other.
 *
 * SLICE FENCE: pure data, no imports.
 */

export type ObjectiveActor = "model" | "user" | "system" | "verifier" | "continuation"

export const OBJECTIVE_ACTORS = [
  "model",
  "user",
  "system",
  "verifier",
  "continuation",
] as const satisfies readonly ObjectiveActor[]

const ACTOR_SET: ReadonlySet<string> = new Set(OBJECTIVE_ACTORS)

/** Runtime membership predicate for the closed actor union. */
export const isObjectiveActor = (v: unknown): v is ObjectiveActor =>
  typeof v === "string" && ACTOR_SET.has(v)

/** Where a persisted objective was minted. Only legacy (pre-GOAL-01) snapshots
 *  carry a migration source; a v2-native objective omits the field. */
export type ObjectiveMigrationSource = "legacy-v1"
