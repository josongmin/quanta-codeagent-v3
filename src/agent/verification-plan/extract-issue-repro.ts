/**
 * Extract a reproduction snippet from a PUBLIC issue body (jun-18 closure
 * repro-install lever). Measured gap: on hard SWE-bench instances the LLM-
 * generated repro reaches `no_reproduced_candidate` (it runs but does not trigger
 * the bug), so the primary rail never fires (`primary_rail_present_rate` = 0/7 on
 * the oracle slice). Most issues, however, embed a Minimal Working Example — a
 * fenced `python` block that DOES reproduce. Extracting that and seeding the
 * repro pipeline with it (instead of generating from scratch) is the lever.
 *
 * Design — FAIL-CLOSED, precision over recall (same ethos as
 * extract-issue-declared-expected): return a snippet ONLY when a fenced code
 * block is confidently EXECUTABLE python (an `import` or a call) AND not merely a
 * quoted OUTPUT block. Anything ambiguous ⇒ `undefined` — a wrong repro is worse
 * than none (it would gate the rail on a script that does not reproduce).
 *
 * Pure + deterministic: no I/O, no LLM, no clock/random. The VALUE is the snippet
 * (it may become a runnable repro). It is a HEURISTIC guess, so it is consumed as
 * a SEED only — every executed call site routes through {@link
 * extractIssueReproSeed} and confers authority ONLY after a base-RED gate (the
 * source must reproduce the failure on the base tree). The regex's `hasCall` guess
 * can never become an executed primary oracle on its own; the AUTHORITATIVE repro
 * is produced by the LLM repro generator (`@/agent/repro-test/generate`) and
 * validated by base-red execution. Prefer fewer false "reproduced" over a wrong
 * block: anything ambiguous ⇒ `undefined`.
 */

import { normalizePublicIssueText } from "@/shared"

export interface IssueRepro {
  /** The extracted python source (verbatim from the fenced block, trimmed). */
  readonly code: string
}

/**
 * A repro SEED carries the extracted snippet plus an explicit provenance marker.
 *
 * T-SMK-04 — issue-smoke demotion. The extracted snippet is precision-first but
 * still only a HEURISTIC guess at the repro: it is the issue author's claimed
 * reproduction, NOT a script we have observed go red on the base tree and green
 * on a fix. So it is exposed as a `"repro-seed"` — auxiliary evidence that may
 * SEED repro generation/selection — never as validated repro authority. The
 * provenance tag exists so downstream telemetry can keep "extracted snippet"
 * distinct from "validated repro" (the latter being the only repro signal that
 * may decide admissibility, via repro consensus / quorum).
 */
export interface IssueReproSeed {
  /** The extracted python source (verbatim from the fenced block, trimmed). */
  readonly code: string
  /**
   * Provenance: this came from issue-text extraction, NOT from a validated
   * repro run. Literal-typed so a consumer cannot accidentally treat it as
   * validated-repro authority.
   */
  readonly provenance: "repro-seed"
}

/** Fenced code blocks: ```lang\n ... ``` (lang optional). CRLF-tolerant. */
const FENCE_RE = /```([a-zA-Z0-9]*)\r?\n([\s\S]*?)```/g

/** A block is EXECUTABLE python (a real MWE) when it imports or calls — not a
 *  bare value / prose. Excludes pure-output blocks (a single quoted string, or a
 *  `def _lambdifygenerated()` style generated-source dump). */
const hasImport = (s: string): boolean => /^\s*(?:import\s+\w|from\s+[\w.]+\s+import)\b/m.test(s)
const hasCall = (s: string): boolean => /\b[A-Za-z_][\w.]*\([^)]*\)/.test(s)

/** Looks like a QUOTED OUTPUT block (e.g. `'def _lambdifygenerated():\n ...'`) —
 *  the issue's "outputs:" example, NOT the repro. A block that is ENTIRELY one
 *  quoted string is an output, not executable input. */
const isQuotedOutput = (s: string): boolean => /^\s*['"][\s\S]*['"]\s*$/.test(s.trim())

/** Interactive-prompt line (doctest `>>>`/`...` OR IPython `In [n]:`/`   ...:`). */
const PROMPT_LINE = /^\s*(?:>>>|\.\.\.|In \[\d+\]:|\s*\.\.\.:|\s+\.\.\.:)/

const isExecutablePython = (lang: string, body: string): boolean => {
  const l = lang.toLowerCase()
  // Only python-ish fences (or unlabelled, judged by content). Reject shell/json/etc.
  if (l !== "" && !["python", "py", "python3", "pycon", "ipython", "py3"].includes(l)) return false
  if (isQuotedOutput(body)) return false
  // pycon/doctest/ipython prompt lines are executable too.
  if (PROMPT_LINE.test(body)) return true
  return hasImport(body) || hasCall(body)
}

/** Strip interactive prompts (doctest `>>>`/`...`, IPython `In [n]:`/`...:`) so
 *  the body is a runnable script; the non-prompt lines are session OUTPUT and are
 *  dropped (only when the block IS a prompt session). */
const stripPrompts = (body: string): string => {
  if (!PROMPT_LINE.test(body)) return body.trim()
  return body
    .split(/\r?\n/)
    .filter((ln) => PROMPT_LINE.test(ln))
    .map((ln) => ln.replace(/^\s*(?:>>>|\.\.\.|In \[\d+\]:|\s*\.\.\.:)\s?/, ""))
    .join("\n")
    .trim()
}

/**
 * Returns the issue's reproduction snippet, or `undefined` when none is
 * confidently present. Precision-first: the FIRST executable python fence wins
 * (issues lead with the MWE, then show outputs); an unlabelled fence is admitted
 * only if its content is executable python.
 */
export const extractIssueRepro = (problemStatement: string | undefined): IssueRepro | undefined => {
  const normalized = normalizePublicIssueText(problemStatement)
  if (normalized === undefined || normalized.trim() === "") return undefined
  for (const m of normalized.matchAll(FENCE_RE)) {
    const lang = m[1] ?? ""
    const body = m[2] ?? ""
    if (isExecutablePython(lang, body)) {
      const code = stripPrompts(body)
      if (code.length > 0) return { code }
    }
  }
  return undefined
}

/**
 * Extract the issue's reproduction snippet as a repro SEED (T-SMK-04). Identical
 * precision-first extraction as {@link extractIssueRepro}, but the result is
 * tagged `provenance: "repro-seed"` so the snippet is consumed as auxiliary
 * evidence that may seed repro generation/selection — NOT as a standalone gate.
 *
 * The seed's only authority is to STEER repro generation toward a known-good
 * starting script. A false-positive extraction therefore cannot veto a patch:
 * the snippet only earns admissibility weight once it (or its descendants)
 * survive a real repro run and enter the validated repro set, where repro
 * consensus decides.
 */
export const extractIssueReproSeed = (
  problemStatement: string | undefined,
): IssueReproSeed | undefined => {
  const repro = extractIssueRepro(problemStatement)
  return repro === undefined ? undefined : { code: repro.code, provenance: "repro-seed" }
}
