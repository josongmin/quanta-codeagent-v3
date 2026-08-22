/**
 * T10 — shared `claim -> execute -> finalize` run-model invariants.
 *
 * Pure, dependency-free SSOT for the rules that BOTH the in-memory and SQLite
 * adapters must agree on so they stay byte-equal (L9 M8 parity). Living in one
 * file is deliberate: a "keep both copies in sync" comment is exactly what the
 * bugbash guardrails forbid (G5), so the rule lives once and both engines
 * import it.
 *
 *   - {@link advancedStatus} — the post-fire status of an automation given the
 *     fire outcome and whether a live future fire remains. This is the L9 H5
 *     fix: an errored row with a live future fire stays `scheduled` (retry);
 *     only a rule-exhausted error retires to `errored`.
 *   - {@link defaultRunIdAllocator} — collision-free run/inbox id allocation.
 *     A bare `${kind}-${id}-${firedAt}` collides under same-ms double-fire and
 *     (on SQLite, where the run id is a PRIMARY KEY) rolls back the whole
 *     transaction → the row never advances → it refires (L9 M8). A monotonic
 *     per-process nonce disambiguates the same-ms case.
 *   - {@link mintClaimToken} — opaque, monotonic, collision-free claim tokens.
 */

import type { EngineStatus } from "./port"

/**
 * Post-fire status. `hasFutureFire` is `nextRunAt !== null` (the rule still
 * yields a future instant). The single rule both engines obey:
 *
 *   | outcome  | hasFutureFire | status      |
 *   |----------|---------------|-------------|
 *   | fired    | true          | scheduled   |
 *   | fired    | false         | fired       |
 *   | errored  | true          | scheduled   |  ← H5: retry, don't die
 *   | errored  | false         | errored     |
 */
export const advancedStatus = (
  outcome: "fired" | "errored",
  hasFutureFire: boolean,
): EngineStatus => {
  if (hasFutureFire) return "scheduled"
  return outcome === "errored" ? "errored" : "fired"
}

/** Allocator shape both adapters accept (matches the legacy `idAllocator`
 *  signature plus a `seq` discriminator for same-ms disambiguation). */
export type RunIdAllocator = (
  kind: "run" | "inbox",
  automationId: string,
  firedAt: number,
  seq: number,
) => string

/** Collision-free default: append a monotonic per-process `seq` so two
 *  finalizations at the SAME `firedAt` ms produce DISTINCT ids. */
export const defaultRunIdAllocator: RunIdAllocator = (kind, automationId, firedAt, seq) =>
  `${kind}-${automationId}-${firedAt}-${seq}`

/** A monotonic sequence source. Each engine instance owns one so ids stay
 *  deterministic within a run yet collision-free across same-ms fires. */
export const makeSeq = (): (() => number) => {
  let n = 0
  return () => {
    n += 1
    return n
  }
}

/** Mint an opaque, collision-free claim token. `seq` (monotonic) guarantees
 *  uniqueness even when `claimedAt` ms collide. */
export const mintClaimToken = (automationId: string, claimedAt: number, seq: number): string =>
  `claim-${automationId}-${claimedAt}-${seq}`
