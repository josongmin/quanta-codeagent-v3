/**
 * `@/apps/terminal/best-of-n` — the PURE, FAIR best-of-N candidate selector for the terminal brain
 * (Lever #3, RFC `jul-2-terminal-bench-levers/04-best-of-n-fair-selection.md`).
 *
 * PURPOSE. Many residual Terminal-Bench tasks are VARIANCE tasks — the frontier solves them only
 * *sometimes* (pytorch-model-recovery ~66%, torch-tensor-parallelism ~12%, query-optimize ~11%). One
 * attempt leaves those wins on the table; running N independent attempts and picking the best catches
 * the variance. But TB scores the final container state ONCE against a HIDDEN verifier, so selection
 * MUST use a FAIR, agent-constructible signal — NEVER the hidden test. Cherry-picking the lucky run
 * by peeking at the grader is leaderboard-gaming (violates `no-answer-key-regex-heuristics`), NOT a
 * real score.
 *
 * THE FAIR SIGNAL (reuse, do NOT reinvent). The verify-gate (Lever #2, {@link ./verify-gate}) already
 * produces exactly the fair per-candidate acceptance signal we need: its `VerificationStamp`. That
 * stamp is derived by {@link inspectExerciseEvidence} — a conservative, fail-closed inspection of the
 * candidate's OWN recorded event stream that asks "did this run RUN AND OBSERVE its deliverable
 * end-to-end?" It reads ONLY the model's own `container_exec` / `pty_*` tool calls; it has NO path to
 * the hidden verifier / `tests/` directory / grader. `verify-guard`-style test-path invocations are
 * REJECTED by {@link isExerciseCommand} (a bare test-runner reading a hidden test is NOT counted as a
 * legitimate exercise of the produced deliverable — see the fail-closed contract there). We IMPORT
 * that classifier; we do not duplicate it.
 *
 * THE RANKING (no-leak, honest). Prefer, strictly:
 *   `verified-pass` > `unverifiable` > `verified-fail`
 * A candidate with a `verified-pass` stamp DEMONSTRATED (via its own observed reference-comparison /
 * run) a passing exercise; it beats one that could not confirm (`unverifiable`), which beats one that
 * observed a FAILING outcome (`verified-fail`). A candidate that carries no stamp at all (gate off for
 * that attempt) has NO fair signal ⇒ it ranks with `unverifiable` (honest: we cannot claim it passed).
 * Ties break by EVIDENCE STRENGTH: a stamp earned WITHOUT a bounded follow-up nudge (the exercise was
 * already present) is stronger than one earned only after the nudge; then by a re-derived exercise
 * count over the candidate's own events (more independent observed exercises = stronger self-evidence);
 * finally by attempt order (attempt-1 wins an exact tie — the R5 "never lower single-attempt" floor).
 *
 * R5 FLOOR (attempt-1 never dethroned by a weaker candidate). Attempt-1 is always a candidate; a later
 * candidate wins only if it is STRICTLY better on the fair signal (or strictly stronger on a tie-break).
 * An equal-signal later candidate does NOT displace attempt-1. So best-of-N cannot LOWER the
 * single-attempt outcome — it can only raise it when a later attempt strictly out-verifies attempt-1.
 *
 * PURE / LEAF. No model calls, no IO, no `process.*`, no clock. Input is the N candidate results (each
 * a `VerificationStamp` + optionally its captured `AgentEvent[]` for the tie-break); output is the
 * winning index + a fair rationale. Deterministic + unit-testable. NEVER touches a hidden test.
 */

import type { AgentEvent } from "@/stream"
import type { VerificationStamp, VerificationState } from "./verify-gate"
import { deriveVerificationState, inspectExerciseEvidence, isExerciseCommand } from "./verify-gate"

/** One candidate produced by an independent brain attempt. The `stamp` is the FAIR signal (produced
 *  by the verify-gate, {@link deriveVerificationState}); `events` is that attempt's captured stream,
 *  optionally supplied so the selector can re-derive a tie-break evidence count from the candidate's
 *  OWN tool calls. A candidate with NO stamp (gate off for that attempt) is treated as `unverifiable`
 *  — no fair signal, so we neither prefer nor over-reject it. */
export interface BestOfNCandidate {
  /** The fair verification signal for this attempt (verify-gate stamp). Absent ⇒ no signal. */
  readonly stamp?: VerificationStamp
  /** This attempt's captured event stream — read ONLY for the tie-break evidence count (its own tool
   *  calls). Optional: absent ⇒ tie-break falls through to attempt order. NEVER a hidden test. */
  readonly events?: readonly AgentEvent[]
}

/** The selection outcome: which candidate won, and WHY (a fair rationale naming only the candidate's
 *  own signal — never a hidden test). */
export interface BestOfNSelection {
  /** Index into the input candidates of the winner. Attempt-1 (index 0) on an exact tie (R5 floor). */
  readonly winnerIndex: number
  /** The winner's effective fair state (the value ranked on). */
  readonly winnerState: VerificationState
  /** Human-readable, no-leak rationale for reports / A-B analysis. */
  readonly rationale: string
}

/** Rank of a fair state: HIGHER wins. `verified-pass` (2) > `unverifiable` (1) > `verified-fail` (0).
 *  A missing stamp maps to `unverifiable` (no fair signal ⇒ honest middle, never a claimed pass). */
const STATE_RANK: Readonly<Record<VerificationState, number>> = {
  "verified-pass": 2,
  unverifiable: 1,
  "verified-fail": 0,
}

/** The effective fair state of a candidate: its stamp's state, or `unverifiable` when it has no stamp
 *  (no fair signal — we do NOT invent a pass). */
const effectiveState = (c: BestOfNCandidate): VerificationState => c.stamp?.state ?? "unverifiable"

/** Read a string-typed field off a tool_call's `input` object (e.g. `command` / `data`); undefined
 *  when absent or non-string. Local to keep {@link exerciseEvidenceCount} simple. */
const stringInputField = (input: unknown, field: string): string | undefined => {
  if (input === null || typeof input !== "object" || !(field in input)) return undefined
  const v = (input as Record<string, unknown>)[field]
  return typeof v === "string" ? v : undefined
}

/** Map of tool-call id → whether its paired result observed output (non-empty preview OR an exit
 *  code). Mirrors the verify-gate's `resultObservedOutput` contract. */
const observedResultIds = (events: readonly AgentEvent[]): Map<string, boolean> => {
  const observedById = new Map<string, boolean>()
  for (const ev of events) {
    if (ev.type !== "tool_result") continue
    observedById.set(
      ev.id,
      (typeof ev.preview === "string" && ev.preview.trim().length > 0) ||
        typeof ev.exitCode === "number",
    )
  }
  return observedById
}

/** True iff a single tool_call is an INDEPENDENT observed exercise: a `container_exec` running an
 *  exercise command whose result was observed, OR a `pty_write` typing an exercise command. Reuses the
 *  verify-gate's fail-closed {@link isExerciseCommand} (which REJECTS a bare hidden-test read). */
const isExerciseCall = (
  ev: Extract<AgentEvent, { type: "tool_call" }>,
  observedById: Map<string, boolean>,
): boolean => {
  if (ev.name === "container_exec") {
    const command = stringInputField(ev.input, "command")
    return command !== undefined && isExerciseCommand(command) && observedById.get(ev.id) === true
  }
  if (ev.name === "pty_write") {
    const data = stringInputField(ev.input, "data")
    return data !== undefined && isExerciseCommand(data)
  }
  return false
}

/**
 * Count the INDEPENDENT observed exercises in a candidate's OWN event stream — the tie-break evidence
 * strength. Reads ONLY the candidate's own tool calls (via {@link isExerciseCall}); it has no path to
 * the hidden verifier, so a candidate cannot inflate this count by reading a test. Fail-closed: no
 * events ⇒ 0.
 */
const exerciseEvidenceCount = (events: readonly AgentEvent[] | undefined): number => {
  if (events === undefined) return 0
  const observedById = observedResultIds(events)
  let count = 0
  for (const ev of events) {
    if (ev.type === "tool_call" && isExerciseCall(ev, observedById)) count += 1
  }
  return count
}

/** True iff candidate `b` should DISPLACE the current best `a`. STRICTLY-better only (R5 floor): an
 *  equal candidate never displaces the earlier one, so attempt-1 (index 0, evaluated first) can only be
 *  beaten by a strictly stronger later attempt. Order of comparison mirrors the doc:
 *    1. fair state rank (verified-pass > unverifiable > verified-fail)
 *    2. stamp earned WITHOUT a follow-up nudge (already-exercised) is stronger than after-nudge
 *    3. more independent observed exercises in the candidate's own stream
 *  Anything still equal ⇒ NOT a displacement (keep the earlier candidate). */
const strictlyBetter = (b: BestOfNCandidate, a: BestOfNCandidate): boolean => {
  const rb = STATE_RANK[effectiveState(b)]
  const ra = STATE_RANK[effectiveState(a)]
  if (rb !== ra) return rb > ra
  // A stamp is "clean" (stronger) when the exercise was present WITHOUT the bounded follow-up nudge.
  // `followUpFired === false` ⇒ clean; `true` ⇒ needed the nudge; `undefined` ⇒ unknown (treat as
  // needing it, the conservative choice — an unknown does not out-rank a proven clean one).
  const cleanB = b.stamp?.followUpFired === false
  const cleanA = a.stamp?.followUpFired === false
  if (cleanB !== cleanA) return cleanB && !cleanA
  const evB = exerciseEvidenceCount(b.events)
  const evA = exerciseEvidenceCount(a.events)
  if (evB !== evA) return evB > evA
  return false
}

/**
 * Pick the best candidate by the FAIR, no-leak ranking. Deterministic + pure. `candidates[0]` is
 * attempt-1 (the R5 floor). NEVER reads a hidden test — only the candidates' own verify-gate stamps
 * and (for the tie-break) their own recorded tool calls.
 *
 * @throws if given an empty candidate set (a best-of-N run always produces ≥1).
 */
export const selectBestCandidate = (candidates: readonly BestOfNCandidate[]): BestOfNSelection => {
  if (candidates.length === 0) throw new Error("selectBestCandidate: no candidates to select from")
  let bestIndex = 0
  for (let i = 1; i < candidates.length; i++) {
    const cand = candidates[i]
    const best = candidates[bestIndex]
    if (cand !== undefined && best !== undefined && strictlyBetter(cand, best)) bestIndex = i
  }
  const winner = candidates[bestIndex]
  if (winner === undefined) throw new Error("selectBestCandidate: winner index out of range")
  const winnerState = effectiveState(winner)
  const clean = winner.stamp?.followUpFired === false
  const rationale =
    `best-of-${candidates.length}: selected attempt #${bestIndex + 1} ` +
    `(fair signal: ${winnerState}${clean ? ", exercised without a follow-up nudge" : ""}` +
    `${winner.events !== undefined ? `, ${exerciseEvidenceCount(winner.events)} observed exercise(s)` : ""}` +
    `). Ranked on each candidate's own verify-gate signal only.`
  return { winnerIndex: bestIndex, winnerState, rationale }
}

/**
 * Derive a FAIR stamp for a candidate whose brain run did NOT itself run the verify-gate (knob off for
 * the inner attempt) but whose events were captured. Reuses {@link inspectExerciseEvidence} + the
 * final text to compute the SAME `unverifiable`/`verified-*` trichotomy the gate would — so best-of-N
 * can rank fairly even when the inner verify-gate was not engaged. PURE: no model call. Exported for
 * the runner to stamp its candidates uniformly. NEVER reads a hidden test.
 */
export const deriveCandidateStamp = (
  events: readonly AgentEvent[],
  finalText: string,
): VerificationStamp =>
  // The gate's own `deriveVerificationState` is the SSOT for the trichotomy (outcome regexes live
  // there) — we route through it over this candidate's own inspected evidence, never re-declaring it.
  deriveVerificationState(inspectExerciseEvidence(events), finalText)
