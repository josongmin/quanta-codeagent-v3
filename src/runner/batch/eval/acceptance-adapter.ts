/**
 * jun-28 SOTA++ Phase-A — acceptance selector ADAPTER.
 *
 * Bridges the orchestrator's `RepairCandidateOutcome[]` to the acceptance world:
 * maps each candidate's cumulative patch into an AcceptanceCandidate, scores ONCE
 * via the injected oracles, rerank-selects, and maps the winner BACK to its
 * `RepairCandidateOutcome` (so the orchestrator can `.adopt()` it). The returned
 * function IS the `selectCandidates` port the driver injects behind the
 * `acceptance` opt-in — keeping the orchestrator fenced (it never runs the oracle).
 *
 * `acceptance-adapter` lives in the eval slice (NOT the fenced repair slice), so it
 * may import `repair/types` (RepairCandidateOutcome) and the acceptance orchestrator.
 * Pure-compositional: all I/O is in the injected oracles.
 */

import {
  type AcceptanceLlmRerank,
  type AcceptanceOracles,
  selectByAcceptance,
} from "./acceptance-select"
import { combinedFailureTailOf, type RepairCandidateOutcome } from "./repair/types"
import { redactReviewerEvidence } from "./reviewer-evidence-redact"

/** Default vote key: the trimmed raw patch (Agentless `deduplicate=off`). The
 *  driver may inject an AST-canonical normalizer for stronger dedup. */
const trimKey = (patch: string): string => patch.trim()

/** Byte bound on the redacted failure tail injected per candidate. Tail-first;
 *  generous enough to carry a pytest summary + the failing assertion, bounded so
 *  N candidates × this stays inside the prompt budget. */
const MAX_FAILURE_OUTPUT_CHARS = 1500
/** Byte bound on the redacted action trace. Smaller than the failure tail — the
 *  trace is `<tool> <target>` lines, so 800 chars carries ~the recent window. */
const MAX_ACTION_SUMMARY_CHARS = 800

/** Map a {@link RepairCandidateOutcome} to its (optional) reviewer evidence. The
 *  failure output AND the action trace are ALWAYS routed through
 *  {@link redactReviewerEvidence} here — the adapter is the sole minting point, so
 *  no raw validator tail / agent action can reach the selector prompt unredacted
 *  (no-leak by construction). Fields are OMITTED when empty so a candidate with no
 *  evidence stays byte-identical. */
const evidenceOf = (
  c: RepairCandidateOutcome,
): { verifyCmd?: string; failureOutput?: string; actionSummary?: string } => {
  const out: { verifyCmd?: string; failureOutput?: string; actionSummary?: string } = {}
  const cmd = c.run.lastVerifyCmd
  if (typeof cmd === "string" && cmd.trim() !== "") out.verifyCmd = cmd.trim()
  const rawTail = combinedFailureTailOf({
    ...(c.validator.failureEvidence !== undefined
      ? { failureEvidence: c.validator.failureEvidence }
      : {}),
    ...(c.validator.failTail !== undefined ? { failTail: c.validator.failTail } : {}),
  })
  const redacted = redactReviewerEvidence(rawTail, MAX_FAILURE_OUTPUT_CHARS)
  if (redacted !== "") out.failureOutput = redacted
  // Action trace → one line per action, then redacted+bounded through the SAME leaf.
  const trace = c.run.actionTrace
  if (trace !== undefined && trace.length > 0) {
    const summary = redactReviewerEvidence(trace.join("\n"), MAX_ACTION_SUMMARY_CHARS)
    if (summary !== "") out.actionSummary = summary
  }
  return out
}

/**
 * Build the `selectCandidates` port from acceptance oracles. The winner is chosen
 * by score-once + rerank (Agentless-faithful) over the candidates' cumulative
 * patches, then mapped back to the owning `RepairCandidateOutcome`.
 */
export const buildAcceptanceSelector = (
  oracles: AcceptanceOracles,
  normalizePatch: (patch: string) => string = trimKey,
  llmRerank?: AcceptanceLlmRerank,
): ((candidates: readonly RepairCandidateOutcome[]) => Promise<RepairCandidateOutcome>) => {
  return async (candidates) => {
    // The orchestrator guards `candidates.length > 0` before calling this port, so
    // an empty list is a contract violation — throw loudly rather than return a
    // cast-masked `undefined` that would NPE later at `winner.adopt()`.
    if (candidates.length === 0) {
      throw new Error("buildAcceptanceSelector: empty candidate list")
    }
    // Per-candidate execution evidence is ONLY consumed by the LLM soft-reranker
    // (renderCandidate); compute+redact it only when one is wired, so the
    // deterministic path pays nothing and stays byte-identical.
    const accCandidates = candidates.map((c) => ({
      patch: c.run.patch,
      patchKey: normalizePatch(c.run.patch),
      ...(c.locationFocus !== undefined ? { locationFocus: c.locationFocus } : {}),
      ...(llmRerank !== undefined ? evidenceOf(c) : {}),
    }))
    const { selected } = await selectByAcceptance(accCandidates, oracles, llmRerank)
    // Map the winning patch back to its outcome. Distinct candidates with the SAME
    // patch are equivalent (adopt re-applies the diff ⇒ identical tree; deterministic
    // validation ⇒ identical verdict), so the first match is correct. `selected.patch`
    // is always one of the inputs unless tier === "none" (all empty) ⇒ first candidate.
    const winner = candidates.find((c) => c.run.patch === selected.patch)
    return winner ?? (candidates[0] as RepairCandidateOutcome)
  }
}
