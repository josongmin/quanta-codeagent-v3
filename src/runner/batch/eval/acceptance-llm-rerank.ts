/**
 * Bridge: build an {@link AcceptanceLlmRerank} from the pure LLM-selection cores
 * (RFC jun-30 competitor-strategy absorption — SWE-agent ScoreRetryLoop /
 * ChooserRetryLoop).
 *
 * The acceptance ladder (acceptance-rerank.ts) picks a best-of-N winner from
 * EXECUTION signals. When the repro is weak/absent — our measured dominant failure
 * mode ("right file, wrong edit") — those signals can't discriminate the correct
 * edit. This bridge maps the ADMISSIBLE survivors to the pure selector's candidate
 * shape and asks the model to re-rank WITHIN that set:
 *   - CHOOSER  : show all admissible diffs → one best index.
 *   - REVIEWER : per-candidate rubric score → highest wins.
 *
 * Never-veto / fail-open are inherited from the pure cores: the model only ever
 * sees admissible candidates, and any null / parse-failure / throw returns null ⇒
 * the deterministic vote winner stands. Default-OFF (the driver passes this only
 * when a chooser/reviewer knob is set) ⇒ never invoked ⇒ byte-identical.
 */

import type { AcceptanceLlmRerank, AcceptanceScored } from "./acceptance-select"
import { patchFiles } from "./closure-diagnostics-io"
import {
  type AskFn,
  chooseBestCandidate,
  type LlmSelectCandidate,
  reviewBestCandidate,
} from "./llm-candidate-select"

export type LlmRerankMode = "chooser" | "reviewer"

/** Map one scored acceptance candidate to the pure selector's view. `id` IS the
 *  scored `index`, so the chosen id maps straight back to `scored[index]`. */
const toSelectCandidate = (c: AcceptanceScored): LlmSelectCandidate => ({
  id: c.index,
  patch: c.patch,
  touchedFiles: patchFiles(c.patch),
  reproPass: c.reproPass,
  regressionFailures: c.regressionFailures,
  ...(c.locationFocus !== undefined ? { locationFocus: c.locationFocus } : {}),
  ...(c.verifyCmd !== undefined ? { verifyCmd: c.verifyCmd } : {}),
  ...(c.failureOutput !== undefined ? { failureOutput: c.failureOutput } : {}),
  ...(c.actionSummary !== undefined ? { actionSummary: c.actionSummary } : {}),
})

/**
 * Build the soft-reranker. `ask` is the injected one-shot completion (driver wires
 * it to the LLM port; tests fake it). The returned port receives ONLY the
 * admissible survivors and returns the chosen `index` (or null ⇒ deterministic).
 */
export const buildAcceptanceLlmRerank = (
  mode: LlmRerankMode,
  problemStatement: string,
  ask: AskFn,
): AcceptanceLlmRerank => {
  const pick = mode === "reviewer" ? reviewBestCandidate : chooseBestCandidate
  return async (admissible) => {
    const cands = admissible.map(toSelectCandidate)
    return pick(cands, problemStatement, ask)
  }
}
