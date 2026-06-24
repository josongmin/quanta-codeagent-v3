/**
 * T2b — execution-free, deterministic PUBLIC spec-fidelity matcher.
 *
 * Gives the EXISTING `declaredExpected` selection veto
 * (`hard:declaredExpectedMatch=false` in selection-gates.ts) a public-input
 * source so it can legitimately fire in CLEAN mode. The reason `astropy-13033`
 * misses today is precise and on-record in code: `scoreWithAuthority` disables
 * the declared-expected gate in clean mode because its only authority source was
 * the answer-key matcher. This module supplies the missing CLEAN-LEGITIMATE
 * source.
 *
 * The ONLY input is an {@link IssueDeclaredExpected} carrying
 * `provenance: "public-issue-text"` — produced solely by
 * {@link extractIssueDeclaredExpected}, which reads public problem-statement
 * text exclusively. The port builder ASSERTS that provenance and refuses (no
 * port) on anything else, so an answer-key / test_patch / gold-derived invariant
 * can never reach the clean-mode veto (red-on-injection).
 *
 * Per-candidate verdict (execution-free, over the candidate's own patch text):
 *   true  — the candidate's added lines surface the declared literal V
 *           (consistent → ranking credit)
 *   false — the candidate introduces a COMPETING message/string literal while V
 *           is absent (it invents a different message shape → hard veto). This
 *           is the astropy-13033 failure shape: self-generated repro passes but
 *           the emitted message contradicts the public spec.
 *   null  — abstain: insufficient execution-free signal (no veto, fail-open).
 *
 * Pure + deterministic: no I/O, no LLM, no clock/random.
 */

import {
  type IssueDeclaredExpected,
  PUBLIC_ISSUE_TEXT_PROVENANCE,
} from "@/agent/verification-plan/extract-issue-declared-expected"
import { stripInlineComment } from "./python-source-text"
import type { Candidate } from "./selection-types"

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim()

/** Abstain on candidate patches larger than this (hot per-candidate path; the
 *  veto is advisory so skipping a giant patch only forgoes an opportunistic check). */
const MAX_PATCH_SCAN_BYTES = 2 * 1024 * 1024

/** Added (`+`, not `+++`) source lines of a unified diff, prefix stripped. */
const addedLines = (patch: string): readonly string[] =>
  patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))

/** Every quoted-string-literal BODY on the given lines. The closing delimiter is
 *  a backreference to the opening one (`\1`), so a mismatched pair like `"x'`
 *  does NOT match — only a properly `"…"` / `'…'` / `` `…` `` delimited literal. */
const QUOTED = /(["'`])([^"'`\n]{1,400})\1/g
const quotedLiteralsOf = (lines: readonly string[]): readonly string[] => {
  const out: string[] = []
  for (const line of lines) {
    for (const m of line.matchAll(QUOTED)) if (m[2] !== undefined) out.push(m[2])
  }
  return out
}

/** A literal is "spec-bearing" (a message/output candidate, not an incidental
 *  identifier or dict key) when it contains whitespace OR is reasonably long.
 *  This keeps the veto from firing on short keys/attribute names. */
const isSpecBearing = (s: string): boolean => /\s/.test(s) || s.length >= 12

/** A dynamic-message template (f-string placeholder `{…}`, `%s`/`%d`/`%r`/`%(name)s`
 *  printf, or `str.format` field). The FINAL message is assembled at runtime, so an
 *  execution-free literal comparison against the declared value is unreliable —
 *  the matcher must ABSTAIN rather than veto on these (a correct dynamic fix would
 *  otherwise be false-vetoed → PASS→FAIL). */
const isFormatTemplate = (s: string): boolean => /\{[^}]*\}|%[sdrfgex]|%\(/.test(s)

/** Placeholder pattern used to SPLIT a format template into its fixed fragments.
 *  Broader than {@link isFormatTemplate}'s detector (it also consumes width/flag/
 *  precision specifiers and `%(name)s` mapping keys) so a fragment never retains a
 *  half-eaten conversion specifier. Only used AFTER a literal already qualified as a
 *  template, so the broader set cannot reclassify a non-template literal. */
const PLACEHOLDER_SPLIT_SOURCE = "\\{[^}]*\\}|%(?:\\([^)]*\\))?[#0\\- +]*\\d*(?:\\.\\d+)?[sdrfgex]"

/**
 * H1 dynamic-message-matcher — literal-SKELETON comparison for the abstain region.
 *
 * A dynamic-format competing literal (f-string / `%`-format / `str.format`) is split
 * into its FIXED fragments (the runtime-substituted placeholders are removed). Those
 * fragments are the parts the author HARD-CODED, so they are comparable to V
 * execution-free even though the assembled runtime string is not.
 *
 * Verdict for ONE template `s` against the declared value `v` (both normalized):
 *   "consistent" — every non-trivial fixed fragment of `s` appears in `v` IN ORDER
 *                  (non-overlapping). The template is just `v` with the variable bits
 *                  abstracted out → a correct dynamic fix → caller must NOT veto.
 *   "competing"  — `s` has at least one substantive fixed fragment, and the ordered
 *                  in-`v` match fails → the author hard-coded a DIFFERENT message
 *                  shape → caller may veto.
 *   "abstain"    — `s` carries no substantive fixed text (pure placeholder, or only
 *                  trivial punctuation/spacing around the holes) → undecidable.
 *
 * A fixed fragment is "substantive" when, after trimming, it has whitespace OR is
 * reasonably long — the SAME spec-bearing bar used for whole literals. This keeps a
 * stray `": "` separator fragment from forcing a verdict.
 */
const SUBSTANTIVE_FRAGMENT_MIN_LEN = 6
const fixedFragmentsOf = (template: string): readonly string[] => {
  const raw = template.split(new RegExp(PLACEHOLDER_SPLIT_SOURCE))
  return raw
    .map((f) => normalize(f))
    .filter((f) => f.length > 0 && (/\s/.test(f) || f.length >= SUBSTANTIVE_FRAGMENT_MIN_LEN))
}

/** Are `fragments` present in `v` as ordered, non-overlapping substrings? */
const fragmentsInOrder = (fragments: readonly string[], v: string): boolean => {
  let cursor = 0
  for (const f of fragments) {
    const at = v.indexOf(f, cursor)
    if (at < 0) return false
    cursor = at + f.length
  }
  return true
}

type SkeletonVerdict = "consistent" | "competing" | "abstain"
const classifyTemplateSkeleton = (template: string, v: string): SkeletonVerdict => {
  const fragments = fixedFragmentsOf(template)
  if (fragments.length === 0) return "abstain"
  return fragmentsInOrder(fragments, v) ? "consistent" : "competing"
}

/** Knobbed behavior toggles for the matcher (all default-OFF ⇒ byte-identical). */
export interface DeclaredExpectedMatchOptions {
  /** H1 dynamic-message-matcher (jun-24). When ON, a competing literal that is a
   *  dynamic format template is no longer a blanket abstain: its FIXED skeleton is
   *  compared against the declared value. A skeleton that does NOT match V's
   *  structure is treated as a competing wrong message (veto); a skeleton that DOES
   *  match V (the template is just V with the variable bits abstracted) still
   *  abstains so a correct dynamic fix is never false-vetoed. Default-OFF ⇒ every
   *  template literal abstains exactly as before. */
  readonly dynamicSkeleton?: boolean
}

export const matchCandidateAgainstDeclaredExpected = (
  patch: string,
  expected: IssueDeclaredExpected,
  options: DeclaredExpectedMatchOptions = {},
): boolean | null => {
  // Execution-free contradiction for an empty-output declaration is unreliable
  // (absence of a print is not visible as a competing literal). Abstain.
  if (expected.kind === "stdout-empty") return null
  const v = normalize(expected.value)
  if (v === "") return null
  // Candidate patches are LLM/agent-generated and unbounded in size; this matcher
  // runs per-candidate on the hot selection path. Abstain on a pathologically large
  // patch rather than scan every added line + run `matchAll` over megabytes — the
  // signal is advisory (a missed veto only loses an opportunistic check, never a
  // correctness gate).
  if (patch.length > MAX_PATCH_SCAN_BYTES) return null

  // Strip Python comments (whole-line AND inline-trailing) before any literal
  // mining so a stale message in a comment cannot register as consistent OR as a
  // competing contradiction (the latter is a fail-CLOSED false veto).
  const added = addedLines(patch)
    .map(stripInlineComment)
    .filter((l) => l.trim() !== "")
  if (added.length === 0) return null

  // Consistent: the declared literal is surfaced verbatim in an added line.
  if (normalize(added.join("\n")).includes(v)) return true

  // Contradiction: the candidate introduces spec-bearing quoted literals, none
  // of which carries V (in either direction) — it invents a different message
  // shape. Only then do we veto.
  const competing = quotedLiteralsOf(added)
    .map(normalize)
    .filter((s) => s.length > 0 && isSpecBearing(s))
  // Dynamic-message templates are assembled at runtime; a literal comparison
  // cannot prove contradiction. If the ONLY competing literals are templates,
  // the legacy matcher abstains (the false-veto pole the audit flagged).
  const concrete = competing.filter((s) => !isFormatTemplate(s))
  const templates = competing.filter((s) => isFormatTemplate(s))

  // H1 dynamic-message-matcher (default-OFF): try to DECIDE the template-only
  // case via fixed-skeleton comparison instead of blanket-abstaining.
  //  - any template whose skeleton is CONSISTENT with V ⇒ a correct dynamic fix
  //    is plausibly present ⇒ abstain (never veto, even if other templates look
  //    competing — we cannot prove the candidate is wrong).
  //  - else, if at least one template is COMPETING (substantive fixed text that
  //    does not align with V's structure) and NONE is consistent ⇒ veto.
  //  - else (only pure-placeholder / non-substantive templates) ⇒ abstain.
  if (options.dynamicSkeleton === true && concrete.length === 0 && templates.length > 0) {
    const verdicts = templates.map((t) => classifyTemplateSkeleton(t, v))
    if (verdicts.includes("consistent")) return null
    if (verdicts.includes("competing")) return false
    return null
  }

  if (competing.length > 0 && concrete.length === 0) return null
  if (concrete.length > 0 && !concrete.some((s) => s.includes(v) || v.includes(s))) {
    return false
  }

  // No spec-bearing literal was touched ⇒ cannot decide execution-free.
  return null
}

/**
 * Build the `declaredExpected` selection PORT from a public invariant.
 *
 * ANSWER-KEY GUARD (red-on-injection): returns `undefined` (no port, no veto)
 * unless `expected.provenance === "public-issue-text"`. The clean-mode veto is
 * therefore reachable ONLY from public-issue-text-derived invariants.
 */
export const buildPublicDeclaredExpectedPort = (
  expected: IssueDeclaredExpected | undefined,
  options: DeclaredExpectedMatchOptions = {},
): ((c: Candidate) => Promise<boolean | null>) | undefined => {
  if (expected === undefined) return undefined
  if (expected.provenance !== PUBLIC_ISSUE_TEXT_PROVENANCE) return undefined
  if (expected.value.trim() === "") return undefined
  return (c: Candidate) =>
    Promise.resolve(matchCandidateAgainstDeclaredExpected(c.patch, expected, options))
}
