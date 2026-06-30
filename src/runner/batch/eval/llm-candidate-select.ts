/**
 * LLM candidate selection (RFC jun-30 — competitor-strategy absorption).
 *
 * Our deterministic `rerankSelect` (acceptance-rerank.ts) picks a best-of-N winner from
 * EXECUTION signals (reproPass + regressionFailures + patch-text vote). When the repro is weak
 * or absent — our measured dominant failure mode ("right file, wrong edit"; the agent's proxy
 * test passes but the held-out test differs) — execution signals can't discriminate the right
 * edit. SWE-agent's ScoreRetryLoop (LLM reviewer-scores each patch) + ChooserRetryLoop (a strong
 * model is shown ALL candidates and emits the best index) close exactly that gap.
 *
 * This module is the PURE core (prompt build + response parse + fuse) behind an injected `ask`
 * seam, so it's fully unit-testable with no live LLM. Two modes:
 *   - CHOOSER  : show all candidate diffs → model returns ONE best index.
 *   - REVIEWER : per-candidate rubric score 0..1 → rank by score.
 *
 * INVARIANT (matches selection-finalize design note "soft-rerank / LLM-judge, NEVER hard-veto"):
 * the LLM only RE-RANKS within an ADMISSIBLE set the caller already filtered; it can never
 * resurrect an inadmissible candidate, and any parse failure FAILS OPEN to the caller's
 * deterministic winner. Default-OFF ⇒ never invoked ⇒ byte-identical.
 */

/** One candidate as the selector sees it (no full source — bounded diff + signals). */
export interface LlmSelectCandidate {
  /** Stable id used to refer to the candidate in the prompt + returned by parse. */
  readonly id: number
  /** Unified diff of the candidate patch. */
  readonly patch: string
  readonly touchedFiles: readonly string[]
  /** Execution signals already computed by the deterministic rail. */
  readonly reproPass: boolean
  readonly regressionFailures: number
  /** jun-30 SOTA++ per-candidate EXECUTION EVIDENCE (optional). The agent's last
   *  verification command — the exact command whose output discriminates a
   *  correct edit from a "right file, wrong edit". Absent ⇒ no command section. */
  readonly verifyCmd?: string
  /** REDACTED tail of the candidate's validator failure output (diff blocks +
   *  answer-key markers already stripped by {@link redactReviewerEvidence} at the
   *  adapter boundary — this leaf NEVER redacts, it only renders). Absent ⇒ no
   *  failure-output section. */
  readonly failureOutput?: string
  /** jun-30 SOTA++ REVIEWER TRAJECTORY (optional). The agent's bounded what-it-did
   *  action sequence (`<tool> <target>` lines, most-recent window), already redacted
   *  + bounded by {@link redactReviewerEvidence} at the adapter boundary — this leaf
   *  only renders. Lets the reviewer judge HOW the edit was reached (SWE-agent
   *  reviewer parity), not just the diff surface. Absent ⇒ no actions section. */
  readonly actionSummary?: string
}

/** Injected one-shot completion seam. Returns the model's raw text. The driver builds this from
 *  the turn LLM port; tests inject a fake. Kept as a plain fn so this leaf has NO @/llm coupling. */
export type AskFn = (prompt: string) => Promise<string>

const MAX_PATCH_CHARS = 6000

/** Conditional execution-evidence section. Emitted ONLY when the candidate
 *  carries a verify command and/or a (pre-redacted) failure tail — so a candidate
 *  with neither renders byte-identically to the pre-evidence prompt. The failure
 *  output is rendered VERBATIM: redaction is the adapter's responsibility (this
 *  leaf has no redactor) — the field is documented as already-redacted. */
const renderEvidence = (c: LlmSelectCandidate): readonly string[] => {
  const out: string[] = []
  if (typeof c.verifyCmd === "string" && c.verifyCmd.trim() !== "") {
    out.push(`verify_command: ${c.verifyCmd.trim()}`)
  }
  if (typeof c.failureOutput === "string" && c.failureOutput.trim() !== "") {
    out.push("failure_output (redacted, tail):", "```text", c.failureOutput, "```")
  }
  if (typeof c.actionSummary === "string" && c.actionSummary.trim() !== "") {
    out.push("agent_actions (redacted, recent):", "```text", c.actionSummary, "```")
  }
  return out
}

const renderCandidate = (c: LlmSelectCandidate): string =>
  [
    `### candidate ${c.id}`,
    `files: ${c.touchedFiles.join(", ") || "(none)"}`,
    `repro_pass: ${c.reproPass} | regression_failures: ${c.regressionFailures}`,
    ...renderEvidence(c),
    "```diff",
    c.patch.length > MAX_PATCH_CHARS ? `${c.patch.slice(0, MAX_PATCH_CHARS)}\n…(truncated)` : c.patch,
    "```",
  ].join("\n")

/** CHOOSER prompt — all candidates, model picks the single best index. */
export const buildChooserPrompt = (
  candidates: readonly LlmSelectCandidate[],
  problemStatement: string,
): string =>
  [
    "You are selecting the BEST patch that resolves the issue below. Judge correctness of the",
    "FIX (does it address the root cause described?), not just plausibility. Prefer the minimal",
    "edit that fully resolves the issue; distrust patches that edit unrelated code or tests.",
    "",
    "## Issue",
    problemStatement.slice(0, 4000),
    "",
    "## Candidates",
    candidates.map(renderCandidate).join("\n\n"),
    "",
    "Reply with EXACTLY one line: `BEST: <id>` where <id> is the chosen candidate number.",
  ].join("\n")

/** Parse `BEST: <id>` (tolerant: last integer that is a valid candidate id). Fail-open ⇒ null. */
export const parseChooserIndex = (
  text: string,
  validIds: ReadonlySet<number>,
): number | null => {
  const m = text.match(/BEST:\s*(\d+)/i)
  if (m !== null) {
    const id = Number.parseInt(m[1] as string, 10)
    if (validIds.has(id)) return id
  }
  // fallback: last standalone integer that is a valid id
  const nums = [...text.matchAll(/\b(\d+)\b/g)].map((x) => Number.parseInt(x[1] as string, 10))
  for (let i = nums.length - 1; i >= 0; i--) {
    const n = nums[i] as number
    if (validIds.has(n)) return n
  }
  return null
}

/** REVIEWER prompt — score ONE candidate 0..1 on resolving the issue. */
export const buildReviewerPrompt = (c: LlmSelectCandidate, problemStatement: string): string =>
  [
    "Score how well this patch RESOLVES the issue, 0.0 (wrong/irrelevant) to 1.0 (fully resolves",
    "the root cause with a minimal, correct edit). Penalize edits to unrelated code or test files.",
    "",
    "## Issue",
    problemStatement.slice(0, 4000),
    "",
    renderCandidate(c),
    "",
    "Reply with EXACTLY one line: `SCORE: <0..1>`.",
  ].join("\n")

/** Parse `SCORE: <float>` clamped to [0,1]. Fail-open ⇒ null. */
export const parseReviewerScore = (text: string): number | null => {
  const m = text.match(/SCORE:\s*([01](?:\.\d+)?|0?\.\d+)/i)
  if (m === null) return null
  const v = Number.parseFloat(m[1] as string)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
}

/**
 * CHOOSER: ask the model to pick the best among `admissible` candidates. Returns the chosen id
 * or null (fail-open: parse failure / ask throws / <2 candidates ⇒ caller keeps deterministic
 * winner). The caller MUST pass only ADMISSIBLE candidates (never-veto invariant).
 */
export const chooseBestCandidate = async (
  admissible: readonly LlmSelectCandidate[],
  problemStatement: string,
  ask: AskFn,
): Promise<number | null> => {
  if (admissible.length < 2) return null
  try {
    const text = await ask(buildChooserPrompt(admissible, problemStatement))
    return parseChooserIndex(text, new Set(admissible.map((c) => c.id)))
  } catch {
    return null
  }
}

/**
 * REVIEWER: score each admissible candidate; return the highest-scoring id (ties → lowest id for
 * determinism), or null if no candidate scored. Fail-open per-candidate (a failed score ⇒ that
 * candidate is skipped, not the whole selection).
 */
export const reviewBestCandidate = async (
  admissible: readonly LlmSelectCandidate[],
  problemStatement: string,
  ask: AskFn,
): Promise<number | null> => {
  if (admissible.length < 2) return null
  let bestId: number | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const c of admissible) {
    let score: number | null
    try {
      score = parseReviewerScore(await ask(buildReviewerPrompt(c, problemStatement)))
    } catch {
      score = null
    }
    if (score !== null && score > bestScore) {
      bestScore = score
      bestId = c.id
    }
  }
  return bestId
}
