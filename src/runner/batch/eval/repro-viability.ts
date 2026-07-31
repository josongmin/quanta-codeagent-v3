/**
 * Spec step-5 — cheap fix-free POST-FIX VIABILITY review (OBSERVE-ONLY).
 *
 * After the repair phase captures a patch, ask the model a single structural
 * question: given the ACTUAL reproducing test source (`reproduce_issue.py` body,
 * threaded through `reproSources`), the problem statement, and the captured patch —
 * is this patch STRUCTURALLY capable of making the repro pass, or is it constructed
 * such that it can never pass ("nonviable")? This is a LABELLING pass only: the
 * verdict is attached to telemetry and NEVER alters the instance result or control
 * flow. The future reject-mode (skip the expensive re-grade for a nonviable patch)
 * is NOT wired here — see the schema `describe` + the driver comment.
 *
 * NO-HEURISTIC: there is no threshold / regex / keyword classification of the patch.
 * The verdict is the MODEL's; this module only (a) COMPOSES the three real inputs
 * into a prompt and (b) parses the model's single contract line into a typed verdict.
 *
 * OBSERVE-INVARIANT: the parser NEVER throws. Any off-spec / empty reply is the typed
 * 3rd state `unparseable` — an observation that the review was inconclusive, never an
 * exception that could reach the instance's control flow. Pure — no I/O, no clock.
 */

export type ReproViabilityVerdict = "viable" | "nonviable" | "unparseable"

export interface ReproViabilityReview {
  readonly verdict: ReproViabilityVerdict
  readonly reason?: string
}

/** The single contract line the model must reply with. */
const VERDICT_LINE = "VIABLE|<one-line reason>  (or)  NONVIABLE|<one-line reason>"

/**
 * Compose the classifier prompt from the THREE REAL inputs. The reproducing test
 * source bodies are quoted verbatim (this is what makes the classifier see the real
 * repro structure — it is deliberately NOT a boilerplate placement banner). Pure.
 */
export const buildReproViabilityPrompt = (
  problemStatement: string,
  reproSources: readonly string[],
  capturedPatch: string,
): string => {
  const sources = reproSources.map((s, i) => `### Reproducing test #${i + 1}\n${s}`).join("\n\n")
  return [
    "You are judging whether a candidate patch is STRUCTURALLY capable of making the",
    "reproducing test below pass. This is a fix-free viability check: decide whether the",
    "patch could POSSIBLY satisfy the test's assertions/imports, not whether it is the",
    "ideal fix. If the patch cannot possibly make the test pass (wrong symbol, missing",
    "the asserted behaviour, unrelated files only), it is NONVIABLE; otherwise VIABLE.",
    "",
    "## Reported issue",
    problemStatement,
    "",
    "## Reproducing test source (the exact test that must pass)",
    sources,
    "",
    "## Candidate patch (unified diff)",
    capturedPatch,
    "",
    `Reply with ONLY one line: ${VERDICT_LINE}`,
  ].join("\n")
}

/**
 * Parse the model's single contract line into a typed verdict. Recognised forms
 * (case-insensitive, leading verdict token): `VIABLE|reason` / `NONVIABLE|reason`
 * (the `|reason` tail is optional). Anything else ⇒ `unparseable`. NEVER throws.
 */
export const parseReproViabilityReply = (text: string): ReproViabilityReview => {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ""
  const [head, ...rest] = line.split("|")
  const token = head?.trim().toLowerCase() ?? ""
  const reason = rest.join("|").trim()
  const withReason = (verdict: ReproViabilityVerdict): ReproViabilityReview =>
    reason === "" ? { verdict } : { verdict, reason }
  // Match ONLY when the verdict token is the whole head (avoid "not viable" ⇒ viable).
  if (token === "viable") return withReason("viable")
  if (token === "nonviable") return withReason("nonviable")
  return { verdict: "unparseable" }
}
